"""Choose the LLM client for a run."""

from __future__ import annotations

from backend.config import Settings
from backend.llm.base import LLMClient
from backend.llm.demo import DemoLLM
from backend.llm.providers import AnthropicClient, OpenAICompatibleClient


def get_llm_client(settings: Settings, mode: str) -> LLMClient:
    """Demo runs always use the deterministic responder; live runs use LLM_PROVIDER.

    Raises ``LLMAuthError`` if a live run is requested without valid configuration.
    """
    if mode == "demo" or settings.llm_provider == "demo":
        return DemoLLM()
    common = {
        "model": settings.effective_model,
        "timeout": settings.llm_timeout_seconds,
        "max_retries": settings.llm_max_retries,
        "temperature": settings.llm_temperature,
    }
    if settings.llm_provider == "anthropic":
        return AnthropicClient(api_key=settings.anthropic_api_key, base_url=settings.anthropic_base_url, **common)
    return OpenAICompatibleClient(api_key=settings.openai_api_key, base_url=settings.openai_base_url, **common)
