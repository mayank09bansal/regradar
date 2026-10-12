"""Agent 1 - Regulatory Scout: retrieves and filters regulatory documents."""

from __future__ import annotations

from typing import Any

from backend.agents.base import Agent, MessageBuffer
from backend.retrieval.knowledge import load_control_library, load_demo_dataset
from backend.retrieval.sources import SourceError, demo_documents, fetch_feed, user_documents
from backend.retrieval.text import tokenize
from backend.schemas import AnalysisRequest, RegulatoryDocument

# Upper limit on RSS items per run: each document adds LLM calls, cost and latency.
MAX_LIVE_DOCS = 6


class RegulatoryScout(Agent):
    """Agent 1: decides which documents enter the run.

    Source failures are recorded as errors, never replaced with synthetic data,
    so a live run cannot quietly report on content it did not retrieve.
    """
    name = "regulatory_scout"
    display_name = "Regulatory Scout"
    role = "Retrieves regulatory documents (synthetic dataset, pasted circulars, RBI/SEBI RSS) and ranks relevance."

    def _interest_terms(self) -> set[str]:
        """Build the vocabulary for relevance: company themes plus control keywords."""
        terms: set[str] = set()
        for theme in load_demo_dataset()["organisation_profile"]["themes_of_interest"]:
            terms.update(tokenize(theme))
        for control in load_control_library()["controls"]:
            for kw in control.get("keywords", []):
                terms.update(tokenize(kw))
        return terms

    def _relevance(self, doc: RegulatoryDocument, terms: set[str]) -> float:
        """Score a document as the share of its tokens in ``terms`` (0 to 1, 3 decimals)."""
        toks = tokenize(doc.title + " " + " ".join(c.text for c in doc.clauses))
        if not toks:
            return 0.0
        return round(sum(1 for t in toks if t in terms) / len(toks), 3)

    def run(self, state, buf: MessageBuffer) -> dict[str, Any]:
        """Gather documents for the requested mode and hand them to extraction.

        Demo mode reads the synthetic dataset. Live mode combines pasted documents
        with RSS items, which are ranked by relevance and capped at ``MAX_LIVE_DOCS``.

        Returns:
            State update with ``documents`` and ``source_errors``.
        """
        request = AnalysisRequest.model_validate(state["request"])
        settings = self.ctx.settings
        docs: list[RegulatoryDocument] = []
        errors: list[str] = []
        sources_used: list[str] = []

        if request.mode == "demo":
            docs = demo_documents(request.regulators or None)
            sources_used.append("synthetic demo dataset (data/demo/regulations_synthetic.json)")
        else:
            if request.documents:
                docs.extend(user_documents(request.documents))
                sources_used.append(f"{len(request.documents)} pasted document(s)")
            if request.include_live_feeds:
                if not settings.live_sources_enabled:
                    errors.append("Live feeds requested but LIVE_SOURCES_ENABLED=false")
                else:
                    feeds = [("RBI", settings.rbi_rss_url), ("SEBI", settings.sebi_rss_url)]
                    live_docs: list[RegulatoryDocument] = []
                    for regulator, url in feeds:
                        if request.regulators and regulator not in request.regulators:
                            continue
                        try:
                            fetched = fetch_feed(regulator, url, settings.source_timeout_seconds)
                            live_docs.extend(fetched)
                            sources_used.append(f"{regulator} RSS ({len(fetched)} items)")
                        except SourceError as exc:
                            errors.append(str(exc))
                    terms = self._interest_terms()
                    for d in live_docs:
                        d.relevance_score = self._relevance(d, terms)
                    live_docs.sort(key=lambda d: d.relevance_score, reverse=True)
                    docs.extend(live_docs[:MAX_LIVE_DOCS])

        terms = self._interest_terms()
        for d in docs:
            if not d.relevance_score:
                d.relevance_score = self._relevance(d, terms)

        for err in errors:
            buf.emit("orchestrator", "error", f"Source unavailable: {err}", {"error": err})

        doc_dicts = [d.model_dump(mode="json") for d in docs]
        buf.emit(
            "obligation_extractor",
            "result",
            f"Retrieved {len(docs)} document(s) from {', '.join(sources_used) or 'no source'}"
            + (f"; {len(errors)} source error(s)" if errors else ""),
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
                "sources_used": sources_used,
                "source_errors": errors,
            },
        )
        return {"documents": doc_dicts, "source_errors": errors}
