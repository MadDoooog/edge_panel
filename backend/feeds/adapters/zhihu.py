from __future__ import annotations

import logging
from datetime import datetime, timezone

import httpx

from backend.feeds.base import Comment, FeedAdapter, RawItem

logger = logging.getLogger(__name__)

FEED_URL = "https://www.zhihu.com/api/v3/feed/topstory/recommend"
_EMBEDDED_CHILD_CACHE: dict[str, list[Comment]] = {}
DEFAULT_HEADERS = {
    "user-agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"
    ),
    "referer": "https://www.zhihu.com/",
    "x-requested-with": "fetch",
}


def parse_cookie_string(cookie_string: str) -> dict[str, str]:
    cookies: dict[str, str] = {}
    for part in cookie_string.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        key, value = part.split("=", 1)
        cookies[key.strip()] = value.strip()
    return cookies


def _ts_to_iso(ts: int | float | None) -> str:
    if not ts:
        return ""
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).astimezone().isoformat(timespec="seconds")
    except (TypeError, ValueError, OSError):
        return ""


def _author_name(author: dict | None) -> str:
    if not author:
        return ""
    member = author.get("member")
    if isinstance(member, dict):
        return str(member.get("name") or "")
    return str(author.get("name") or author.get("fullname") or "")


def _author_avatar(author: dict | None) -> str:
    if not author:
        return ""
    member = author.get("member")
    if isinstance(member, dict):
        return str(member.get("avatar_url") or "")
    return str(author.get("avatar_url") or "")


def _comment_from_row(row: dict, *, include_embedded_children: bool = True) -> Comment:
    reply_to = row.get("reply_to_author")
    reply_name = _author_name(reply_to) if isinstance(reply_to, dict) else ""
    embedded_children: list[Comment] = []
    if include_embedded_children:
        raw_children = row.get("child_comments") or []
        if isinstance(raw_children, list):
            embedded_children = [
                _comment_from_row(child, include_embedded_children=False)
                for child in raw_children
                if isinstance(child, dict)
            ]
    child_count = int(row.get("child_comment_count") or len(embedded_children) or 0)
    return Comment(
        id=str(row.get("id") or ""),
        author=_author_name(row.get("author")),
        text=str(row.get("content") or row.get("excerpt") or ""),
        published_at=_ts_to_iso(row.get("created_time")),
        like_count=int(row.get("vote_count") or 0),
        avatar_url=_author_avatar(row.get("author")),
        child_count=child_count,
        reply_to_author=reply_name,
        children=embedded_children,
    )


def _has_video(target: dict) -> bool:
    if target.get("type") == "zvideo":
        return True
    if target.get("video"):
        return True
    attachment = target.get("attachment") or {}
    if attachment.get("type") == "video":
        return True
    return False


def _web_url(native_type: str, target: dict) -> str:
    native_id = str(target.get("id", ""))
    if native_type == "answer":
        qid = (target.get("question") or {}).get("id", "")
        return f"https://www.zhihu.com/question/{qid}/answer/{native_id}"
    if native_type == "article":
        return f"https://zhuanlan.zhihu.com/p/{native_id}"
    if native_type == "pin":
        return f"https://www.zhihu.com/pin/{native_id}"
    return f"https://www.zhihu.com/{native_type}/{native_id}"


def _title_for_target(native_type: str, target: dict) -> str:
    if native_type == "answer":
        return str((target.get("question") or {}).get("title") or "")
    return str(target.get("title") or target.get("excerpt_title") or "")


def _raw_from_target(target: dict) -> RawItem | None:
    native_type = str(target.get("type") or "")
    if not native_type or native_type == "zvideo":
        return None
    native_id = str(target.get("id") or "")
    if not native_id:
        return None
    content = target.get("content") or target.get("excerpt") or target.get("content_text") or ""
    return RawItem(
        platform="zhihu",
        native_type=native_type,
        native_id=native_id,
        title=_title_for_target(native_type, target),
        text=str(content),
        author=_author_name(target.get("author")),
        url=_web_url(native_type, target),
        published_at=_ts_to_iso(target.get("created_time") or target.get("updated_time")),
        comment_count=int(target.get("comment_count") or 0),
        has_video=_has_video(target),
        extra={
            "excerpt": target.get("excerpt") or "",
            "attachment": target.get("attachment") or {},
        },
    )


class ZhihuAdapter(FeedAdapter):
    platform_id = "zhihu"

    def __init__(self, config: dict) -> None:
        self._config = config
        cookies_cfg = config.get("cookies") or {}
        cookie_string = config.get("cookie_string") or ""
        if cookie_string:
            self._cookies = parse_cookie_string(cookie_string)
        elif isinstance(cookies_cfg, dict):
            self._cookies = {str(k): str(v) for k, v in cookies_cfg.items()}
        else:
            self._cookies = {}

    def _client(self) -> httpx.Client:
        return httpx.Client(
            timeout=20,
            headers=DEFAULT_HEADERS,
            cookies=self._cookies,
            follow_redirects=True,
        )

    def fetch_recommend_feed(self, *, limit: int, offset: int = 0) -> list[RawItem]:
        if not self._cookies.get("z_c0"):
            raise ValueError("zhihu cookies missing z_c0 — update feeds.platforms.zhihu in config.yaml")

        items: list[RawItem] = []
        page_size = min(20, limit)
        api_offset = offset

        with self._client() as client:
            while len(items) < limit:
                resp = client.get(
                    FEED_URL,
                    params={
                        "session_token": "",
                        "limit": page_size,
                        "offset": api_offset,
                        "desktop": "true",
                    },
                )
                resp.raise_for_status()
                payload = resp.json()
                batch = payload.get("data") or []
                if not batch:
                    break
                for entry in batch:
                    target = entry.get("target") or {}
                    raw = _raw_from_target(target)
                    if raw is not None:
                        items.append(raw)
                    if len(items) >= limit:
                        break
                if not payload.get("paging", {}).get("is_end", False) and batch:
                    api_offset += len(batch)
                else:
                    break

        return items[:limit]

    def fetch_item_detail(self, native_type: str, native_id: str) -> RawItem:
        endpoints = {
            "answer": f"https://www.zhihu.com/api/v4/answers/{native_id}",
            "article": f"https://www.zhihu.com/api/v4/articles/{native_id}",
            "pin": f"https://www.zhihu.com/api/v4/pins/{native_id}",
        }
        url = endpoints.get(native_type)
        if not url:
            raise ValueError(f"unsupported zhihu content type: {native_type}")

        with self._client() as client:
            resp = client.get(url)
            resp.raise_for_status()
            target = resp.json()

        raw = _raw_from_target(target)
        if raw is None:
            raise ValueError(f"zhihu item {native_type}:{native_id} is not readable text content")
        return raw

    def fetch_comments(
        self,
        native_type: str,
        native_id: str,
        *,
        offset: int,
        limit: int,
    ) -> list[Comment]:
        endpoints = {
            "answer": f"https://www.zhihu.com/api/v4/answers/{native_id}/root_comments",
            "article": f"https://www.zhihu.com/api/v4/articles/{native_id}/root_comments",
            "pin": f"https://www.zhihu.com/api/v4/pins/{native_id}/root_comments",
        }
        url = endpoints.get(native_type)
        if not url:
            return []

        with self._client() as client:
            resp = client.get(
                url,
                params={"limit": limit, "offset": offset, "order": "default"},
            )
            resp.raise_for_status()
            payload = resp.json()

        comments: list[Comment] = []
        for row in payload.get("data") or []:
            comment = _comment_from_row(row)
            if comment.children:
                _EMBEDDED_CHILD_CACHE[comment.id] = comment.children
            comments.append(comment)
        return comments

    def fetch_child_comments(
        self,
        comment_id: str,
        *,
        offset: int,
        limit: int,
    ) -> list[Comment]:
        cached = _EMBEDDED_CHILD_CACHE.get(comment_id, [])
        if cached and offset < len(cached):
            return cached[offset : offset + limit]

        with self._client() as client:
            resp = client.get(
                f"https://www.zhihu.com/api/v4/comments/{comment_id}/child_comments",
                params={
                    "limit": limit,
                    "offset": offset,
                    "order_by": "ts",
                    "scene": "comment",
                },
            )
            resp.raise_for_status()
            payload = resp.json()

        return [
            _comment_from_row(row, include_embedded_children=False)
            for row in payload.get("data") or []
        ]
