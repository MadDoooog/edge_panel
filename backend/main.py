import asyncio
import logging
from datetime import datetime, timezone, timedelta
from pathlib import Path
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend import storage
from backend.config import load_config
from backend import logshed
from backend import bookmarks_storage
from backend.feeds import orchestrator as feeds
from backend.scheduler import start_scheduler
from pydantic import BaseModel

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"

@asynccontextmanager
async def lifespan(_: FastAPI):
    cfg = load_config()
    interval_minutes = int(cfg.get("schedule", {}).get("interval_minutes", 5))
    scheduler = start_scheduler(interval_minutes=interval_minutes)
    try:
        yield
    finally:
        scheduler.shutdown(wait=False)


app = FastAPI(title="Edge Panel API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/api/metrics")
def get_metrics():
    return storage.load()


CURSOR_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0"
)


def _cursor_cfg_or_raise() -> dict:
    cfg = load_config().get("cursor", {})
    team_id = cfg.get("team_id")
    cookies = cfg.get("cookies", {})
    if not team_id:
        raise HTTPException(status_code=500, detail="cursor.team_id not configured")
    if not cookies.get("WorkosCursorSessionToken"):
        raise HTTPException(status_code=500, detail="cursor.cookies.WorkosCursorSessionToken not configured")
    return cfg


def _cursor_date_range(days: int) -> tuple[str, str]:
    """Inclusive calendar-day range ending today (local time)."""
    end = datetime.now().date()
    start = end - timedelta(days=days - 1)
    return start.isoformat(), end.isoformat()


async def _fetch_leaderboard_period(
    client: httpx.AsyncClient,
    cursor_cfg: dict,
    days: int,
) -> dict:
    team_id = cursor_cfg["team_id"]
    user_email = cursor_cfg.get("user_email")
    cookies = cursor_cfg.get("cookies", {})
    if not user_email:
        raise HTTPException(status_code=500, detail="cursor.user_email not configured")

    start_date, end_date = _cursor_date_range(days)
    params = {
        "startDate": start_date,
        "endDate": end_date,
        "pageSize": 10,
        "teamId": team_id,
        "user": user_email,
        "leaderboardSortBy": "composer_lines",
    }
    headers = {
        "accept": "application/json",
        "referer": f"https://cursor.com/dashboard/analytics?startDate={start_date}&endDate={end_date}",
        "user-agent": CURSOR_UA,
    }
    resp = await client.get(
        "https://cursor.com/api/v2/analytics/team/leaderboard",
        params=params,
        headers=headers,
        cookies=cookies,
    )
    resp.raise_for_status()
    payload = resp.json()
    board = payload.get("composer_leaderboard") or {}
    entries = board.get("data") or []
    me = next((e for e in entries if e.get("email") == user_email), None)
    if me is None:
        raise HTTPException(status_code=502, detail=f"user not found in leaderboard: {user_email}")
    return {
        "days": days,
        "start_date": start_date,
        "end_date": end_date,
        "rank": me.get("rank"),
        "total_users": board.get("total_users"),
        "composer_lines_accepted": me.get("total_composer_lines_accepted"),
        "diff_accepts": me.get("total_diff_accepts"),
    }


@app.get("/api/cursor-usage")
async def cursor_usage():
    """Server-side proxy for cursor.com usage API (avoids browser CORS)."""
    cursor_cfg = _cursor_cfg_or_raise()
    team_id = cursor_cfg.get("team_id")
    user_id = cursor_cfg.get("user_id")
    days    = int(cursor_cfg.get("days", 7))
    cookies = cursor_cfg.get("cookies", {})

    if not user_id:
        raise HTTPException(status_code=500, detail="cursor.user_id not configured")

    # Build date range: [days] days ending now (ms timestamps)
    now = datetime.now(timezone.utc)
    end_dt   = now.replace(hour=23, minute=59, second=59, microsecond=999000)
    start_dt = (end_dt - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    start_ms = int(start_dt.timestamp() * 1000)
    end_ms   = int(end_dt.timestamp() * 1000)

    payload = {
        "teamId":    team_id,
        "startDate": str(start_ms),
        "endDate":   str(end_ms),
        "userId":    user_id,
        "page":      1,
        "pageSize":  500,
    }

    headers = {
        "accept":       "*/*",
        "content-type": "application/json",
        "origin":       "https://cursor.com",
        "referer":      "https://cursor.com/cn/dashboard/usage",
        "user-agent":   CURSOR_UA,
    }

    async with httpx.AsyncClient(timeout=20) as client:
        try:
            resp = await client.post(
                "https://cursor.com/api/dashboard/get-filtered-usage-events",
                json=payload,
                headers=headers,
                cookies=cookies,
            )
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=e.response.status_code,
                                detail=f"cursor.com returned {e.response.status_code}")
        except Exception as e:
            raise HTTPException(status_code=502, detail=str(e))


@app.get("/api/cursor-leaderboard")
async def cursor_leaderboard():
    """Team composer-lines rank for 7-day and 30-day windows."""
    cursor_cfg = _cursor_cfg_or_raise()
    async with httpx.AsyncClient(timeout=20) as client:
        try:
            rank_7d, rank_30d = await asyncio.gather(
                _fetch_leaderboard_period(client, cursor_cfg, 7),
                _fetch_leaderboard_period(client, cursor_cfg, 30),
            )
            return {"rank_7d": rank_7d, "rank_30d": rank_30d}
        except httpx.HTTPStatusError as e:
            raise HTTPException(
                status_code=e.response.status_code,
                detail=f"cursor.com returned {e.response.status_code}",
            )
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=502, detail=str(e))


@app.get("/api/logshed-status")
def logshed_status(live: bool = False):
    return logshed.get_status_response(live=live)


@app.get("/api/logshed-history")
def logshed_history():
    return logshed.get_history_response()


class BookmarkBody(BaseModel):
    item_id: str


@app.get("/api/feeds")
def get_feeds(
    platform: str | None = None,
    bookmarked: int = 0,
    offset: int = 0,
    limit: int | None = None,
):
    return feeds.get_feeds_response(
        platform=platform,
        bookmarked_only=bool(bookmarked),
        offset=offset,
        limit=limit,
    )


@app.get("/api/feeds/status")
def feeds_status():
    return feeds.get_status_response()


@app.get("/api/feeds/items/{item_id:path}/comments")
def feeds_item_comments(item_id: str, offset: int = 0, limit: int = 20):
    try:
        return feeds.get_item_comments(item_id, offset=offset, limit=min(limit, 50))
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/api/feeds/items/{item_id:path}")
def feeds_item_detail(item_id: str):
    try:
        return feeds.get_item_detail(item_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/feeds/bookmarks")
def add_feed_bookmark(body: BookmarkBody):
    data = feeds.get_feeds_response()
    item = next((i for i in data.get("items", []) if i.get("id") == body.item_id), None)
    if item is None:
        try:
            item = feeds.get_item_detail(body.item_id)
        except Exception as e:
            raise HTTPException(status_code=404, detail=f"item not found: {e}")
    return bookmarks_storage.add_bookmark(item)


@app.delete("/api/feeds/bookmarks/{item_id:path}")
def remove_feed_bookmark(item_id: str):
    if not bookmarks_storage.remove_bookmark(item_id):
        raise HTTPException(status_code=404, detail="bookmark not found")
    return {"ok": True}


@app.get("/api/feeds/comments/{comment_id}/children")
def feeds_comment_children(comment_id: str, offset: int = 0, limit: int = 20):
    try:
        return feeds.get_comment_children(comment_id, offset=offset, limit=min(limit, 50))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/feeds/load-more")
def load_more_feeds(platform: str | None = None):
    try:
        result = feeds.run_load_more(platform=platform)
        response = feeds.get_feeds_response(platform=platform)
        response["loaded"] = result
        return response
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/feeds/refresh")
def refresh_feeds(platform: str | None = None):
    try:
        feeds.run_fetch(platform=platform, reset=True)
        return feeds.get_status_response()
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


# Serve the frontend at /
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")

