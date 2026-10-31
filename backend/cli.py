"""Command-line entry point.

    python -m backend.cli demo              # run the deterministic demo and print the trace
    python -m backend.cli demo --report     # also print the Markdown report
    python -m backend.cli runs              # list stored runs
"""

from __future__ import annotations

import argparse
import sys

from backend.config import get_settings
from backend.db import RunStore, open_database
from backend.orchestration.runner import run_analysis
from backend.schemas import AnalysisRequest


def _print_trace(db: RunStore, run_id: str) -> None:
    for m in db.get_trace(run_id):
        print(f"{m['seq']:>3}  {m['sender']:<20} -> {m['recipient']:<20} {m['message_type']:<10} {m['summary']}")


def main(argv: list[str] | None = None) -> int:
    # Windows consoles may default to a legacy code page; keep output readable.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(prog="regradar")
    sub = parser.add_subparsers(dest="command", required=True)
    demo = sub.add_parser("demo", help="Run the deterministic demo through the real LangGraph graph")
    demo.add_argument("--max-revisions", type=int, default=None)
    demo.add_argument("--report", action="store_true", help="Print the Markdown report")
    sub.add_parser("runs", help="List stored runs")
    args = parser.parse_args(argv)

    settings = get_settings()
    db = open_database(settings)
    if args.command == "runs":
        for r in db.list_runs():
            print(f"{r['id']}  {r['status']:<10} {r['mode']:<5} {r['created_at']}  {r['stats'].get('accepted_gaps', '-')} accepted")
        return 0

    detail = run_analysis(AnalysisRequest(mode="demo", max_revisions=args.max_revisions), settings, db)
    print(f"Run {detail['id']}: {detail['status']}" + (f" ({detail['error']})" if detail["error"] else ""))
    print("Route:", " -> ".join(detail["result"]["route_history"]))
    print("Stats:", detail["stats"])
    print("\nExecution trace:")
    _print_trace(db, detail["id"])
    if args.report and detail["result"].get("report"):
        print("\n" + detail["result"]["report"]["markdown"])
    return 0 if detail["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
