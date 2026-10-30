"""Regulatory Scout tests: relevance scoring, feed ranking and live source handling (no real network access)."""

from __future__ import annotations

import threading
from dataclasses import replace

import pytest

from backend.agents import regulatory_scout
from backend.agents.base import AgentFailure
from backend.agents.regulatory_scout import MAX_LIVE_DOCS, RegulatoryScout, interest_terms, relevance, top_ranked
from backend.llm.demo import DemoLLM
from backend.orchestration.state import RunContext
from backend.retrieval.knowledge import load_control_library, load_demo_dataset
from backend.retrieval.sources import SourceError
from backend.retrieval.text import tokenize
from backend.schemas import Clause, RegulatoryDocument

from .conftest import ANALYSIS_DATE

RBI_URL = "https://example.org/rbi.xml"
SEBI_URL = "https://example.org/sebi.xml"
# Worst case for the concurrency tests: long enough never to fire when the code is right.
THREAD_TIMEOUT_SECONDS = 5


def _doc(doc_id: str, text: str, regulator: str = "RBI", title: str = "x") -> RegulatoryDocument:
    return RegulatoryDocument(
        id=doc_id, regulator=regulator, title=title, source="live-rss", clauses=[Clause(ref="1", text=text)],
    )


def _live_state(**request) -> dict:
    return {"request": {"mode": "live", "include_live_feeds": True, **request}, "trace": []}


@pytest.fixture
def ctx(settings):
    configured = replace(settings, rbi_rss_url=RBI_URL, sebi_rss_url=SEBI_URL, live_sources_enabled=True)
    return RunContext(run_id="test-run", settings=configured, llm=DemoLLM(), analysis_date=ANALYSIS_DATE)


@pytest.fixture
def feeds(monkeypatch):
    """Serve feeds from a dict of regulator to documents, or to an exception to raise."""
    served: dict[str, list[RegulatoryDocument] | Exception] = {}
    calls: list[str] = []

    def fake_fetch(regulator, url, timeout):
        calls.append(regulator)
        result = served.get(regulator, [])
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(regulatory_scout, "fetch_feed", fake_fetch)
    return served, calls


# ------------------------------------------------------------------ relevance
def test_interest_terms_cover_themes_and_control_keywords():
    terms = interest_terms()
    themes = load_demo_dataset()["organisation_profile"]["themes_of_interest"]
    keywords = [kw for c in load_control_library()["controls"] for kw in c.get("keywords", [])]
    assert terms == frozenset(t for phrase in [*themes, *keywords] for t in tokenize(phrase))


def test_relevance_is_the_share_of_matching_tokens():
    doc = _doc("A", "encryption audit banana", title="mango")
    assert relevance(doc, frozenset({"encryption"})) == 0.25


def test_relevance_rounds_to_three_decimals():
    doc = _doc("A", "encryption banana", title="mango")
    assert relevance(doc, frozenset({"encryption"})) == 0.333


def test_relevance_of_a_document_without_tokens_is_zero():
    assert relevance(_doc("A", "", title=""), frozenset({"encryption"})) == 0.0


def test_demo_scores_stay_fixed(ctx):
    update = RegulatoryScout(ctx)({"request": {"mode": "demo"}, "trace": []})
    assert [d["relevance_score"] for d in update["documents"]] == [0.458, 0.444, 0.385]


def test_a_zero_scoring_document_is_tokenized_only_once(ctx, feeds, monkeypatch):
    served, _ = feeds
    served["RBI"] = [_doc("A", "zzzz qqqq", title="wwww")]
    interest_terms()  # built first, so the count below is documents only
    tokenized: list[str] = []

    def counting_tokenize(text):
        tokenized.append(text)
        return tokenize(text)

    monkeypatch.setattr(regulatory_scout, "tokenize", counting_tokenize)
    update = RegulatoryScout(ctx)(_live_state())
    assert update["documents"][0]["relevance_score"] == 0.0
    assert len(tokenized) == 1


# ------------------------------------------------------------------ ranking
def test_top_ranked_orders_by_score_and_applies_the_limit():
    docs = [_doc(str(i), "x") for i in range(3)]
    for doc, score in zip(docs, (0.1, 0.9, 0.5), strict=True):
        doc.relevance_score = score
    assert [d.id for d in top_ranked(docs, 2)] == ["1", "2"]


def test_top_ranked_keeps_feed_order_for_ties():
    docs = [_doc(str(i), "x") for i in range(4)]
    assert [d.id for d in top_ranked(docs, 3)] == ["0", "1", "2"]


def test_feed_items_are_capped_to_the_most_relevant(ctx, feeds):
    served, _ = feeds
    weak = [_doc(f"WEAK-{i}", "zzzz qqqq wwww") for i in range(MAX_LIVE_DOCS)]
    strong = _doc("STRONG", "encryption incident report", title="cyber security")
    served["RBI"] = [*weak, strong]
    docs = RegulatoryScout(ctx)(_live_state())["documents"]
    assert len(docs) == MAX_LIVE_DOCS
    assert docs[0]["id"] == "STRONG"


def test_pasted_documents_come_first_and_are_not_capped(ctx, feeds):
    served, _ = feeds
    served["RBI"] = [_doc(f"LIVE-{i}", "encryption incident") for i in range(MAX_LIVE_DOCS + 2)]
    text = "1.1 Regulated entities shall encrypt customer card data at rest and in transit without exception."
    pasted = [{"title": f"Circular {i}", "regulator": "RBI", "text": text} for i in range(8)]
    docs = RegulatoryScout(ctx)(_live_state(documents=pasted))["documents"]
    assert [d["source"] for d in docs] == ["user-upload"] * 8 + ["live-rss"] * MAX_LIVE_DOCS


# ------------------------------------------------------------------ live sources
def test_feeds_outside_the_regulator_filter_are_not_fetched(ctx, feeds):
    _, calls = feeds
    RegulatoryScout(ctx)(_live_state(regulators=["SEBI"]))
    assert calls == ["SEBI"]


def test_a_filter_matching_no_feed_fetches_nothing(ctx, feeds):
    _, calls = feeds
    update = RegulatoryScout(ctx)(_live_state(regulators=["MEITY"]))
    assert calls == [] and update["documents"] == [] and update["source_errors"] == []


def test_disabled_live_sources_are_reported_without_fetching(ctx, feeds):
    _, calls = feeds
    disabled = RunContext(run_id="r", settings=replace(ctx.settings, live_sources_enabled=False), llm=DemoLLM(),
                          analysis_date=ANALYSIS_DATE)
    update = RegulatoryScout(disabled)(_live_state())
    assert calls == []
    assert update["source_errors"] == ["Live feeds requested but LIVE_SOURCES_ENABLED=false"]


def test_one_failed_feed_keeps_the_other(ctx, feeds):
    served, _ = feeds
    served["RBI"] = SourceError("rbi down")
    served["SEBI"] = [_doc("S", "encryption", regulator="SEBI")]
    update = RegulatoryScout(ctx)(_live_state())
    assert [d["id"] for d in update["documents"]] == ["S"]
    assert update["source_errors"] == ["rbi down"]
    result = update["trace"][-1]
    assert result["payload"]["sources_used"] == ["SEBI RSS (1 items)"]
    assert result["summary"] == "Retrieved 1 document(s) from SEBI RSS (1 items); 1 source error(s)"
    assert update["trace"][0]["summary"] == "Source unavailable: rbi down"


def test_no_source_is_stated_in_the_summary(ctx, feeds):
    update = RegulatoryScout(ctx)(_live_state(regulators=["MEITY"]))
    assert update["trace"][-1]["summary"] == "Retrieved 0 document(s) from no source"


def test_unexpected_feed_errors_fail_the_agent(ctx, feeds):
    served, _ = feeds
    served["SEBI"] = KeyError("bad parser state")
    with pytest.raises(AgentFailure):
        RegulatoryScout(ctx)(_live_state())


# ------------------------------------------------------------------ concurrency
def test_feeds_are_fetched_at_the_same_time(ctx, monkeypatch):
    # the barrier only opens with both feeds in flight, so sequential fetching would time out here
    both_started = threading.Barrier(2, timeout=THREAD_TIMEOUT_SECONDS)

    def fake_fetch(regulator, url, timeout):
        both_started.wait()
        return [_doc(regulator, "encryption", regulator=regulator)]

    monkeypatch.setattr(regulatory_scout, "fetch_feed", fake_fetch)
    update = RegulatoryScout(ctx)(_live_state())
    assert sorted(d["id"] for d in update["documents"]) == ["RBI", "SEBI"]


def test_results_follow_feed_order_when_the_second_feed_answers_first(ctx, monkeypatch):
    sebi_done = threading.Event()

    def fake_fetch(regulator, url, timeout):
        if regulator == "RBI":
            assert sebi_done.wait(THREAD_TIMEOUT_SECONDS)
            raise SourceError("rbi down")
        sebi_done.set()
        raise SourceError("sebi down")

    monkeypatch.setattr(regulatory_scout, "fetch_feed", fake_fetch)
    assert RegulatoryScout(ctx)(_live_state())["source_errors"] == ["rbi down", "sebi down"]


def test_equal_scores_rank_rbi_before_sebi_whichever_answers_first(ctx, monkeypatch):
    sebi_done = threading.Event()

    def fake_fetch(regulator, url, timeout):
        if regulator == "RBI":
            assert sebi_done.wait(THREAD_TIMEOUT_SECONDS)
        else:
            sebi_done.set()
        return [_doc(regulator, "encryption", regulator=regulator)]

    monkeypatch.setattr(regulatory_scout, "fetch_feed", fake_fetch)
    assert [d["id"] for d in RegulatoryScout(ctx)(_live_state())["documents"]] == ["RBI", "SEBI"]
