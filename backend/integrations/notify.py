"""Optional outbound notifications: Slack incoming webhook and n8n webhook.

Both are optional. Failures are logged and returned, never raised, so a broken
webhook can't fail an analysis run.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from typing import Any

from backend.config import Settings

log = logging.getLogger("regradar.notify")


def _post_json(url: str, body: dict[str, Any], timeout: int = 10) -> tuple[bool, str]:
    """POST JSON to a webhook.

    Returns:
        A success flag and a detail string; network errors are returned, not raised.
    """
    req = urllib.request.Request(
        url, data=json.dumps(body, default=str).encode("utf-8"),
        headers={"content-type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - user-configured webhook
            return True, f"HTTP {resp.status}"
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return False, str(exc)


def notify_run_completed(settings: Settings, run_id: str, stats: dict[str, Any]) -> dict[str, str]:
    """Announce a finished run on each configured channel.

    Args:
        settings: Supplies the webhook URLs. Unset channels are skipped.
        run_id: Finished run.
        stats: Run statistics quoted in the message.

    Returns:
        Channel name to an "ok: ..." or "failed: ..." outcome.
    """
    results: dict[str, str] = {}
    text = (
        f"RegRadar run {run_id} finished: {stats.get('accepted_gaps', 0)} accepted gap(s), "
        f"{stats.get('escalated_gaps', 0)} escalated, coverage {stats.get('coverage_pct', 0)}%."
    )
    if settings.slack_webhook_url:
        ok, detail = _post_json(settings.slack_webhook_url, {"text": text})
        results["slack"] = ("ok: " if ok else "failed: ") + detail
    if settings.n8n_webhook_url:
        ok, detail = _post_json(settings.n8n_webhook_url, {"event": "run.completed", "run_id": run_id, "stats": stats, "text": text})
        results["n8n"] = ("ok: " if ok else "failed: ") + detail
    for channel, outcome in results.items():
        log.info("Notification via %s: %s", channel, outcome)
    return results
