from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class RawItem:
    """Platform-specific item before normalization."""

    platform: str
    native_type: str
    native_id: str
    title: str
    text: str
    author: str
    url: str
    published_at: str
    comment_count: int = 0
    has_video: bool = False
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class Comment:
    id: str
    author: str
    text: str
    published_at: str
    like_count: int = 0
    avatar_url: str = ""
    child_count: int = 0
    reply_to_author: str = ""
    children: list["Comment"] = field(default_factory=list)


class FeedAdapter(ABC):
    platform_id: str

    @abstractmethod
    def fetch_recommend_feed(self, *, limit: int) -> list[RawItem]:
        """Fetch recommend/home feed items."""

    @abstractmethod
    def fetch_item_detail(self, native_type: str, native_id: str) -> RawItem:
        """Fetch full text for a single item."""

    @abstractmethod
    def fetch_comments(
        self,
        native_type: str,
        native_id: str,
        *,
        offset: int,
        limit: int,
    ) -> list[Comment]:
        """Fetch paginated root comments."""

    def fetch_child_comments(
        self,
        comment_id: str,
        *,
        offset: int,
        limit: int,
    ) -> list[Comment]:
        """Fetch replies for a root comment. Override per platform."""
        return []
