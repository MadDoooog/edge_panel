import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Any

DATA_FILE = Path(__file__).parent.parent / "data" / "metrics.json"

logger = logging.getLogger(__name__)


def load() -> dict[str, Any]:
    """Return stored metrics. Returns empty dict if no data yet."""
    if not DATA_FILE.exists():
        return {}
    try:
        return json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except Exception:
        logger.exception("Failed to read metrics file")
        return {}


def save(metrics: dict[str, Any]) -> None:
    """Persist metrics to disk (atomic write)."""
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = DATA_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(DATA_FILE)
