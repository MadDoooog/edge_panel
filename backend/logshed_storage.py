import json
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

DATA_FILE = Path(__file__).parent.parent / "data" / "logshed-history.json"
MAX_RECENT_FAILURES = 20
TIMELINE_HOURS = 6
TIMELINE_MINUTES = TIMELINE_HOURS * 60  # 360 one-minute buckets

logger = logging.getLogger(__name__)


def load() -> dict[str, Any]:
    """Return stored logshed history. Returns empty dict if no data yet."""
    if not DATA_FILE.exists():
        return {}
    try:
        return json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except Exception:
        logger.exception("Failed to read logshed history file")
        return {}


def save(data: dict[str, Any]) -> None:
    """Persist logshed history to disk (atomic write)."""
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = DATA_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(DATA_FILE)


def _update_timeline(data: dict[str, Any], now: datetime, ok: bool) -> None:
    """Keep one probe result per minute for the last TIMELINE_HOURS."""
    now_iso = now.isoformat(timespec="seconds")
    minute_ts = now.replace(second=0, microsecond=0)
    cutoff = minute_ts - timedelta(minutes=TIMELINE_MINUTES - 1)

    minute_map: dict[datetime, dict[str, Any]] = {}
    for item in data.get("timeline", []):
        try:
            ts = datetime.fromisoformat(item["at"]).replace(second=0, microsecond=0)
        except (ValueError, TypeError):
            continue
        if ts >= cutoff:
            minute_map[ts] = item

    minute_map[minute_ts] = {"at": now_iso, "ok": ok}
    sorted_minutes = sorted(minute_map.keys())
    data["timeline"] = [minute_map[m] for m in sorted_minutes[-TIMELINE_MINUTES:]]


def record_probe(
    *,
    name: str,
    url: str,
    ok: bool,
    status_code: int | None,
    elapsed_ms: int,
    error: str | None,
) -> dict[str, Any]:
    """Append a probe result to history and persist."""
    now = datetime.now()
    now_iso = now.isoformat(timespec="seconds")

    data = load()
    if not data:
        data = {
            "name": name,
            "url": url,
            "recent_failures": [],
        }

    data["name"] = name
    data["url"] = url
    data["last_probe_at"] = now_iso
    data["current"] = {
        "ok": ok,
        "status_code": status_code,
        "elapsed_ms": elapsed_ms,
        "error": error,
    }

    if not ok:
        failures: list[dict[str, str]] = data.setdefault("recent_failures", [])
        failures.insert(0, {"at": now_iso, "error": error or f"HTTP {status_code}"})
        data["recent_failures"] = failures[:MAX_RECENT_FAILURES]

    _update_timeline(data, now, ok)
    save(data)
    return data


def compute_timeline_6h(data: dict[str, Any]) -> dict[str, Any]:
    """Bucket recent probes into one-minute segments for the last 6 hours."""
    window_end = datetime.now().replace(second=0, microsecond=0)
    window_start = window_end - timedelta(minutes=TIMELINE_MINUTES - 1)

    minute_map: dict[datetime, bool] = {}
    for item in data.get("timeline", []):
        try:
            ts = datetime.fromisoformat(item["at"]).replace(second=0, microsecond=0)
        except (ValueError, TypeError):
            continue
        if window_start <= ts <= window_end:
            minute_map[ts] = bool(item.get("ok"))

    buckets: list[dict[str, Any]] = []
    total_ok = 0
    total_fail = 0
    for i in range(TIMELINE_MINUTES):
        b_start = window_start + timedelta(minutes=i)
        if b_start in minute_map:
            ok = 1 if minute_map[b_start] else 0
            fail = 1 - ok
        else:
            ok = fail = 0
        total_ok += ok
        total_fail += fail
        buckets.append({
            "start": b_start.strftime("%H:%M"),
            "ok": ok,
            "fail": fail,
            "total": ok + fail,
        })

    total = total_ok + total_fail
    uptime_pct = round(100.0 * total_ok / total, 2) if total else None
    return {
        "granularity": "minute",
        "hours": TIMELINE_HOURS,
        "uptime_pct": uptime_pct,
        "total_ok": total_ok,
        "total_fail": total_fail,
        "total_probes": total,
        "buckets": buckets,
    }
