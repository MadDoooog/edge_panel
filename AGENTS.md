# AGENTS.md — edge-panel

Guidance for AI agents and contributors working on this repository.

## What this project is

`edge-panel` is a personal **Edge browser new-tab dashboard** backed by a local FastAPI server. It combines:

- Google / Bing search shortcuts
- Left sidebar: server metrics (disk gauges, optional `du` listings) from periodic SSH/local collection
- Left sidebar: **Logshed** external-service uptime (6h timeline)
- Right sidebar: Cursor usage bar chart (server-side proxy to avoid browser CORS)
- Center: clock and quick links

The backend serves JSON under `/api/*` and static frontend files from `frontend/` at `/`.

**Typical usage:** install the [New Tab Redirect](https://microsoftedge.microsoft.com/addons/detail/new-tab-redirect/oeijnnfgajlnnfnmhajpljolhblfeehg) Edge extension pointing to `http://127.0.0.1:8765/`. The backend must stay running locally.

## Tech stack

| Layer | Choice |
|-------|--------|
| Runtime | Python 3.12+ |
| Web | FastAPI + uvicorn |
| Scheduling | APScheduler (`BackgroundScheduler`) |
| HTTP client | httpx (async for Cursor proxy; sync for Logshed probes) |
| SSH | paramiko |
| Local metrics | psutil |
| Frontend | Vanilla HTML/CSS/JS + Chart.js (`chart.umd.min.js`) |
| Config | YAML (`config.yaml`, gitignored) |
| Persistence | JSON files in `data/` (atomic write via temp file + replace) |

Install deps: `uv sync` (or `python3 -m venv .venv && .venv/bin/pip install -e .`)

## Directory layout

```
edge-panel/
├── run.py                  # Entry point: uvicorn backend.main:app
├── collect.py              # Standalone one-shot collector (cron-friendly; duplicates scheduler logic)
├── config.yaml             # Local config (gitignored; copy from config.yaml.example)
├── config.yaml.example
├── setup_autostart.sh      # Installs cron @reboot → server_watchdog.sh
├── server_watchdog.sh      # Keeps run.py alive; auto-restart on crash
├── backend/
│   ├── main.py             # FastAPI app, lifespan, API routes, static mount
│   ├── scheduler.py        # APScheduler jobs: metrics + Logshed probe
│   ├── storage.py          # data/metrics.json
│   ├── logshed.py          # Logshed HTTP probe + API helpers
│   ├── logshed_storage.py  # data/logshed-history.json
│   ├── feeds_storage.py    # data/feeds-cache.json
│   ├── bookmarks_storage.py # data/feed-bookmarks.json
│   ├── feeds/              # Multi-platform feed adapters (Phase 1: zhihu)
│   ├── config.py           # load_config()
│   └── collectors/
│       ├── local.py
│       └── ssh.py
├── frontend/
│   ├── index.html
│   ├── script.js           # Polls APIs every 60s; hardcoded backend base URL
│   └── style.css
├── data/                   # Runtime data (gitignored)
```

## Runtime model

```
run.py → uvicorn → backend.main:app
                      ├─ lifespan: start APScheduler
                      ├─ GET /api/*
                      └─ mount StaticFiles("/") → frontend/
```

### Scheduler jobs (started on app startup)

| Job ID | Function | Default interval | Config key |
|--------|----------|------------------|------------|
| `collect_metrics` | `scheduler.run_collection()` | 5 min | `schedule.interval_minutes` |
| `probe_logshed` | `logshed.run_probe()` | 1 min | `external_services.logshed_probe_interval_minutes` |
| `fetch_feeds` | `feeds.orchestrator.run_fetch()` | 10 min | `feeds.fetch_interval_minutes` (only if `feeds.platforms` configured) |

Both jobs run **immediately once** on startup (`next_run_time=datetime.now()`), then repeat on interval.

### Frontend polling

- `/api/metrics` — every **60s** (+ manual ↻ on server panel)
- `/api/logshed-history` — every **60s** (updates quicklink dot + Logshed sidebar)
- `/api/cursor-usage` — on load + manual ↻
- `/api/cursor-leaderboard` — on load + manual ↻ (7d/30d team rank)
- `/api/feeds` — page load / tab switch triggers `POST /api/feeds/refresh` then reads result (bookmarks tab reads local bookmarks only)

**Important:** `frontend/script.js` hardcodes `http://127.0.0.1:8765` for all API calls. Changing bind host/port requires updating the frontend constants or introducing a config injection mechanism (not implemented today).

## Autostart & auto-restart (production setup)

This is **already implemented** and affects local development/debugging. **Do not remove or replace** `setup_autostart.sh` / `server_watchdog.sh` without updating this section, `README.md`, and any installed crontab entries.

### Boot autostart (cron)

```bash
bash setup_autostart.sh
```

- Adds a single crontab `@reboot` entry that runs `server_watchdog.sh`
- Marker comment: `# edge-panel server`
- Logs appended to `data/server.log`
- Cron invokes watchdog via **`/usr/bin/env bash`** (not `sh`)

**Shell requirement (WSL/Ubuntu):** Both shell scripts use bash features (`set -o pipefail`, etc.). On Debian/Ubuntu/WSL, `sh` is often **dash**, which does **not** support `pipefail`. Running `sh setup_autostart.sh` ignores the `#!/usr/bin/env bash` shebang and fails with:

```text
setup_autostart.sh: N: set: Illegal option -o pipefail
```

Always use `bash setup_autostart.sh`, `./setup_autostart.sh` (after `chmod +x`), or rely on the scripts' built-in re-exec guard (see below). **When editing these scripts, keep the bash re-exec block** at the top (before `set -euo pipefail`):

```bash
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi
```

Present in both `setup_autostart.sh` and `server_watchdog.sh` so accidental `sh …` invocation still works.

### Watchdog (`server_watchdog.sh`)

- Runs `.venv/bin/python run.py` in a loop
- On exit: waits 3s and restarts (unless disabled)
- **Rate limit:** >10 restarts within 1 hour → sleep 10 minutes before retrying
- Writes watchdog PID to `data/server.pid`

**Disable auto-restart while debugging:**

```bash
EDGE_PANEL_AUTORESTART=0 bash server_watchdog.sh
```

**Remove autostart:**

```bash
crontab -e   # delete the line containing "# edge-panel server"
```

### Implications for development

1. If autostart/watchdog is active, killing only the uvicorn process will cause a restart within ~3s.
2. Port `8765` conflicts often mean an old instance or watchdog is still running — check `data/server.pid` and `data/server.log`.
3. Code changes require restarting the backend (or waiting for watchdog restart) — frontend static files are served from disk without cache busting; hard-refresh the browser after JS/CSS edits.
4. Do **not** commit `config.yaml` or anything under `data/` (see `.gitignore`).

## Configuration (`config.yaml`)

Copy `config.yaml.example` → `config.yaml`. Key sections:

| Section | Purpose |
|---------|---------|
| `server.host`, `server.port` | uvicorn bind (default `127.0.0.1:8765`) |
| `schedule.interval_minutes` | Server metrics collection interval |
| `ssh_defaults` | Shared SSH username/password/key for all `type: ssh` targets |
| `du_paths` | Directories for `du -sh *` on SSH targets |
| `targets` | List of `local` or `ssh` collection targets |
| `cursor` | team/user IDs, `user_email`, day range, browser cookies for usage proxy |
| `external_services.logshed_url` | Logshed probe URL |
| `external_services.logshed_probe_interval_minutes` | Probe cadence (default 1) |
| `feeds.fetch_interval_minutes` | Zhihu feed fetch interval (default 10) |
| `feeds.platforms.zhihu` | Zhihu cookies (`cookie_string` or `cookies` dict), `enabled` |

Per-target SSH fields override `ssh_defaults`.

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/metrics` | Contents of `data/metrics.json` |
| GET | `/api/cursor-usage` | Proxies Cursor dashboard usage API (needs valid cookies) |
| GET | `/api/cursor-leaderboard` | Team composer-lines rank for 7d and 30d windows |
| GET | `/api/logshed-status` | Latest cached Logshed probe result; `?live=1` triggers immediate probe |
| GET | `/api/logshed-history` | Full Logshed history + computed summaries |
| GET | `/api/feeds` | Cached text feed; `?platform=zhihu`, `?bookmarked=1` |
| GET | `/api/feeds/status` | Per-platform fetch status |
| GET | `/api/feeds/items/{item_id}` | Item detail (live fetch if needed) |
| GET | `/api/feeds/items/{item_id}/comments` | Paginated root comments |
| POST | `/api/feeds/bookmarks` | Bookmark an item (`{ "item_id": "..." }`) |
| DELETE | `/api/feeds/bookmarks/{item_id}` | Remove bookmark |
| POST | `/api/feeds/refresh` | Trigger feed fetch (`?platform=zhihu` optional) |

Static frontend is mounted at `/` **after** API routes are registered — do not reorder in `main.py` without checking route precedence.

## Data files (`data/`, gitignored)

| File | Writer | Purpose |
|------|--------|---------|
| `metrics.json` | `storage.save()` | Server metrics snapshot |
| `logshed-history.json` | `logshed_storage.save()` | Logshed probe history |
| `feeds-cache.json` | `feeds_storage.save()` | Normalized feed items + platform status |
| `feed-bookmarks.json` | `bookmarks_storage.save()` | Local bookmarks for later action on source site |
| `server.log` | watchdog / uvicorn | Operational logs |
| `server.pid` | watchdog | Watchdog process PID |
| `collect.log` | optional external cron | If using standalone `collect.py` |

### `metrics.json` shape

- `last_updated`, `servers[]` with `name`, `status` (`ok`|`error`), `collected_at`, `disks[]`, optional `du_data`, CPU/memory fields

### `logshed-history.json` shape

- `name`, `url`, `last_probe_at`, `current` (latest probe result)
- `timeline`: one probe result per minute for the last 6h (max 360 entries)
- `recent_failures`: last 20 failure records
- API adds computed `timeline_6h` (360 one-minute buckets over 6h)

Probe success rule: HTTP status `200 <= code < 500`. Timeout: 1.5s connect/read.

## UI areas (for frontend changes)

| Region | DOM / IDs | Data source |
|--------|-----------|-------------|
| Server sidebar | `#servers-container`, `#last-updated`, `#refresh-btn` | `/api/metrics` |
| Logshed panel | `#logshed-banner`, `#logshed-timeline` | `/api/logshed-history` |
| Cursor panel | `#cursor-chart`, `#cursor-stats` | `/api/cursor-usage`, `/api/cursor-leaderboard` |
| Feed reader | `#feed-masonry`, `#feed-detail` | `/api/feeds`, `/api/feeds/items/*` |
| Search / clock | `#search-input`, `#clock`, `#date` | client-side only |

## Coding conventions

- **Minimal diffs** — match existing patterns (plain functions in `script.js`, atomic JSON writes, sync probe in scheduler).
- **Secrets** — never commit `config.yaml`, SSH passwords, or Cursor cookies.
- **Language** — UI strings are Chinese; code/comments/commit messages in English.
- **No test suite** today — verify the user runs locally; verify via browser against `http://127.0.0.1:8765/`.
- **`collect.py`** duplicates scheduler collection logic for optional external cron; prefer APScheduler when the backend is running.
- **Autostart scripts** — preserve `setup_autostart.sh` + `server_watchdog.sh` behavior (cron `@reboot`, 3s restart loop, rate limit, `EDGE_PANEL_AUTORESTART`, bash re-exec guard). See [Autostart & auto-restart](#autostart--auto-restart-production-setup).

## Common tasks

```bash
# Dev start
.venv/bin/python run.py

# One-off metrics collection (backend not required)
.venv/bin/python collect.py

# Install boot autostart
bash setup_autostart.sh
```

## Troubleshooting quick reference

| Symptom | Likely cause |
|---------|----------------|
| New tab blank | Backend not running or wrong redirect URL |
| Port already in use | Watchdog or stale uvicorn on 8765 |
| Changes not visible | Browser cache; backend not restarted |
| Process keeps coming back | Watchdog autorestart — use `EDGE_PANEL_AUTORESTART=0` or stop cron |
| `set: Illegal option -o pipefail` | Ran script with `sh` instead of `bash`; use `bash setup_autostart.sh` |
| SSH target shows 采集失败 | Credentials/network; check logs |
| Cursor chart empty | Expired cookies in `config.yaml` |
| Feed reader empty / 会话失效 | Expired Zhihu cookies in `feeds.platforms.zhihu` |
| Logshed all red/timeouts | Network access to `logshed_url` from this host |

## Related docs

- [`README.md`](README.md) — user-facing setup (Chinese)

When adding features, update **this file** if the change affects runtime, APIs, data formats, autostart, or agent workflow.
