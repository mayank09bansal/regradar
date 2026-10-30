"""Text utilities: tokenisation, TF-IDF similarity and parameter extraction.

Pure Python on purpose: the control mapper must be deterministic, explainable
and runnable without heavy ML dependencies.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from collections.abc import Iterable

# Includes modal verbs: they signal obligation strength, not subject matter, so they must
# not make two unrelated obligations look similar.
STOPWORDS = frozenset(
    """a an and are as at be been by each every for from has have in into is it its of on or
    such that the their them these this those to was were which with within shall must may
    should will would can could all any its also than then there per least including""".split()
)

# Spelled-out values that regulations commonly use, e.g. "seventy-two hours".
NUMBER_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
    "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "fifteen": 15, "twenty": 20,
    "twenty-four": 24, "thirty": 30, "forty-eight": 48, "seventy-two": 72, "ninety": 90,
}

# Occurrences per year, so a monthly control can be compared with a quarterly requirement.
FREQUENCIES: dict[str, float] = {
    "daily": 365, "weekly": 52, "monthly": 12, "quarterly": 4, "half-yearly": 2,
    "semi-annually": 2, "biannually": 2, "annually": 1, "annual": 1, "yearly": 1,
}

# Keeps hyphenated terms together; tokenize() also adds their individual parts.
_TOKEN_RE = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
# Splits only before a capital or "(", which avoids most breaks at abbreviations.
_SENTENCE_RE = re.compile(r"(?<=[.;!?])\s+(?=[A-Z(])")


def stem(token: str) -> str:
    """Tiny suffix stemmer, good enough to match plurals and verb forms."""
    for suffix in ("ations", "ation", "ments", "ment", "ings", "ing", "ies", "ed", "es", "s"):
        if token.endswith(suffix) and len(token) - len(suffix) >= 4:
            base = token[: -len(suffix)]
            return base + "y" if suffix == "ies" else base
    return token


def tokenize(text: str) -> list[str]:
    """Lowercase, split and stem text for matching, removing stopwords and one-letter tokens."""
    tokens: list[str] = []
    for raw in _TOKEN_RE.findall(text.lower()):
        parts = [raw] + (raw.split("-") if "-" in raw else [])
        for t in parts:
            if t in STOPWORDS or len(t) < 2:
                continue
            tokens.append(stem(t))
    return tokens


def normalise_ws(text: str) -> str:
    """Collapse every run of whitespace to one space and trim the ends."""
    return re.sub(r"\s+", " ", text).strip()


def split_sentences(text: str) -> list[str]:
    """Split text into sentences; semicolons count, as regulations chain duties with them."""
    text = normalise_ws(text)
    return [s.strip() for s in _SENTENCE_RE.split(text) if s.strip()]


class TfidfIndex:
    """Fit on a corpus of documents; cosine similarity between any two texts."""

    def __init__(self, corpus: Iterable[str]):
        """Compute inverse document frequencies with smoothing.

        The +1 terms avoid division by zero and keep terms found in every document
        above zero weight.
        """
        docs = [tokenize(d) for d in corpus]
        self.n_docs = max(len(docs), 1)
        df: Counter[str] = Counter()
        for toks in docs:
            df.update(set(toks))
        self.idf = {t: math.log((1 + self.n_docs) / (1 + c)) + 1.0 for t, c in df.items()}

    def vector(self, text: str) -> dict[str, float]:
        """Return a unit-length TF-IDF vector for ``text``.

        Term frequency is log-scaled so repeated words do not dominate. Words
        unseen during fitting get the highest IDF value.
        """
        tf = Counter(tokenize(text))
        if not tf:
            return {}
        vec = {t: (1 + math.log(c)) * self.idf.get(t, math.log(1 + self.n_docs) + 1.0) for t, c in tf.items()}
        norm = math.sqrt(sum(v * v for v in vec.values())) or 1.0
        return {t: v / norm for t, v in vec.items()}

    @staticmethod
    def cosine(a: dict[str, float], b: dict[str, float]) -> float:
        """Cosine similarity of two unit vectors, iterating over the smaller one for speed."""
        if len(a) > len(b):
            a, b = b, a
        return sum(v * b.get(t, 0.0) for t, v in a.items())


def keyword_overlap(text: str, keywords: Iterable[str]) -> float:
    """Fraction of keyword phrases whose stemmed tokens all appear in ``text``."""
    kws = [k for k in keywords if k.strip()]
    if not kws:
        return 0.0
    toks = set(tokenize(text))
    hits = sum(1 for k in kws if set(tokenize(k)) <= toks and tokenize(k))
    return hits / len(kws)


# ------------------------------------------------------------- parameter parsing
# Longest number word first, so "twenty-four" is not matched as "twenty".
_NUM = r"(\d+(?:\.\d+)?|" + "|".join(sorted(NUMBER_WORDS, key=len, reverse=True)) + r")"
_DURATION_RE = re.compile(_NUM + r"\s*(hours?|hrs?|days?|months?|years?)", re.IGNORECASE)
# Separates "retain for 180 days" (a retention period) from "report within 6 hours" (a deadline).
_RETENTION_HINT = re.compile(r"\b(retain|retained|retention|preserve|preserved|stored?|kept)\b", re.I)


def _to_number(token: str) -> float:
    """Convert a numeric or spelled-out token to a float."""
    token = token.lower()
    return float(NUMBER_WORDS[token]) if token in NUMBER_WORDS else float(token)


def extract_parameters(text: str) -> dict[str, float | str | None]:
    """Extract deadline/retention durations and review frequency from a sentence."""
    params: dict[str, float | str | None] = {
        "deadline_hours": None,
        "retention_days": None,
        "frequency": None,
        "frequency_per_year": None,
    }
    lowered = text.lower()
    for m in _DURATION_RE.finditer(text):
        value = _to_number(m.group(1))
        unit = m.group(2).lower()
        days = {"h": value / 24, "d": value, "m": value * 30, "y": value * 365}[unit[0]]
        if _RETENTION_HINT.search(text):
            params["retention_days"] = days
        else:
            params["deadline_hours"] = days * 24
    for word, per_year in sorted(FREQUENCIES.items(), key=lambda kv: len(kv[0]), reverse=True):
        if re.search(rf"\b{re.escape(word)}\b", lowered):
            params["frequency"] = word
            params["frequency_per_year"] = per_year
            break
    return params


# Order is significant: negated and stronger forms come first, because detect_modal
# returns the first match. "shall not" must be found before "shall".
MODALS: list[tuple[str, str]] = [
    (r"\bshall not\b", "mandatory"),
    (r"\bmust not\b", "mandatory"),
    (r"\bshall\b", "mandatory"),
    (r"\bmust\b", "mandatory"),
    (r"\b(is|are) required to\b", "mandatory"),
    (r"\b(is|are) mandated to\b", "mandatory"),
    (r"\bshould\b", "recommended"),
    (r"\b(is|are) encouraged to\b", "recommended"),
    (r"\bmay\b", "permissive"),
]


def detect_modal(sentence: str) -> tuple[str, str] | None:
    """Return (modal phrase, strength) for the strongest modal in the sentence."""
    lowered = sentence.lower()
    for pattern, strength in MODALS:
        m = re.search(pattern, lowered)
        if m:
            return m.group(0), strength
    return None


# Plain substring rules used for ownership and exposure scoring. A sentence can match several.
TOPIC_KEYWORDS: dict[str, tuple[str, ...]] = {
    "incident reporting": ("incident", "report", "notify", "breach"),
    "access control": ("authentication", "privileged", "access"),
    "vulnerability management": ("vulnerability", "penetration"),
    "logging": ("log", "logs"),
    "governance": ("board", "committee", "plan"),
    "vendor risk": ("vendor", "service provider", "outsourcing", "exit strategy", "concentration"),
    "data protection": ("personal data", "data principal", "consent", "erased", "child"),
    "resilience": ("crisis", "continuity", "drill"),
}


def detect_topics(text: str) -> list[str]:
    """Return every topic whose keywords appear in ``text``."""
    lowered = text.lower()
    return [topic for topic, words in TOPIC_KEYWORDS.items() if any(w in lowered for w in words)]
