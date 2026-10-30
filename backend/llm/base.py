"""LLM client interface, errors and robust JSON parsing."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Protocol


class LLMError(RuntimeError):
    """Any failure talking to an LLM provider."""


class LLMAuthError(LLMError):
    """Missing or invalid credentials (not retried)."""


class LLMResponseError(LLMError):
    """The provider answered, but not with usable JSON."""


@dataclass
class LLMResult:
    """Parsed model output plus the provenance shown in the trace."""
    data: dict[str, Any]
    provider: str
    model: str
    reasoning_source: str  # "deterministic-demo" | "llm:<provider>/<model>"
    raw_text: str = ""
    attempts: int = 1
    meta: dict[str, Any] = field(default_factory=dict)


class LLMClient(Protocol):
    """Interface shared by the live providers and the demo responder.

    Agents depend only on this, so demo and live runs execute the same graph.
    ``is_live`` gates steps that are skipped without a real model.
    """
    provider: str
    model: str
    is_live: bool

    def complete_json(self, task: str, system: str, prompt: str, payload: dict[str, Any]) -> LLMResult:
        """Return a JSON object answering ``prompt``.

        ``payload`` is the structured context that was rendered into ``prompt``;
        live clients ignore it, the deterministic demo responder uses it.
        """
        ...


# Models often wrap JSON in Markdown code fences despite being asked not to.
_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)


def parse_json_object(text: str) -> dict[str, Any]:
    """Extract the first JSON object from model output (handles code fences and chatter)."""
    if not text or not text.strip():
        raise LLMResponseError("Empty response from model")
    candidates = [m.group(1) for m in _FENCE_RE.finditer(text)] + [text]
    for cand in candidates:
        cand = cand.strip()
        start = cand.find("{")
        while start != -1:
            depth = 0
            in_str = False
            esc = False
            for i in range(start, len(cand)):
                ch = cand[i]
                if in_str:
                    if esc:
                        esc = False
                    elif ch == "\\":
                        esc = True
                    elif ch == '"':
                        in_str = False
                    continue
                if ch == '"':
                    in_str = True
                elif ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        snippet = cand[start : i + 1]
                        try:
                            value = json.loads(snippet)
                        except json.JSONDecodeError:
                            break
                        if isinstance(value, dict):
                            return value
                        break
            start = cand.find("{", start + 1)
    raise LLMResponseError("Model response did not contain a valid JSON object")
