"""Agent 1 - Regulatory Scout: retrieves and filters regulatory documents."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any

from backend.agents.base import Agent, MessageBuffer
from backend.config import Settings
from backend.retrieval.knowledge import load_control_library, load_demo_dataset
from backend.retrieval.sources import SourceError, demo_documents, fetch_feed, user_documents
from backend.retrieval.text import tokenize
from backend.schemas import AnalysisRequest, RegulatoryDocument

# Upper limit on RSS items per run: each document adds LLM calls, cost and latency.
MAX_LIVE_DOCS = 6


@lru_cache(maxsize=1)
def interest_terms() -> frozenset[str]:
    """Build the vocabulary for relevance: company themes plus control keywords.

    Cached for the same lifetime as the two datasets it is derived from, so a
    process tokenizes them once rather than once per run.
    """
    themes = load_demo_dataset()["organisation_profile"]["themes_of_interest"]
    keywords = (kw for control in load_control_library()["controls"] for kw in control.get("keywords", []))
    return frozenset(term for phrase in (*themes, *keywords) for term in tokenize(phrase))


def relevance(doc: RegulatoryDocument, terms: frozenset[str]) -> float:
    """Score a document as the share of its tokens in ``terms`` (0 to 1, 3 decimals)."""
    tokens = tokenize(doc.title + " " + " ".join(clause.text for clause in doc.clauses))
    if not tokens:
        return 0.0
    return round(sum(token in terms for token in tokens) / len(tokens), 3)


def score_documents(docs: list[RegulatoryDocument], terms: frozenset[str]) -> None:
    """Set ``relevance_score`` on each document in place."""
    for doc in docs:
        doc.relevance_score = relevance(doc, terms)


def top_ranked(docs: list[RegulatoryDocument], limit: int) -> list[RegulatoryDocument]:
    """Return the ``limit`` highest-scoring documents; ties keep their original order."""
    return sorted(docs, key=lambda doc: doc.relevance_score, reverse=True)[:limit]


@dataclass
class Retrieval:
    """Everything gathered from sources, before scoring decides what enters the run."""

    # Enter the run unconditionally: the demo dataset and pasted documents.
    documents: list[RegulatoryDocument] = field(default_factory=list)
    # RSS items, which still have to compete for a place under MAX_LIVE_DOCS.
    feed_documents: list[RegulatoryDocument] = field(default_factory=list)
    sources_used: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


class RegulatoryScout(Agent):
    """Agent 1: decides which documents enter the run.

    Source failures are recorded as errors, never replaced with synthetic data,
    so a live run cannot quietly report on content it did not retrieve.
    """
    name = "regulatory_scout"
    display_name = "Regulatory Scout"
    role = "Retrieves regulatory documents (synthetic dataset, pasted circulars, RBI/SEBI RSS) and ranks relevance."

    def _feeds(self, request: AnalysisRequest, settings: Settings) -> list[tuple[str, str]]:
        """Return (regulator, url) for each feed in scope, in reporting order."""
        feeds = [("RBI", settings.rbi_rss_url), ("SEBI", settings.sebi_rss_url)]
        return [feed for feed in feeds if not request.regulators or feed[0] in request.regulators]

    def _read_feeds(self, request: AnalysisRequest, settings: Settings, found: Retrieval) -> None:
        """Download the feeds in scope into ``found``.

        Each feed is a different site and most of a live run's retrieval time is
        spent waiting on them, so they are fetched side by side. Results are read
        back in feed order, which keeps documents, sources and errors independent
        of whichever site answered first.
        """
        feeds = self._feeds(request, settings)
        if not feeds:
            return
        with ThreadPoolExecutor(max_workers=len(feeds)) as pool:
            downloads = [pool.submit(fetch_feed, regulator, url, settings.source_timeout_seconds) for regulator, url in feeds]
        for (regulator, _), download in zip(feeds, downloads, strict=True):
            try:
                fetched = download.result()
            except SourceError as exc:
                found.errors.append(str(exc))
                continue
            found.feed_documents.extend(fetched)
            found.sources_used.append(f"{regulator} RSS ({len(fetched)} items)")

    def _read_live_sources(self, request: AnalysisRequest, settings: Settings, found: Retrieval) -> None:
        """Gather pasted documents, then RSS items when they were requested and allowed."""
        if request.documents:
            found.documents.extend(user_documents(request.documents))
            found.sources_used.append(f"{len(request.documents)} pasted document(s)")
        if not request.include_live_feeds:
            return
        if settings.live_sources_enabled:
            self._read_feeds(request, settings, found)
        else:
            found.errors.append("Live feeds requested but LIVE_SOURCES_ENABLED=false")

    def _retrieve(self, request: AnalysisRequest, settings: Settings) -> Retrieval:
        """Gather candidate documents for the requested mode."""
        found = Retrieval()
        if request.mode == "demo":
            found.documents = demo_documents(request.regulators or None)
            found.sources_used.append("synthetic demo dataset (data/demo/regulations_synthetic.json)")
        else:
            self._read_live_sources(request, settings, found)
        return found

    def _select(self, found: Retrieval) -> list[RegulatoryDocument]:
        """Score every candidate once and return the documents entering the run.

        Feed items are ranked and capped because they arrive unfiltered; documents
        a user or the demo supplied always enter, ahead of the feed items.
        """
        terms = interest_terms()
        score_documents(found.documents, terms)
        score_documents(found.feed_documents, terms)
        return found.documents + top_ranked(found.feed_documents, MAX_LIVE_DOCS)

    def _report(self, docs: list[RegulatoryDocument], found: Retrieval, buf: MessageBuffer) -> None:
        """Emit source failures, then the summary that hands the documents to extraction."""
        for err in found.errors:
            buf.emit("orchestrator", "error", f"Source unavailable: {err}", {"error": err})
        summary = f"Retrieved {len(docs)} document(s) from {', '.join(found.sources_used) or 'no source'}"
        if found.errors:
            summary += f"; {len(found.errors)} source error(s)"
        buf.emit(
            "obligation_extractor",
            "result",
            summary,
            {
                "documents": [
                    {
                        "id": d.id,
                        "title": d.title,
                        "regulator": d.regulator,
                        "source": d.source,
                        "synthetic": d.synthetic,
                        "clauses": len(d.clauses),
                        "relevance": d.relevance_score,
                    }
                    for d in docs
                ],
                "sources_used": found.sources_used,
                "source_errors": found.errors,
            },
        )

    def run(self, state, buf: MessageBuffer) -> dict[str, Any]:
        """Gather documents for the requested mode and hand them to extraction.

        Demo mode reads the synthetic dataset. Live mode combines pasted documents
        with RSS items, which are ranked by relevance and capped at ``MAX_LIVE_DOCS``.

        Returns:
            State update with ``documents`` and ``source_errors``.
        """
        request = AnalysisRequest.model_validate(state["request"])
        found = self._retrieve(request, self.ctx.settings)
        docs = self._select(found)
        doc_dicts = [d.model_dump(mode="json") for d in docs]
        self._report(docs, found, buf)
        return {"documents": doc_dicts, "source_errors": found.errors}
