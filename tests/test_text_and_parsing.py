"""Unit tests: text utilities, parameter extraction, clause splitting, JSON parsing, config."""

import pytest

from backend.config import Settings
from backend.llm.base import LLMResponseError, parse_json_object
from backend.retrieval.sources import split_into_clauses
from backend.retrieval.text import TfidfIndex, detect_modal, extract_parameters, keyword_overlap, split_sentences


@pytest.mark.parametrize(
    "sentence,strength",
    [
        ("Regulated entities shall report incidents.", "mandatory"),
        ("Entities must not store passwords in clear text.", "mandatory"),
        ("Banks are required to appoint a CISO.", "mandatory"),
        ("Entities should conduct drills.", "recommended"),
        ("Entities may establish a committee.", "permissive"),
    ],
)
def test_detect_modal(sentence, strength):
    assert detect_modal(sentence)[1] == strength


def test_detect_modal_none_for_background_text():
    assert detect_modal("This direction consolidates supervisory expectations.") is None


def test_extract_deadline_from_number_word():
    p = extract_parameters("Report incidents to the Reserve Bank within six hours of detection.")
    assert p["deadline_hours"] == 6
    assert p["retention_days"] is None


def test_extract_retention_and_frequency():
    p = extract_parameters("Logs shall be retained for a minimum period of 180 days.")
    assert p["retention_days"] == 180
    q = extract_parameters("Conduct penetration testing at least quarterly.")
    assert q["frequency"] == "quarterly" and q["frequency_per_year"] == 4


def test_split_sentences_and_clauses():
    assert len(split_sentences("First shall apply. Second may apply.")) == 2
    clauses = split_into_clauses("1.1 Entities shall do A.\n\n1.2 Entities may do B.\n\nUnnumbered text here.")
    assert [c.ref for c in clauses] == ["1.1", "1.2", "p1"]


def test_tfidf_similarity_prefers_related_text():
    idx = TfidfIndex(["multi-factor authentication privileged access", "backup restoration testing"])
    q = idx.vector("enforce multi-factor authentication for privileged access")
    assert idx.cosine(q, idx.vector("multi-factor authentication privileged access")) > idx.cosine(
        q, idx.vector("backup restoration testing")
    )
    assert keyword_overlap("enforce multi-factor authentication", ["multi-factor authentication", "backup"]) == 0.5


@pytest.mark.parametrize(
    "text",
    [
        '{"a": 1}',
        'Sure! Here is the JSON:\n```json\n{"a": 1}\n```',
        'noise {"a": 1} trailing',
        '{"broken": } then {"a": 1}',
    ],
)
def test_parse_json_object_variants(text):
    assert parse_json_object(text)["a"] == 1


@pytest.mark.parametrize("text", ["", "no json here", "[1, 2, 3]"])
def test_parse_json_object_rejects_malformed(text):
    with pytest.raises(LLMResponseError):
        parse_json_object(text)


def test_public_config_never_contains_secrets():
    s = Settings(llm_provider="anthropic", llm_model="m", anthropic_api_key="sk-secret-123")
    public = s.public_dict()
    assert "sk-secret-123" not in str(public)
    assert public["anthropic_api_key_set"] is True
    assert s.live_llm_configured is True


def test_sqlite_url_resolution():
    assert Settings(database_url="sqlite:///:memory:").database_path is None
    assert Settings(database_url="sqlite:///./data/x.db").database_path.name == "x.db"
    with pytest.raises(ValueError):
        _ = Settings(database_url="postgresql://x").database_path
