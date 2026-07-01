import logging
from datetime import datetime

import httpx

from backend.config import load_config
from backend import logshed_storage

logger = logging.getLogger(__name__)

LOGSHED_DEFAULT_URL = "http://logshed-search-eu.prod.mypna.com/"
LOGSHED_NAME = "Logshed Search EU"


def _get_config() -> tuple[str, int]:
    cfg = load_config()
    ext = cfg.get("external_services", {})
    url = ext.get("logshed_url") or LOGSHED_DEFAULT_URL
    interval = int(ext.get("logshed_probe_interval_minutes", 1))
    return url, interval


def probe(url: str | None = None) -> dict:
    """Run a synchronous HTTP probe against Logshed."""
    if url is None:
        url, _ = _get_config()

    start = datetime.now()
    timeout = httpx.Timeout(connect=1.5, read=1.5, write=1.5, pool=1.5)

    try:
        with httpx.Client(
            timeout=timeout,
            follow_redirects=True,
            headers={"user-agent": "edge-panel/1.0"},
        ) as client:
            resp = client.get(url)
            ok = 200 <= resp.status_code < 500
            status_code = resp.status_code
            err = None
    except Exception as e:
        ok = False
        status_code = None
        err = str(e)

    elapsed_ms = int((datetime.now() - start).total_seconds() * 1000)
    return {
        "ok": ok,
        "status_code": status_code,
        "elapsed_ms": elapsed_ms,
        "error": err,
    }


def run_probe() -> None:
    """Probe Logshed and persist the result to history."""
    url, _ = _get_config()
    result = probe(url)
    logshed_storage.record_probe(
        name=LOGSHED_NAME,
        url=url,
        ok=result["ok"],
        status_code=result["status_code"],
        elapsed_ms=result["elapsed_ms"],
        error=result["error"],
    )
    status = "ok" if result["ok"] else "FAIL"
    logger.info(
        "Logshed probe %s (HTTP %s, %dms)",
        status,
        result["status_code"],
        result["elapsed_ms"],
    )


def get_status_response(*, live: bool = False) -> dict:
    """Return current status, optionally running a live probe first."""
    url, _ = _get_config()

    if live:
        result = probe(url)
        data = logshed_storage.record_probe(
            name=LOGSHED_NAME,
            url=url,
            ok=result["ok"],
            status_code=result["status_code"],
            elapsed_ms=result["elapsed_ms"],
            error=result["error"],
        )
    else:
        data = logshed_storage.load()

    current = data.get("current", {})
    return {
        "name": data.get("name", LOGSHED_NAME),
        "url": data.get("url", url),
        "ok": current.get("ok"),
        "status_code": current.get("status_code"),
        "elapsed_ms": current.get("elapsed_ms"),
        "error": current.get("error"),
        "checked_at": data.get("last_probe_at"),
    }


def get_history_response() -> dict:
    """Return probe history with 6-hour timeline."""
    url, _ = _get_config()
    data = logshed_storage.load()
    if not data:
        return {
            "name": LOGSHED_NAME,
            "url": url,
            "last_probe_at": None,
            "current": None,
            "recent_failures": [],
            "timeline_6h": logshed_storage.compute_timeline_6h({}),
        }
    return {
        "name": data.get("name", LOGSHED_NAME),
        "url": data.get("url", url),
        "last_probe_at": data.get("last_probe_at"),
        "current": data.get("current"),
        "recent_failures": data.get("recent_failures", []),
        "timeline_6h": logshed_storage.compute_timeline_6h(data),
    }
