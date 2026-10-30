"""Application settings.

Settings are read from environment variables. A ``.env`` file in the project root
is loaded first (without overriding variables that are already set), so the app
works the same way from PowerShell, VS Code, Docker and the test suite.

No secret ever has a default value, and secrets are never included in ``public_dict``.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"

VALID_PROVIDERS = ("demo", "anthropic", "openai")
LOCAL_LLM_URL_PREFIXES = ("http://localhost", "http://127.0.0.1")  # OpenAI-compatible servers needing no key


def load_dotenv_file(path: Path) -> None:
    """Minimal .env loader: KEY=VALUE lines, # comments, optional quotes.

    Existing environment variables win, so real deployment settings are never
    overwritten by a stale local file.
    """
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export ") :]
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if value and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        if key and key not in os.environ:
            os.environ[key] = value


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _int(name: str, default: int, minimum: int | None = None, maximum: int | None = None) -> int:
    raw = os.environ.get(name, "").strip()
    try:
        value = int(raw) if raw else default
    except ValueError as exc:
        raise ValueError(f"Environment variable {name} must be an integer, got {raw!r}") from exc
    if minimum is not None and value < minimum:
        raise ValueError(f"{name} must be >= {minimum}")
    if maximum is not None and value > maximum:
        raise ValueError(f"{name} must be <= {maximum}")
    return value


def _float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    try:
        return float(raw) if raw else default
    except ValueError as exc:
        raise ValueError(f"Environment variable {name} must be a number, got {raw!r}") from exc


def _str(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


@dataclass(frozen=True)
class Settings:
    app_env: str = "development"
    log_level: str = "INFO"
    database_url: str = "sqlite:///./data/regradar.db"
    cors_origins: tuple[str, ...] = ("http://localhost:5173", "http://127.0.0.1:5173")

    llm_provider: str = "openai"
    llm_model: str = "openai/gpt-oss-120b"
    llm_temperature: float = 0.1
    llm_timeout_seconds: int = 60
    llm_max_retries: int = 2
    anthropic_api_key: str = field(default="", repr=False)
    anthropic_base_url: str = "https://api.anthropic.com"
    openai_api_key: str = field(default="", repr=False)
    openai_base_url: str = "https://api.groq.com/openai/v1"

    max_revisions: int = 2
    live_sources_enabled: bool = True
    source_timeout_seconds: int = 15
    rbi_rss_url: str = "https://www.rbi.org.in/notifications_rss.xml"
    sebi_rss_url: str = "https://www.sebi.gov.in/sebirss.xml"

    slack_webhook_url: str = field(default="", repr=False)
    n8n_webhook_url: str = field(default="", repr=False)

    # Deployment
    on_vercel: bool = False
    serve_frontend: bool = True          # serve frontend/dist from FastAPI when it exists
    frontend_dir: str = "frontend/dist"

    @property
    def is_postgres(self) -> bool:
        return self.database_url.startswith(("postgres://", "postgresql://"))

    @property
    def storage_persistent(self) -> bool:
        if self.is_postgres:
            return True
        path = self.database_path
        return path is not None and not (self.on_vercel and (path.as_posix().startswith("/tmp") or "/tmp" in self.database_url))

    @property
    def database_label(self) -> str:
        """Human-readable storage description without credentials."""
        if self.is_postgres:
            host = self.database_url.split("@", 1)[-1].split("/", 1)[0].split("?", 1)[0]
            return f"postgresql ({host})"
        path = self.database_path
        if path is None:
            return "sqlite (in-memory)"
        return f"sqlite ({path.name}{', temporary /tmp' if not self.storage_persistent else ''})"

    @property
    def frontend_path(self) -> Path:
        path = Path(self.frontend_dir)
        return path if path.is_absolute() else (PROJECT_ROOT / path).resolve()

    @property
    def database_path(self) -> Path | None:
        """Filesystem path for sqlite URLs; ``None`` means in-memory."""
        url = self.database_url
        if not url.startswith("sqlite:///"):
            raise ValueError(
                "DATABASE_URL must be sqlite:///<path> or postgresql://..., e.g. sqlite:///./data/regradar.db"
            )
        raw = url[len("sqlite:///") :]
        if raw in (":memory:", ""):
            return None
        path = Path(raw)
        if not path.is_absolute():
            path = (PROJECT_ROOT / path).resolve()
        return path

    @property
    def effective_model(self) -> str:
        if self.llm_model:
            return self.llm_model
        if self.llm_provider == "demo":
            return "deterministic-demo-responder"
        return ""

    @property
    def live_llm_configured(self) -> bool:
        if self.llm_provider == "anthropic":
            return bool(self.anthropic_api_key and self.effective_model)
        if self.llm_provider == "openai":
            local = self.openai_base_url.startswith(LOCAL_LLM_URL_PREFIXES)
            return bool((self.openai_api_key or local) and self.effective_model)
        return False

    def public_dict(self) -> dict:
        """Configuration safe to show in the dashboard. Never includes secrets."""
        return {
            "app_env": self.app_env,
            "llm_provider": self.llm_provider,
            "llm_model": self.effective_model,
            "live_llm_configured": self.live_llm_configured,
            "anthropic_api_key_set": bool(self.anthropic_api_key),
            "openai_api_key_set": bool(self.openai_api_key),
            "openai_base_url": self.openai_base_url,
            "max_revisions": self.max_revisions,
            "live_sources_enabled": self.live_sources_enabled,
            "rbi_rss_url": self.rbi_rss_url,
            "sebi_rss_url": self.sebi_rss_url,
            "slack_configured": bool(self.slack_webhook_url),
            "n8n_configured": bool(self.n8n_webhook_url),
            "cors_origins": list(self.cors_origins),
            "database": self.database_label,
            "storage_persistent": self.storage_persistent,
            "deployment": "vercel" if self.on_vercel else "local",
        }


def build_settings() -> Settings:
    load_dotenv_file(PROJECT_ROOT / ".env")
    provider = _str("LLM_PROVIDER", "openai").lower() or "openai"
    if provider not in VALID_PROVIDERS:
        raise ValueError(f"LLM_PROVIDER must be one of {VALID_PROVIDERS}, got {provider!r}")
    origins = tuple(
        o.strip().rstrip("/")
        for o in _str("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
        if o.strip()
    )
    on_vercel = bool(os.environ.get("VERCEL"))
    # Vercel's Neon/Postgres integrations may inject POSTGRES_URL instead of DATABASE_URL.
    database_url = _str("DATABASE_URL") or _str("POSTGRES_URL")
    if not database_url:
        # Vercel functions can only write to /tmp (temporary, per instance).
        database_url = "sqlite:////tmp/regradar.db" if on_vercel else "sqlite:///./data/regradar.db"
    return Settings(
        app_env=_str("APP_ENV", "production" if on_vercel else "development"),
        log_level=_str("LOG_LEVEL", "INFO").upper(),
        database_url=database_url,
        cors_origins=origins,
        llm_provider=provider,
        llm_model=_str("LLM_MODEL", "openai/gpt-oss-120b"),
        llm_temperature=_float("LLM_TEMPERATURE", 0.1),
        llm_timeout_seconds=_int("LLM_TIMEOUT_SECONDS", 60, 5, 600),
        llm_max_retries=_int("LLM_MAX_RETRIES", 2, 0, 5),
        anthropic_api_key=_str("ANTHROPIC_API_KEY"),
        anthropic_base_url=_str("ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/"),
        openai_api_key=_str("OPENAI_API_KEY"),
        openai_base_url=_str("OPENAI_BASE_URL", "https://api.groq.com/openai/v1").rstrip("/"),
        max_revisions=_int("MAX_REVISIONS", 2, 0, 5),
        live_sources_enabled=_bool("LIVE_SOURCES_ENABLED", True),
        source_timeout_seconds=_int("SOURCE_TIMEOUT_SECONDS", 15, 2, 120),
        rbi_rss_url=_str("RBI_RSS_URL", "https://www.rbi.org.in/notifications_rss.xml"),
        sebi_rss_url=_str("SEBI_RSS_URL", "https://www.sebi.gov.in/sebirss.xml"),
        slack_webhook_url=_str("SLACK_WEBHOOK_URL"),
        n8n_webhook_url=_str("N8N_WEBHOOK_URL"),
        on_vercel=on_vercel,
        serve_frontend=_bool("SERVE_FRONTEND", True),
        frontend_dir=_str("FRONTEND_DIR", "frontend/dist"),
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return build_settings()


def reset_settings_cache() -> None:
    get_settings.cache_clear()
