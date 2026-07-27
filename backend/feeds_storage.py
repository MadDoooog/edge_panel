from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

DATA_FILE = Path(__file__).parent.parent / "data" / "feeds-cache.json"


def load() -> dict[str, Any]:
    if not DATA_FILE.exists():
        return {}
    try:
        return json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except Exception:
        logger.exception("Failed to load %s", DATA_FILE)
        return {}


def save(data: dict[str, Any]) -> None:
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = DATA_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(DATA_FILE)


def merge_items(
    platform: str,
    new_items: list[dict],
    *,
    max_items: int,
    replace: bool = False,
) -> list[dict]:
    data = load()
    existing = data.get("items", [])
    if replace:
        other_items = [i for i in existing if i.get("platform") != platform]
        platform_items = new_items[:max_items]
        return sorted(
            platform_items + other_items,
            key=lambda x: x.get("published_at", ""),
            reverse=True,
        )

    by_id = {item["id"]: item for item in existing if item.get("id")}
    for item in new_items:
        by_id[item["id"]] = item
    merged = sorted(
        by_id.values(),
        key=lambda x: x.get("published_at", ""),
        reverse=True,
    )
    platform_items = [i for i in merged if i.get("platform") == platform]
    other_items = [i for i in merged if i.get("platform") != platform]
    platform_items = platform_items[:max_items]
    return sorted(platform_items + other_items, key=lambda x: x.get("published_at", ""), reverse=True)


def record_platform_status(
    platform: str,
    *,
    status: str,
    error: str | None = None,
    item_count: int = 0,
    feed_offset: int | None = None,
    has_more: bool | None = None,
) -> None:
    data = load()
    data.setdefault("platforms", {})
    entry = data["platforms"].get(platform, {})
    entry.update({
        "last_fetch_at": datetime.now().isoformat(timespec="seconds"),
        "status": status,
        "error": error,
        "item_count": item_count,
    })
    if feed_offset is not None:
        entry["feed_offset"] = feed_offset
    if has_more is not None:
        entry["has_more"] = has_more
    data["platforms"][platform] = entry
    data["last_updated"] = datetime.now().isoformat(timespec="seconds")
    save(data)


def save_items(items: list[dict]) -> None:
    data = load()
    data["items"] = items
    data["last_updated"] = datetime.now().isoformat(timespec="seconds")
    save(data)
