"""Regulatory source retrieval.

* Synthetic demo dataset (offline, deterministic, clearly labelled).
* User-supplied documents (pasted circular text) split into clauses.
* Live RSS feeds from RBI and SEBI (best effort; network failures are reported,
  never hidden, and never replaced silently with fake data).
"""

from __future__ import annotations

import html
import re
import ssl
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, datetime
from email.utils import parsedate_to_datetime
from hashlib import sha1

from backend.retrieval.knowledge import load_demo_dataset
from backend.retrieval.text import normalise_ws, split_sentences
from backend.schemas import Clause, InputDocument, RegulatoryDocument

# Identifies the client honestly; some government sites reject requests with no User-Agent.
USER_AGENT = "RegRadar/1.0 (academic project; +https://github.com/)"
# Items read from each feed before relevance ranking.
MAX_FEED_ITEMS = 15
# Read limit per HTTP response, so one oversized page cannot exhaust memory.
MAX_PAGE_BYTES = 1_500_000


class SourceError(RuntimeError):
    """A regulatory source could not be retrieved or parsed."""


def demo_documents(regulators: list[str] | None = None) -> list[RegulatoryDocument]:
    """Load the labelled synthetic documents, optionally filtered by regulator.

    Args:
        regulators: Upper-case regulator codes; None or empty keeps all documents.
    """
    data = load_demo_dataset()
    docs = []
    for d in data["documents"]:
        if regulators and d["regulator"].upper() not in regulators:
            continue
        docs.append(
            RegulatoryDocument(
                id=d["id"],
                regulator=d["regulator"],
                title=d["title"],
                issued=d.get("issued"),
                effective=d.get("effective"),
                url=d.get("url"),
                source="synthetic-demo",
                synthetic=True,
                themes=d.get("themes", []),
                clauses=[Clause(**c) for c in d["clauses"]],
            )
        )
    return docs


# Clause markers at the start of a paragraph: "3.1", "(2)", "4.", "(a)", "b)".
_NUMBERED = re.compile(r"^\s*(\(?[0-9]+(?:\.[0-9]+)*[.)]?|\([a-z]\)|[a-z]\))\s+", re.IGNORECASE)


def split_into_clauses(text: str) -> list[Clause]:
    """Split pasted regulation text into clauses.

    Numbered paragraphs ("3.1 ...", "(a) ...") keep their numbers; otherwise
    paragraphs are numbered sequentially and long paragraphs are split per sentence.
    """
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n|\r\n\s*\r\n", text) if p.strip()]
    if len(paragraphs) <= 1:
        paragraphs = [ln.strip() for ln in text.splitlines() if ln.strip()]
    clauses: list[Clause] = []
    counter = 0
    for para in paragraphs:
        m = _NUMBERED.match(para)
        body = normalise_ws(para[m.end():] if m else para)
        if not body:
            continue
        if m:
            clauses.append(Clause(ref=m.group(1).strip("()."), text=body))
            continue
        for sentence in split_sentences(body):
            counter += 1
            clauses.append(Clause(ref=f"p{counter}", text=sentence))
    return clauses


def user_documents(inputs: list[InputDocument]) -> list[RegulatoryDocument]:
    """Convert pasted input into documents.

    Without a ``reference_id``, the id combines position with a short hash of the
    text. The hash only labels the document; it has no security purpose.
    """
    docs = []
    for i, d in enumerate(inputs, start=1):
        digest = sha1(d.text.encode("utf-8")).hexdigest()[:6].upper()
        doc_id = d.reference_id or f"USER-{d.regulator}-{i}-{digest}"
        docs.append(
            RegulatoryDocument(
                id=doc_id,
                regulator=d.regulator,
                title=d.title,
                effective=d.effective_date,
                url=d.url,
                source="user-upload",
                synthetic=False,
                clauses=split_into_clauses(d.text),
            )
        )
    return docs


# ------------------------------------------------------------------ live feeds
def _http_get(url: str, timeout: int) -> bytes:
    """Fetch a URL with TLS verification, converting network failures to ``SourceError``."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:  # noqa: S310 - fixed https feeds
            return resp.read(MAX_PAGE_BYTES)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise SourceError(f"Could not fetch {url}: {exc}") from exc


def _strip_html(raw: str) -> str:
    """Reduce an HTML page to readable paragraphs.

    Lines of 30 characters or fewer are dropped, which removes most navigation
    links and menu labels from regulator pages.
    """
    raw = re.sub(r"(?is)<(script|style).*?</\1>", " ", raw)
    raw = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>|</tr>", "\n", raw)
    raw = re.sub(r"<[^>]+>", " ", raw)
    text = html.unescape(raw)
    lines = [normalise_ws(ln) for ln in text.splitlines()]
    return "\n\n".join(ln for ln in lines if len(ln) > 30)


def _parse_date(value: str | None) -> date | None:
    """Parse a feed date (RFC 2822 first, then common formats); None if unrecognised."""
    if not value:
        return None
    try:
        return parsedate_to_datetime(value).date()
    except (TypeError, ValueError):
        pass
    for fmt in ("%Y-%m-%d", "%d %b %Y", "%b %d, %Y"):
        try:
            return datetime.strptime(value.strip()[:20], fmt).date()
        except ValueError:
            continue
    return None


def parse_rss(xml_bytes: bytes, regulator: str, feed_url: str) -> list[RegulatoryDocument]:
    """Turn RSS XML into documents.

    Items without a title are skipped. Ids hash the title and link, so the same
    circular keeps its id between runs. The feed description is used as the body,
    falling back to the title.

    Raises:
        SourceError: If the bytes are not valid XML.
    """
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as exc:
        raise SourceError(f"{regulator} feed at {feed_url} is not valid RSS/XML: {exc}") from exc
    items = root.findall(".//item")[:MAX_FEED_ITEMS]
    docs = []
    for item in items:
        title = normalise_ws(item.findtext("title") or "")
        link = (item.findtext("link") or "").strip() or None
        desc = _strip_html(item.findtext("description") or "")
        if not title:
            continue
        digest = sha1((title + (link or "")).encode("utf-8")).hexdigest()[:8].upper()
        body = desc or title
        docs.append(
            RegulatoryDocument(
                id=f"{regulator}-LIVE-{digest}",
                regulator=regulator,
                title=title,
                issued=_parse_date(item.findtext("pubDate")),
                url=link,
                source="live-rss",
                synthetic=False,
                clauses=split_into_clauses(body) or [Clause(ref="p1", text=body)],
            )
        )
    return docs


def fetch_feed(regulator: str, feed_url: str, timeout: int, fetch_pages: bool = True) -> list[RegulatoryDocument]:
    """Download a feed and, where possible, upgrade items to the full page text.

    Only the first five items are fetched, to keep runs bounded. A page that fails
    to load keeps its feed summary instead of failing the whole source.

    Args:
        regulator: Code applied to the documents.
        feed_url: RSS location.
        timeout: Seconds per HTTP request.
        fetch_pages: Set False to use feed summaries only.
    """
    docs = parse_rss(_http_get(feed_url, timeout), regulator, feed_url)
    if fetch_pages:
        for doc in docs[:5]:  # keep live runs bounded
            if not doc.url:
                continue
            try:
                page_text = _strip_html(_http_get(doc.url, timeout).decode("utf-8", errors="replace"))
            except SourceError:
                continue  # summary from the feed is still usable
            clauses = split_into_clauses(page_text)
            if clauses:
                doc.clauses = clauses[:120]
    return docs
