from __future__ import annotations

import logging

from backend import bookmarks_storage, feeds_storage
from backend.config import load_config
from backend.feeds import registry
from backend.feeds.normalize import normalize_item

logger = logging.getLogger(__name__)

LOAD_MORE_BATCH = 20


def _feeds_config() -> dict:
    return load_config().get("feeds", {})


def _enabled_platforms() -> dict[str, dict]:
    platforms = _feeds_config().get("platforms", {})
    enabled: dict[str, dict] = {}
    for platform_id, cfg in platforms.items():
        if isinstance(cfg, dict) and cfg.get("enabled", True):
            enabled[platform_id] = cfg
    return enabled


def _normalize_raw_items(raw_items: list) -> list[dict]:
    normalized = []
    for raw in raw_items:
        item = normalize_item(raw)
        if item:
            normalized.append(item)
    return normalized


def run_fetch(*, platform: str | None = None, reset: bool = True) -> None:
    cfg = _feeds_config()
    max_items = int(cfg.get("max_items_per_platform", 80))
    initial_batch = min(LOAD_MORE_BATCH, max_items)
    targets = _enabled_platforms()
    if platform:
        if platform not in targets:
            raise KeyError(f"platform not enabled: {platform}")
        targets = {platform: targets[platform]}

    data = feeds_storage.load()
    all_items = list(data.get("items", []))

    for platform_id, platform_cfg in targets.items():
        try:
            adapter = registry.get_adapter(platform_id, platform_cfg)
            fetch_limit = initial_batch if reset else LOAD_MORE_BATCH
            fetch_offset = 0 if reset else int(
                data.get("platforms", {}).get(platform_id, {}).get("feed_offset", 0)
            )
            raw_items = adapter.fetch_recommend_feed(limit=fetch_limit, offset=fetch_offset)
            normalized = _normalize_raw_items(raw_items)
            all_items = feeds_storage.merge_items(
                platform_id,
                normalized,
                max_items=max_items,
                replace=reset,
            )
            feed_offset = (0 if reset else fetch_offset) + len(raw_items)
            feeds_storage.record_platform_status(
                platform_id,
                status="ok",
                error=None,
                item_count=len([i for i in all_items if i.get("platform") == platform_id]),
                feed_offset=feed_offset,
                has_more=len(raw_items) >= fetch_limit,
            )
            logger.info("Fetched %d feed items for %s", len(normalized), platform_id)
        except Exception as exc:
            logger.exception("Failed to fetch feed for %s", platform_id)
            feeds_storage.record_platform_status(
                platform_id,
                status="error",
                error=str(exc),
                item_count=len([i for i in all_items if i.get("platform") == platform_id]),
            )

    feeds_storage.save_items(all_items)


def run_load_more(*, platform: str | None = None) -> dict:
    cfg = _feeds_config()
    max_items = int(cfg.get("max_items_per_platform", 80))
    targets = _enabled_platforms()
    if platform:
        if platform not in targets:
            raise KeyError(f"platform not enabled: {platform}")
        targets = {platform: targets[platform]}

    data = feeds_storage.load()
    all_items = list(data.get("items", []))
    result = {"added": 0, "has_more": False, "total": len(all_items)}

    for platform_id, platform_cfg in targets.items():
        platform_state = data.get("platforms", {}).get(platform_id, {})
        current_count = len([i for i in all_items if i.get("platform") == platform_id])
        if current_count >= max_items:
            result["has_more"] = False
            continue

        feed_offset = int(platform_state.get("feed_offset", 0))
        try:
            adapter = registry.get_adapter(platform_id, platform_cfg)
            raw_items = adapter.fetch_recommend_feed(limit=LOAD_MORE_BATCH, offset=feed_offset)
            normalized = _normalize_raw_items(raw_items)
            before = len(all_items)
            all_items = feeds_storage.merge_items(platform_id, normalized, max_items=max_items)
            added = len(all_items) - before
            feed_offset += len(raw_items)
            has_more = len(raw_items) >= LOAD_MORE_BATCH and len(
                [i for i in all_items if i.get("platform") == platform_id]
            ) < max_items
            feeds_storage.record_platform_status(
                platform_id,
                status="ok",
                error=None,
                item_count=len([i for i in all_items if i.get("platform") == platform_id]),
                feed_offset=feed_offset,
                has_more=has_more,
            )
            result["added"] += added
            result["has_more"] = result["has_more"] or has_more
            result["total"] = len(all_items)
        except Exception as exc:
            logger.exception("Failed to load more feed for %s", platform_id)
            feeds_storage.record_platform_status(
                platform_id,
                status="error",
                error=str(exc),
                item_count=current_count,
            )
            raise

    feeds_storage.save_items(all_items)
    return result


def _item_from_bookmark_entry(entry: dict, cache_by_id: dict[str, dict]) -> dict | None:
    item_id = entry.get("item_id")
    if not item_id:
        return None

    cached = cache_by_id.get(item_id)
    if cached:
        item = dict(cached)
        item["bookmarked"] = True
        return item

    from backend.feeds.normalize import parse_item_id

    try:
        platform, native_type, native_id = parse_item_id(item_id)
    except ValueError:
        return None

    return {
        "id": item_id,
        "platform": entry.get("platform") or platform,
        "native_type": native_type,
        "native_id": native_id,
        "title": entry.get("title", ""),
        "text": entry.get("text", ""),
        "author": entry.get("author", ""),
        "url": entry.get("url", ""),
        "published_at": entry.get("published_at") or entry.get("bookmarked_at", ""),
        "comment_count": int(entry.get("comment_count") or 0),
        "bookmarked": True,
    }


def get_feeds_response(
    *,
    platform: str | None = None,
    bookmarked_only: bool = False,
    offset: int = 0,
    limit: int | None = None,
) -> dict:
    data = feeds_storage.load()
    cache_items = list(data.get("items", []))
    bookmark_ids = bookmarks_storage.list_bookmark_ids()
    cache_by_id = {item["id"]: item for item in cache_items if item.get("id")}

    if bookmarked_only:
        items = []
        seen: set[str] = set()
        for entry in bookmarks_storage.load().get("bookmarks", []):
            item = _item_from_bookmark_entry(entry, cache_by_id)
            if item and item["id"] not in seen:
                items.append(item)
                seen.add(item["id"])
    else:
        items = [dict(item) for item in cache_items]
        for item in items:
            item["bookmarked"] = item.get("id") in bookmark_ids

    if platform:
        items = [i for i in items if i.get("platform") == platform]

    total = len(items)
    if limit is not None:
        items = items[offset : offset + limit]

    platform_state = data.get("platforms", {})
    has_more = False
    if platform and platform in platform_state:
        has_more = bool(platform_state[platform].get("has_more", False))
    elif not platform:
        has_more = any(bool(v.get("has_more")) for v in platform_state.values())

    return {
        "last_updated": data.get("last_updated"),
        "items": items,
        "total": total,
        "offset": offset,
        "limit": limit,
        "has_more": has_more or (limit is not None and offset + len(items) < total),
        "platforms": platform_state,
    }


def get_status_response() -> dict:
    data = feeds_storage.load()
    return {
        "last_updated": data.get("last_updated"),
        "platforms": data.get("platforms", {}),
    }


def get_item_detail(item_id: str) -> dict:
    from backend.feeds.normalize import parse_item_id

    platform, native_type, native_id = parse_item_id(item_id)
    platforms = _enabled_platforms()
    if platform not in platforms:
        raise KeyError(f"platform not enabled: {platform}")

    adapter = registry.get_adapter(platform, platforms[platform])
    raw = adapter.fetch_item_detail(native_type, native_id)
    item = normalize_item(raw)
    if item is None:
        raise ValueError("item contains video content and was filtered")
    item["bookmarked"] = item_id in bookmarks_storage.list_bookmark_ids()
    return item


def get_item_comments(item_id: str, *, offset: int, limit: int) -> dict:
    from backend.feeds.normalize import normalize_comment, parse_item_id

    platform, native_type, native_id = parse_item_id(item_id)
    platforms = _enabled_platforms()
    if platform not in platforms:
        raise KeyError(f"platform not enabled: {platform}")

    adapter = registry.get_adapter(platform, platforms[platform])
    comments = adapter.fetch_comments(native_type, native_id, offset=offset, limit=limit)
    return {
        "item_id": item_id,
        "offset": offset,
        "limit": limit,
        "comments": [normalize_comment(c) for c in comments],
    }


def get_comment_children(comment_id: str, *, offset: int, limit: int) -> dict:
    # Phase 1: zhihu only; infer platform from enabled adapters
    platforms = _enabled_platforms()
    for platform_id, platform_cfg in platforms.items():
        adapter = registry.get_adapter(platform_id, platform_cfg)
        children = adapter.fetch_child_comments(comment_id, offset=offset, limit=limit)
        if children or platform_id == "zhihu":
            from backend.feeds.normalize import normalize_comment

            return {
                "comment_id": comment_id,
                "offset": offset,
                "limit": limit,
                "comments": [normalize_comment(c) for c in children],
            }
    return {"comment_id": comment_id, "offset": offset, "limit": limit, "comments": []}
