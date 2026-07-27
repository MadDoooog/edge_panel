from __future__ import annotations

from backend.feeds.adapters.zhihu import ZhihuAdapter
from backend.feeds.base import FeedAdapter


_ADAPTERS: dict[str, type[FeedAdapter]] = {
    "zhihu": ZhihuAdapter,
}


def get_adapter(platform_id: str, config: dict) -> FeedAdapter:
    cls = _ADAPTERS.get(platform_id)
    if cls is None:
        raise KeyError(f"unknown feed platform: {platform_id}")
    return cls(config)


def list_platform_ids() -> list[str]:
    return list(_ADAPTERS.keys())
