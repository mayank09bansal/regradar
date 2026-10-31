"""Regulatory source retrieval tests (no real network access)."""

from __future__ import annotations

import pytest

from backend.orchestration.runner import run_analysis
from backend.retrieval import sources
from backend.retrieval.sources import SourceError, parse_rss
from backend.schemas import AnalysisRequest

from .conftest import ANALYSIS_DATE

SAMPLE_RSS = b"""<?xml version="1.0"?>
<rss version="2.0"><channel><title>Notifications</title>
<item><title>Cyber Security Framework - amendment</title><link>https://example.org/n1</link>
<pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate>
<description>&lt;p&gt;Regulated entities shall report cyber incidents within six hours.&lt;/p&gt;</description></item>
<item><title>Holiday notice</title><link>https://example.org/n2</link><description>Offices remain closed.</description></item>
</channel></rss>"""


def test_parse_rss():
    docs = parse_rss(SAMPLE_RSS, "RBI", "https://example.org/feed")
    assert len(docs) == 2
    assert docs[0].source == "live-rss" and not docs[0].synthetic
    assert docs[0].issued.isoformat() == "2026-10-05"
    assert "six hours" in docs[0].clauses[0].text


def test_parse_rss_rejects_invalid_xml():
    with pytest.raises(SourceError):
        parse_rss(b"<html>not rss", "RBI", "u")


def test_live_run_with_mocked_feed(settings, db, monkeypatch):
    monkeypatch.setattr(sources, "_http_get", lambda url, timeout: SAMPLE_RSS if "feed" in url or "rss" in url else b"")
    detail = run_analysis(
        AnalysisRequest(mode="live", include_live_feeds=True, regulators=["RBI"], analysis_date=ANALYSIS_DATE),
        settings, db, llm=_demo_llm(),
    )
    assert detail["status"] == "completed", detail["error"]
    docs = detail["result"]["documents"]
    assert docs and all(d["source"] == "live-rss" for d in docs)
    assert any(o["parameters"].get("deadline_hours") == 6 for o in detail["result"]["obligations"])


def test_unavailable_source_is_reported_not_hidden(settings, db, monkeypatch):
    def boom(url, timeout):
        raise SourceError(f"Could not fetch {url}: simulated outage")

    monkeypatch.setattr(sources, "_http_get", boom)
    detail = run_analysis(
        AnalysisRequest(mode="live", include_live_feeds=True, analysis_date=ANALYSIS_DATE),
        settings, db, llm=_demo_llm(),
    )
    assert detail["status"] == "completed"
    assert len(detail["result"]["source_errors"]) == 2
    # no documents -> conditional edge skips straight to the Output Agent
    assert detail["result"]["route_history"] == ["regulatory_scout", "output_agent"]
    assert detail["stats"]["documents"] == 0 and detail["stats"]["source_errors"] == 2


def test_pasted_document_live_run(settings, db):
    text = (
        "5.1 Payment system operators shall encrypt customer card data at rest and in transit.\n\n"
        "5.2 Operators shall notify the regulator of any outage exceeding 30 minutes within 2 hours.\n\n"
        "5.3 Operators may publish an annual transparency report."
    )
    detail = run_analysis(
        AnalysisRequest(mode="live", documents=[{"title": "Test circular", "regulator": "npci", "text": text}],
                        analysis_date=ANALYSIS_DATE),
        settings, db, llm=_demo_llm(),
    )
    assert detail["status"] == "completed", detail["error"]
    obs = detail["result"]["obligations"]
    assert [o["clause_ref"] for o in obs] == ["5.1", "5.2", "5.3"]
    assert obs[0]["regulator"] == "NPCI"
    assert obs[1]["parameters"]["deadline_hours"] == 2


def _demo_llm():
    from backend.llm.demo import DemoLLM

    return DemoLLM()
