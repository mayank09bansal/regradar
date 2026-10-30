"""Live LLM providers over plain HTTPS (stdlib only).

* ``anthropic`` - Anthropic Messages API.
* ``openai``   - any OpenAI-compatible Chat Completions endpoint (OpenAI, Groq,
  Google Gemini's OpenAI-compatible endpoint, OpenRouter, local Ollama, ...),
  selected with ``OPENAI_BASE_URL``.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any

from backend.config import LOCAL_LLM_URL_PREFIXES
from backend.llm.base import LLMAuthError, LLMError, LLMResponseError, LLMResult, parse_json_object

JSON_INSTRUCTION = (
    "Respond with a single JSON object only. No markdown, no prose outside the JSON."
)


class _HTTPClient:
    provider = "base"
    is_live = True

    def __init__(self, model: str, timeout: int, max_retries: int, temperature: float):
        if not model:
            raise LLMAuthError(f"LLM_MODEL must be set when LLM_PROVIDER={self.provider}")
        self.model = model
        self.timeout = timeout
        self.max_retries = max_retries
        self.temperature = temperature

    # subclasses implement these two
    def _request(self, system: str, prompt: str) -> tuple[str, dict[str, str], dict[str, Any]]:
        raise NotImplementedError

    def _extract_text(self, body: dict[str, Any]) -> str:
        raise NotImplementedError

    def _post(self, system: str, prompt: str) -> str:
        url, headers, body = self._request(system, prompt)
        headers = dict(headers)
        headers.setdefault("User-Agent", "RegRadar/1.0 (ComplianceEngine; +https://github.com/mayank09bansal/regradar)")
        headers.setdefault("Accept", "application/json")
        data = json.dumps(body).encode("utf-8")
        last_error: Exception | None = None
        for attempt in range(self.max_retries + 1):
            req = urllib.request.Request(url, data=data, headers=headers, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:  # noqa: S310 - configured provider URL
                    return self._extract_text(json.loads(resp.read().decode("utf-8")))
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")[:300]
                if exc.code in (401, 403):
                    raise LLMAuthError(
                        f"{self.provider} rejected the API key (HTTP {exc.code}). Check your .env. {detail}"
                    ) from exc
                if exc.code == 404:
                    raise LLMError(f"{self.provider} returned 404 - check LLM_MODEL/base URL. {detail}") from exc
                last_error = LLMError(f"{self.provider} HTTP {exc.code}: {detail}")
                if exc.code not in (408, 409, 429, 500, 502, 503, 504, 529):
                    raise last_error from exc
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                last_error = LLMError(f"{self.provider} unreachable or timed out: {exc}")
            except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
                raise LLMResponseError(f"Unexpected {self.provider} response shape: {exc}") from exc
            if attempt < self.max_retries:
                time.sleep(min(2**attempt, 8))
        raise last_error or LLMError("LLM request failed")

    def complete_json(self, task: str, system: str, prompt: str, payload: dict[str, Any]) -> LLMResult:
        text = self._post(f"{system}\n\n{JSON_INSTRUCTION}", prompt)
        attempts = 1
        try:
            data = parse_json_object(text)
        except LLMResponseError:
            # one repair attempt: ask the model to re-emit valid JSON
            attempts = 2
            repair = (
                "Your previous answer was not valid JSON. Re-emit the same answer as ONE valid JSON "
                f"object and nothing else.\n\nPrevious answer:\n{text[:6000]}"
            )
            text = self._post(f"{system}\n\n{JSON_INSTRUCTION}", repair)
            data = parse_json_object(text)
        return LLMResult(
            data=data,
            provider=self.provider,
            model=self.model,
            reasoning_source=f"llm:{self.provider}/{self.model}",
            raw_text=text,
            attempts=attempts,
        )


class AnthropicClient(_HTTPClient):
    provider = "anthropic"

    def __init__(self, api_key: str, base_url: str, **kw: Any):
        if not api_key:
            raise LLMAuthError("ANTHROPIC_API_KEY is not set")
        super().__init__(**kw)
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")

    def _request(self, system: str, prompt: str):
        return (
            f"{self.base_url}/v1/messages",
            {
                "x-api-key": self.api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            {
                "model": self.model,
                "max_tokens": 4096,
                "temperature": self.temperature,
                "system": system,
                "messages": [{"role": "user", "content": prompt}],
            },
        )

    def _extract_text(self, body: dict[str, Any]) -> str:
        return "".join(part.get("text", "") for part in body["content"] if part.get("type") == "text")


class OpenAICompatibleClient(_HTTPClient):
    provider = "openai"

    def __init__(self, api_key: str, base_url: str, **kw: Any):
        # Local servers (e.g. Ollama) need no key; a hosted one would reject every call.
        if not api_key and not base_url.startswith(LOCAL_LLM_URL_PREFIXES):
            raise LLMAuthError(f"OPENAI_API_KEY is not set for {base_url}")
        super().__init__(**kw)
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")

    def _request(self, system: str, prompt: str):
        headers = {"content-type": "application/json"}
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"
        return (
            f"{self.base_url}/chat/completions",
            headers,
            {
                "model": self.model,
                "temperature": self.temperature,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": prompt},
                ],
            },
        )

    def _extract_text(self, body: dict[str, Any]) -> str:
        choices = body.get("choices") or []
        if not choices:
            return ""
        choice = choices[0]
        msg = choice.get("message") or {}
        return msg.get("content") or msg.get("reasoning") or choice.get("text") or ""
