"""Persistence for runs and execution traces.

Two interchangeable backends with the same methods:

* ``Database``          - SQLite via the standard library (local development, tests).
* ``PostgresDatabase``  - PostgreSQL via psycopg 3 (Vercel + Neon, or any hosted Postgres).

Use ``open_database(settings)`` to get the right one for ``DATABASE_URL``.
Queries are written once with ``?`` placeholders and translated for Postgres.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

SCHEMA_STATEMENTS = (
    """CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        llm_provider TEXT NOT NULL,
        llm_model TEXT NOT NULL,
        request_json TEXT NOT NULL,
        stats_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT,
        error TEXT
    )""",
    """CREATE TABLE IF NOT EXISTS messages (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        message_type TEXT NOT NULL,
        message_json TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
    )""",
    "CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC)",
)


class _BaseDatabase:
    """Shared query logic. Subclasses provide ``connect()`` and ``_sql()``."""

    kind = "base"

    def _sql(self, query: str) -> str:
        return query

    @contextmanager
    def connect(self) -> Iterator[Any]:  # pragma: no cover - abstract
        raise NotImplementedError
        yield

    def _init_schema(self) -> None:
        with self.connect() as conn:
            for stmt in SCHEMA_STATEMENTS:
                conn.execute(stmt)

    def _exec(self, conn: Any, query: str, params: tuple = ()) -> Any:
        return conn.execute(self._sql(query), params)

    def ping(self) -> bool:
        with self.connect() as conn:
            return self._exec(conn, "SELECT 1 AS ok").fetchone()["ok"] == 1

    # ---------------------------------------------------------------- runs
    def create_run(self, run_id: str, created_at: str, mode: str, provider: str, model: str, request: dict) -> None:
        with self.connect() as conn:
            self._exec(
                conn,
                "INSERT INTO runs (id, created_at, status, mode, llm_provider, llm_model, request_json) "
                "VALUES (?, ?, 'running', ?, ?, ?, ?)",
                (run_id, created_at, mode, provider, model, json.dumps(request, default=str)),
            )

    def finish_run(
        self, run_id: str, completed_at: str, status: str, stats: dict, result: dict | None,
        trace: list[dict], error: str | None = None,
    ) -> None:
        with self.connect() as conn:
            self._exec(
                conn,
                "UPDATE runs SET completed_at=?, status=?, stats_json=?, result_json=?, error=? WHERE id=?",
                (completed_at, status, json.dumps(stats, default=str),
                 json.dumps(result, default=str) if result is not None else None, error, run_id),
            )
            self._exec(conn, "DELETE FROM messages WHERE run_id=?", (run_id,))
            rows = [(run_id, m["seq"], m["sender"], m["recipient"], m["message_type"], json.dumps(m, default=str))
                    for m in trace]
            if rows:
                self._executemany(
                    conn,
                    "INSERT INTO messages (run_id, seq, sender, recipient, message_type, message_json) "
                    "VALUES (?,?,?,?,?,?)",
                    rows,
                )

    def _executemany(self, conn: Any, query: str, rows: list[tuple]) -> None:
        conn.executemany(self._sql(query), rows)

    @staticmethod
    def _summary(row: Any) -> dict[str, Any]:
        return {
            "id": row["id"], "created_at": row["created_at"], "completed_at": row["completed_at"],
            "status": row["status"], "mode": row["mode"], "llm_provider": row["llm_provider"],
            "llm_model": row["llm_model"], "stats": json.loads(row["stats_json"] or "{}"), "error": row["error"],
        }

    def list_runs(self, limit: int = 50) -> list[dict[str, Any]]:
        # Named columns: result_json holds the whole run and summaries never read it.
        with self.connect() as conn:
            rows = self._exec(
                conn,
                "SELECT id, created_at, completed_at, status, mode, llm_provider, llm_model, stats_json, error "
                "FROM runs ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [self._summary(r) for r in rows]

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = self._exec(conn, "SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
            count_row = self._exec(conn, "SELECT COUNT(*) AS n FROM messages WHERE run_id=?", (run_id,)).fetchone()
        if row is None:
            return None
        data = self._summary(row)
        data["request"] = json.loads(row["request_json"])
        data["result"] = json.loads(row["result_json"]) if row["result_json"] else None
        data["trace_length"] = count_row["n"]
        return data

    def get_trace(self, run_id: str) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = self._exec(
                conn, "SELECT message_json FROM messages WHERE run_id=? ORDER BY seq", (run_id,)
            ).fetchall()
        return [json.loads(r["message_json"]) for r in rows]

    def delete_run(self, run_id: str) -> bool:
        with self.connect() as conn:
            self._exec(conn, "DELETE FROM messages WHERE run_id=?", (run_id,))
            return self._exec(conn, "DELETE FROM runs WHERE id=?", (run_id,)).rowcount > 0


class Database(_BaseDatabase):
    """SQLite database at ``path`` (``None`` = in-memory)."""

    kind = "sqlite"

    def __init__(self, path: Path | None):
        self.path = path
        self._lock = threading.Lock()
        self._memory: sqlite3.Connection | None = None
        if path is None:
            self._memory = sqlite3.connect(":memory:", check_same_thread=False)
        else:
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                raise RuntimeError(f"Cannot create database directory {path.parent}: {exc}") from exc
        self._init_schema()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            if self._memory is not None:
                conn = self._memory
                close = False
            else:
                try:
                    conn = sqlite3.connect(self.path, timeout=10)
                except sqlite3.Error as exc:
                    raise RuntimeError(f"Cannot open database {self.path}: {exc}") from exc
                close = True
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")
            try:
                yield conn
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                if close:
                    conn.close()


class PostgresDatabase(_BaseDatabase):
    """PostgreSQL via psycopg 3. One short-lived connection per operation (serverless friendly)."""

    kind = "postgres"

    def __init__(self, url: str, connect_timeout: int = 10):
        import importlib.util

        if importlib.util.find_spec("psycopg") is None:  # pragma: no cover - imported lazily for SQLite users
            raise RuntimeError(
                "DATABASE_URL points to PostgreSQL but psycopg is not installed. "
                "Run: python -m pip install -r requirements.txt"
            )
        self.url = url
        self.connect_timeout = connect_timeout
        self._init_schema()

    def _sql(self, query: str) -> str:
        return query.replace("?", "%s")

    @contextmanager
    def connect(self) -> Iterator[Any]:
        import psycopg
        from psycopg.rows import dict_row

        try:
            conn = psycopg.connect(self.url, row_factory=dict_row, connect_timeout=self.connect_timeout)
        except psycopg.Error as exc:
            raise RuntimeError(f"Cannot connect to PostgreSQL: {exc}") from exc
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _executemany(self, conn: Any, query: str, rows: list[tuple]) -> None:
        with conn.cursor() as cur:
            cur.executemany(self._sql(query), rows)


def open_database(settings: Any) -> _BaseDatabase:
    """Return a SQLite or PostgreSQL database for ``settings.database_url``."""
    if settings.is_postgres:
        return PostgresDatabase(settings.database_url)
    return Database(settings.database_path)


# Public type for "either backend" in type hints.
RunStore = _BaseDatabase
