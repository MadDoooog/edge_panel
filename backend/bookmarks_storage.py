from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

DATA_FILE = Path(__file__).parent.parent / "data" / "feed-bookmarks.json"


def load() -> dict[str, Any]:
    if not DATA_FILE.exists():
        return {"bookmarks": []}
    try:
        return json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except Exception:
        logger.exception("Failed to load %s", DATA_FILE)
        return {"bookmarks": []}


def save(data: dict[str, Any]) -> None:
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = DATA_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(DATA_FILE)


def list_bookmark_ids() -> set[str]:
    return {b["item_id"] for b in load().get("bookmarks", []) if b.get("item_id")}


def add_bookmark(item: dict[str, Any]) -> dict:
    data = load()
    bookmarks = data.setdefault("bookmarks", [])
    item_id = item.get("item_id") or item.get("id")
    if not item_id:
        raise KeyError("item_id")
    bookmarks = [b for b in bookmarks if b.get("item_id") != item_id]
    entry = {
        "item_id": item_id,
        "platform": item.get("platform", ""),
        "url": item.get("url", ""),
        "title": item.get("title", ""),
        "author": item.get("author", ""),
        "text": item.get("text", ""),
        "published_at": item.get("published_at", ""),
        "comment_count": int(item.get("comment_count") or 0),
        "bookmarked_at": datetime.now().isoformat(timespec="seconds"),
    }
    bookmarks.insert(0, entry)
    data["bookmarks"] = bookmarks
    save(data)
    return entry


def remove_bookmark(item_id: str) -> bool:
    data = load()
    before = len(data.get("bookmarks", []))
    data["bookmarks"] = [b for b in data.get("bookmarks", []) if b.get("item_id") != item_id]
    save(data)
    return len(data["bookmarks"]) < before
