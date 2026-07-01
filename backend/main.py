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
from backend.scheduler import start_scheduler

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


@app.get("/api/cursor-usage")
async def cursor_usage():
    """Server-side proxy for cursor.com usage API (avoids browser CORS)."""
    cfg = load_config()
    cursor_cfg = cfg.get("cursor", {})

    team_id = cursor_cfg.get("team_id")
    user_id = cursor_cfg.get("user_id")
    days    = int(cursor_cfg.get("days", 7))
    cookies = cursor_cfg.get("cookies", {})

    if not team_id or not user_id:
        raise HTTPException(status_code=500, detail="cursor.team_id / user_id not configured")
    if not cookies.get("WorkosCursorSessionToken"):
        raise HTTPException(status_code=500, detail="cursor.cookies.WorkosCursorSessionToken not configured")

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
        "user-agent":   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0",
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


@app.get("/api/logshed-status")
def logshed_status(live: bool = False):
    return logshed.get_status_response(live=live)


@app.get("/api/logshed-history")
def logshed_history():
    return logshed.get_history_response()


# Serve the frontend at /
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")

