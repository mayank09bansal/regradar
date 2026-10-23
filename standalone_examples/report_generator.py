"""Generate a small standalone regulatory-change triage report.

This example is intentionally independent from the RegRadar application.
It uses only the Python standard library and has no imports from this project.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}


def load_changes(path: Path) -> list[dict[str, Any]]:
    """Load and validate the small input format used by this example."""
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("Input must be a JSON array.")

    changes: list[dict[str, Any]] = []
    for index, item in enumerate(data, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"Change {index} must be a JSON object.")
        required = {"title", "regulator", "severity", "action"}
        missing = sorted(required - item.keys())
        if missing:
            raise ValueError(f"Change {index} is missing: {', '.join(missing)}")
        severity = str(item["severity"]).strip().lower()
        if severity not in SEVERITY_ORDER:
            raise ValueError(f"Change {index} has unsupported severity: {severity}")
        changes.append({**item, "severity": severity})
    return sorted(changes, key=lambda change: SEVERITY_ORDER[change["severity"]])


def make_report(changes: list[dict[str, Any]]) -> str:
    """Render changes as a concise Markdown triage report."""
    lines = [
        "# Regulatory change triage",
        "",
        f"**Items reviewed:** {len(changes)}",
        "",
        "This standalone report is an illustrative triage aid and is not legal advice.",
        "",
        "## Priority summary",
        "",
        "| Priority | Regulator | Change | Recommended action |",
        "| --- | --- | --- | --- |",
    ]
    for change in changes:
        lines.append(
            f"| {change['severity'].title()} | {change['regulator']} | "
            f"{change['title']} | {change['action']} |"
        )

    if not changes:
        lines.extend(["", "No regulatory changes were supplied."])
    return "\n".join(lines) + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="JSON file containing regulatory changes")
    parser.add_argument("--output", type=Path, help="Markdown destination; omit when using --stdout")
    parser.add_argument("--stdout", action="store_true", help="Print the report instead of writing it")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.stdout and args.output:
        raise SystemExit("Use either --output or --stdout, not both.")
    if not args.stdout and args.output is None:
        raise SystemExit("Provide --output or use --stdout.")

    report = make_report(load_changes(args.input))
    if args.stdout:
        print(report, end="")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(report, encoding="utf-8")
        print(f"Wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
