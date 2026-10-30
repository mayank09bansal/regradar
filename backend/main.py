"""FastAPI application entry point.

Local development (API only, dashboard via Vite on :5173):
    python -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000

Single-server / Vercel mode: when ``frontend/dist`` exists (after ``npm run build``)
the same app also serves the React dashboard. On Vercel these static files are
promoted to the CDN; every /api route still reaches this function.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend import __version__
from backend.api.routes import router
from backend.config import Settings, get_settings
from backend.db import open_database

log = logging.getLogger("regradar")

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
}
# Inline styles cover the style attributes React writes for chart widths.
CONTENT_SECURITY_POLICY = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
    "connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
)
CSP_EXEMPT_PREFIXES = ("/docs", "/redoc")  # Swagger UI and ReDoc load their assets from a CDN


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = settings
        app.state.db = open_database(settings)
        log.info(
            "RegRadar %s started (LLM_PROVIDER=%s, storage=%s, deployment=%s)",
            __version__, settings.llm_provider, settings.database_label,
            "vercel" if settings.on_vercel else "local",
        )
        if not settings.storage_persistent:
            log.warning("Run storage is temporary: set DATABASE_URL to a PostgreSQL database to keep run history.")
        if settings.app_env == "production" and not settings.api_token:
            log.warning("REGRADAR_API_TOKEN is not set: anyone who can reach this API can start runs and delete data.")
        yield

    app = FastAPI(
        title="RegRadar API",
        version=__version__,
        description="Multi-agent regulatory change radar: six LangGraph agents with a validator feedback loop.",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )
    app.include_router(router)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        for name, value in SECURITY_HEADERS.items():
            response.headers.setdefault(name, value)
        if not request.url.path.startswith(CSP_EXEMPT_PREFIXES):
            response.headers.setdefault("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        return response

    @app.exception_handler(Exception)
    async def unhandled(_: Request, exc: Exception) -> JSONResponse:  # pragma: no cover - defensive
        log.exception("Unhandled error", exc_info=exc)
        # Exception text can hold connection strings or file paths: it stays in the server log.
        return JSONResponse(status_code=500, content={"detail": "Internal server error. See the server log for details."})

    frontend = settings.frontend_path
    if settings.serve_frontend and (frontend / "index.html").is_file():
        # Low-priority routes: /api/*, /docs and /openapi.json always win.
        # Unknown navigation paths (e.g. /runs/<id>/trace) fall back to index.html for React Router.
        app.frontend("/", directory=str(frontend), fallback="index.html")
        log.info("Serving dashboard from %s", frontend)
    else:
        @app.get("/", include_in_schema=False)
        def root() -> dict[str, str]:
            return {"name": "RegRadar API", "version": __version__, "docs": "/docs", "health": "/api/health"}

    return app


app = create_app()
