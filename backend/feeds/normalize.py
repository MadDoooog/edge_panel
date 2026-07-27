from __future__ import annotations

import re
from html import unescape
from html.parser import HTMLParser

from backend.feeds.base import Comment, RawItem


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._parts: list[str] = []

    def handle_data(self, data: str) -> None:
        text = data.strip()
        if text:
            self._parts.append(text)

    def get_text(self) -> str:
        return "\n".join(self._parts)


def html_to_text(html: str | None) -> str:
    if not html:
        return ""
    parser = _TextExtractor()
    try:
        parser.feed(unescape(html))
        parser.close()
    except Exception:
        return re.sub(r"<[^>]+>", "", unescape(html))
    return parser.get_text()


def make_item_id(platform: str, native_type: str, native_id: str) -> str:
    return f"{platform}:{native_type}:{native_id}"


def parse_item_id(item_id: str) -> tuple[str, str, str]:
    parts = item_id.split(":", 2)
    if len(parts) != 3:
        raise ValueError(f"invalid item_id: {item_id}")
    return parts[0], parts[1], parts[2]


def is_video_item(raw: RawItem) -> bool:
    if raw.has_video:
        return True
    if raw.native_type in {"zvideo", "video"}:
        return True
    attachment = raw.extra.get("attachment") or {}
    if attachment.get("type") == "video":
        return True
    return False


def normalize_item(raw: RawItem) -> dict | None:
    if is_video_item(raw):
        return None
    text = html_to_text(raw.text) if "<" in raw.text else raw.text
    excerpt = html_to_text(raw.extra.get("excerpt", "")) if raw.extra.get("excerpt") else ""
    if not text.strip() and excerpt.strip():
        text = excerpt
    return {
        "id": make_item_id(raw.platform, raw.native_type, raw.native_id),
        "platform": raw.platform,
        "native_type": raw.native_type,
        "native_id": raw.native_id,
        "title": raw.title.strip(),
        "text": text.strip(),
        "author": raw.author.strip(),
        "url": raw.url,
        "published_at": raw.published_at,
        "comment_count": raw.comment_count,
    }


def normalize_comment(comment: Comment) -> dict:
    result = {
        "id": comment.id,
        "author": comment.author,
        "text": html_to_text(comment.text) if "<" in comment.text else comment.text,
        "published_at": comment.published_at,
        "like_count": comment.like_count,
        "avatar_url": comment.avatar_url,
        "child_count": comment.child_count,
        "reply_to_author": comment.reply_to_author,
    }
    if comment.children:
        result["children"] = [normalize_comment(child) for child in comment.children]
    return result
