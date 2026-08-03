# AGENTS.md — edge-panel

面向 AI 智能体与贡献者的仓库开发指南（整合自原 AGENTS.md 与 CLAUDE.md）。

## 项目简介

`edge-panel` 是一个个人 **Edge 浏览器新标签页面板**，由本地 FastAPI 后端提供数据。包含：

- Google / Bing 搜索快捷入口
- 左侧栏：服务器指标（磁盘仪表盘、可选的 `du` 目录占用），通过定时 SSH/本机采集
- 左侧栏：**Logshed** 外部服务可用性（6 小时时间线）
- 右侧栏：Cursor 用量柱状图（服务端代理，规避浏览器 CORS）
- 中间：时钟与快捷链接
- 知乎阅读流（Feed 阅读器）：推荐流、正文、评论、书签

后端在 `/api/*` 下提供 JSON 接口，并通过 `/` 挂载 `frontend/` 下的静态文件。

**典型用法：** 安装 [New Tab Redirect](https://microsoftedge.microsoft.com/addons/detail/new-tab-redirect/oeijnnfgajlnnfnmhajpljolhblfeehg) Edge 扩展，指向 `http://127.0.0.1:8765/`。后端需保持本机运行。

## 技术栈

| 层 | 选型 |
|----|------|
| 运行时 | Python 3.12+ |
| Web | FastAPI + uvicorn |
| 调度 | APScheduler（`BackgroundScheduler`） |
| HTTP 客户端 | httpx（Cursor 代理用 async；Logshed 探测用 sync） |
| SSH | paramiko |
| 本机指标 | psutil |
| 前端 | 原生 HTML/CSS/JS + Chart.js（`chart.umd.min.js`） |
| 配置 | YAML（`config.yaml`，已 gitignore） |
| 持久化 | `data/` 下 JSON 文件（临时文件 + rename 原子写入） |

安装依赖：`uv sync`（或 `python3 -m venv .venv && .venv/bin/pip install -e .`）

## 目录结构

```
edge-panel/
├── run.py                  # 入口：uvicorn backend.main:app
├── collect.py              # 独立单次采集脚本（可配 cron；与 scheduler 逻辑重复）
├── config.yaml             # 本地配置（已 gitignore；从 config.yaml.example 复制）
├── config.yaml.example
├── setup_autostart.sh      # 安装 cron @reboot → server_watchdog.sh
├── server_watchdog.sh      # 保持 run.py 存活；崩溃自动重启
├── backend/
│   ├── main.py             # FastAPI 应用、lifespan、API 路由、静态文件挂载
│   ├── scheduler.py        # APScheduler 任务：指标 + Logshed 探测 + Feed 抓取
│   ├── storage.py          # data/metrics.json
│   ├── logshed.py          # Logshed HTTP 探测 + API 辅助
│   ├── logshed_storage.py  # data/logshed-history.json
│   ├── feeds_storage.py    # data/feeds-cache.json
│   ├── bookmarks_storage.py # data/feed-bookmarks.json
│   ├── feeds/              # 多平台 Feed 适配器（Phase 1：zhihu）
│   ├── config.py           # load_config()
│   └── collectors/
│       ├── local.py
│       └── ssh.py
├── frontend/               # 旧面板前端（后端回退路径使用）
│   ├── index.html
│   ├── script.js           # 每 60s 轮询 API；硬编码后端 base URL
│   └── style.css
├── extension/              # MV3 浏览器扩展（侧边栏面板，直连源站）
│   ├── manifest.json / background.js / sidepanel.html / sidepanel.css
│   ├── script.js           # UI 编排（渲染逻辑移植自 frontend/script.js）
│   ├── cookies.js / metrics.js / logshed.js / cursor.js / feeds.js
│   ├── options.html/js     # Cursor team/user/email、Logshed URL
│   └── chart.umd.min.js    # 本地 vendored Chart.js
├── native_host/            # Go Native Messaging 宿主（SSH-only，Windows .exe）
│   ├── main.go / config.go / collect_ssh.go / go.mod
│   └── setup_native_host.sh # 交叉编译 + 复制到 Windows + reg.exe 注册
└── data/                   # 运行时数据（已 gitignore）
```

## 常用命令

```bash
uv sync                      # 安装依赖（uv；Python >=3.12，见 .python-version）
.venv/bin/python run.py      # 启动后端：uvicorn backend.main:app @ 127.0.0.1:8765
.venv/bin/python collect.py  # 单次指标采集（无需后端；重复 scheduler 逻辑，适配 cron）
bash setup_autostart.sh      # 安装开机自启（cron @reboot → server_watchdog.sh）
EDGE_PANEL_AUTORESTART=0 bash server_watchdog.sh   # 关闭自动重启运行后端（调试用）
bash native_host/setup_native_host.sh              # 构建并注册扩展的 Native 宿主（Windows Edge）
```

`config.yaml` 已被 gitignore —— 复制 [config.yaml.example](config.yaml.example) → `config.yaml`。实际使用需配置：`ssh_defaults`/`targets`、Cursor `team_id`/`user_id`/`user_email` + `cookies`，以及可选的 `feeds.platforms.zhihu.cookies.z_c0`。

## 运行时模型

```
run.py → uvicorn → backend.main:app
                      ├─ lifespan: 启动 APScheduler
                      ├─ GET /api/*   (metrics、logshed、cursor、feeds)
                      └─ mount StaticFiles("/") → frontend/   （最后注册——勿调整顺序）
```

### 定时任务（应用启动时开始）

| 任务 ID | 函数 | 默认间隔 | 配置项 |
|---------|------|----------|--------|
| `collect_metrics` | `scheduler.run_collection()` | 5 分钟 | `schedule.interval_minutes` |
| `probe_logshed` | `logshed.run_probe()` | 1 分钟 | `external_services.logshed_probe_interval_minutes` |
| `fetch_feeds` | `feeds.orchestrator.run_fetch()` | 10 分钟 | `feeds.fetch_interval_minutes`（仅当配置了 `feeds.platforms`） |

三个任务启动时都会**立即执行一次**（`next_run_time=datetime.now()`），随后按间隔重复。

### 前端轮询

- `/api/metrics` — 每 **60s**（+ 服务器面板手动 ↻）
- `/api/logshed-history` — 每 **60s**（更新快捷链接圆点 + Logshed 侧栏）
- `/api/cursor-usage` — 加载时 + 手动 ↻
- `/api/cursor-leaderboard` — 加载时 + 手动 ↻（7d/30d 团队排名）
- `/api/feeds` — 页面加载 / 切换 Tab 时先 `POST /api/feeds/refresh` 再读取结果（书签 Tab 只读本地书签）

**重要：** `frontend/script.js` 中所有 API 调用都硬编码了 `http://127.0.0.1:8765`。修改绑定 host/port 需同步更新前端这些常量（目前没有配置注入机制）。修改 JS/CSS 后请强制刷新浏览器（静态文件无缓存破坏机制）。

### 后端模块

- [backend/main.py](backend/main.py) — FastAPI 应用、lifespan、所有 API 路由、CORS。Cursor 端点是 async httpx 代理，使用配置中的 cookies 访问 cursor.com。
- [backend/config.py](backend/config.py) — `load_config()` 读取 `config.yaml`；各处每次调用都重新读取（无全局配置缓存）。
- [backend/collectors/local.py](backend/collectors/local.py) — psutil：磁盘、CPU、内存。
- [backend/collectors/ssh.py](backend/collectors/ssh.py) — paramiko：`df -PBG`（仅真实 `/dev/*` 块设备，跳过 `/boot`）、`free -b`、按 `du_paths` 执行 `du -sh *`。
- 存储模块（[storage.py](backend/storage.py)、[logshed_storage.py](backend/logshed_storage.py)、[feeds_storage.py](backend/feeds_storage.py)、[bookmarks_storage.py](backend/bookmarks_storage.py)）— 每个模块独占 `data/` 下一个 JSON 文件，原子保存。**不要直接改 `data/*` 文件**，一律通过对应存储模块，以保证临时文件原子写入。
- [backend/logshed.py](backend/logshed.py) — 同步 HTTP 探测（httpx，连接/读取超时 1.5s；`200 <= code < 500` 视为成功），写入历史记录。

## 浏览器扩展（extension/ + native_host/）

后端之外，本仓库同时维护一个 **MV3 浏览器扩展**，把面板功能搬进 Edge 右侧侧边栏（单列：Cursor → 服务器 → Logshed → 阅读，顶部搜索/时钟）。扩展**直连源站**（Cursor/知乎/Logshed，免 CORS），登录态自动读取浏览器 cookie；服务器磁盘（SSH）走 **Native Messaging → Go 宿主**按需采集。这是当前演进方向；`backend/`+`frontend/` 保留作回退。

### 关键约束（改扩展代码前必读）

- **扩展页 `fetch` 无法设置 Cookie / Origin / Referer 等 forbidden headers** —— 由 [background.js](extension/background.js) 的 `declarativeNetRequest` 动态规则在请求前注入（cookie 每次面板打开时经 `onMessage` 刷新）；所有直连 fetch 用 `credentials:"omit"` 避免 cookie 重复。新增直连源站时，记得同步更新 background 的 DNR 规则。
- **Native 宿主必须在浏览器所在系统运行**（Windows 版 Edge → Windows 侧）。WSL 里的后端靠 localhost 转发，但 native messaging 只能拉起浏览器本机的进程。`setup_native_host.sh` 从 WSL 交叉编译 Windows .exe、算好路径后用 `reg.exe` 注册 `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\`。
- 扩展页默认 CSP `script-src 'self'` —— 脚本必须用外部 `.js`（本目录已全部外置），**不要内联脚本**。
- 定时刷新只在侧边栏打开期间进行（`script.js` 的 60s `setInterval`）；无 7×24 后台探测。

### 目录职责

- `extension/script.js` — UI 编排（渲染逻辑移植自 `frontend/script.js`，数据源全部换成扩展模块）
- `extension/feeds.js` — 知乎直连 + 归一化/去重/收藏/评论（移植 `backend/feeds/`；item_id 格式保持 `zhihu:<type>:<id>`；视频条目过滤）
- `extension/cursor.js` — cursor.com 直连（数据函数带 `*Api` 后缀，避免与 script.js 的 UI 同名函数冲突）
- `extension/metrics.js` — 侧边栏页面直接 `chrome.runtime.connectNative` 请求 Go 宿主；先渲染 `chrome.storage.local` 缓存再后台刷新
- `native_host/`（Go）— native messaging 协议（4 字节小端长度 + JSON）；**只采 `type:ssh` 目标**；`config.go` 默认读 WSL UNC 的 `config.yaml`，可用请求字段 `config_path` 覆盖
- `extension/options.html` — 存 Cursor `team_id/user_id/user_email` 与 Logshed URL（这些不是 cookie，无法自动读取）

### 维护注意

- 新增功能时同步更新 `extension/README.md` 与本节。
- 改 `native_host/` 后需重跑 `bash native_host/setup_native_host.sh`（交叉编译 + 复制 + `reg.exe`）。
- Go 工具链仅构建时需要（已装于 `~/.local/go`）；产物是单个 Windows .exe，运行零依赖。

## 自启与自动重启（生产环境）

**已实现，且会影响本地开发/调试。** 不要移除或替换 `setup_autostart.sh` / `server_watchdog.sh`，除非同步更新本节、`README.md` 和已安装的 crontab 条目。

### 开机自启（cron）

```bash
bash setup_autostart.sh
```

- 添加一条 crontab `@reboot` 条目，运行 `server_watchdog.sh`
- 标记注释：`# edge-panel server`
- 日志追加到 `data/server.log`
- cron 通过 **`/usr/bin/env bash`**（而非 `sh`）调用看门狗

**Shell 要求（WSL/Ubuntu）：** 两个 shell 脚本都使用 bash 特性（`set -o pipefail` 等）。在 Debian/Ubuntu/WSL 上 `sh` 通常是 **dash**，不支持 `pipefail`。用 `sh setup_autostart.sh` 会忽略 `#!/usr/bin/env bash` shebang 并报错：

```text
setup_autostart.sh: N: set: Illegal option -o pipefail
```

请始终使用 `bash setup_autostart.sh`、`./setup_autostart.sh`（`chmod +x` 后），或依赖脚本内置的 re-exec 守卫（见下）。**编辑脚本时请保留开头的 bash re-exec 块**（在 `set -euo pipefail` 之前）：

```bash
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi
```

两个脚本都带有该守卫，以便误用 `sh …` 调用时仍能正常工作。

### 看门狗（server_watchdog.sh）

- 循环运行 `.venv/bin/python run.py`
- 退出后等待 3s 重启（除非禁用）
- **限流：** 1 小时内重启超过 10 次 → 休眠 10 分钟再重试
- 把看门狗 PID 写入 `data/server.pid`

**调试时禁用自动重启：**

```bash
EDGE_PANEL_AUTORESTART=0 bash server_watchdog.sh
```

**移除自启：**

```bash
crontab -e   # 删除包含 "# edge-panel server" 的行
```

### 对开发的影响

1. 若自启/看门狗生效，仅杀掉 uvicorn 进程会在 ~3s 后被重启。
2. 端口 8765 冲突通常是旧实例或看门狗仍在运行——检查 `data/server.pid` 与 `data/server.log`。
3. 改代码需重启后端（或等看门狗重启）；前端静态文件从磁盘读取且无缓存破坏，改 JS/CSS 后强制刷新浏览器。
4. **不要提交** `config.yaml` 或 `data/` 下任何内容（见 `.gitignore`）。

## 配置（config.yaml）

复制 `config.yaml.example` → `config.yaml`。主要配置段：

| 段 | 用途 |
|----|------|
| `server.host`, `server.port` | uvicorn 绑定（默认 `127.0.0.1:8765`） |
| `schedule.interval_minutes` | 服务器指标采集间隔 |
| `ssh_defaults` | 所有 `type: ssh` 目标共用的 SSH 用户名/密码/密钥 |
| `du_paths` | 在 SSH 目标上执行 `du -sh *` 的目录 |
| `targets` | `local` 或 `ssh` 采集目标列表 |
| `cursor` | team/user ID、`user_email`、天数、用量代理所需的浏览器 cookies |
| `external_services.logshed_url` | Logshed 探测 URL |
| `external_services.logshed_probe_interval_minutes` | 探测间隔（默认 1） |
| `feeds.fetch_interval_minutes` | 知乎 Feed 抓取间隔（默认 10） |
| `feeds.platforms.zhihu` | 知乎 cookies（`cookie_string` 或 `cookies` 字典）、`enabled` |

各 target 的 SSH 字段可覆盖 `ssh_defaults`。

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/metrics` | `data/metrics.json` 的内容 |
| GET | `/api/cursor-usage` | 代理 Cursor dashboard 用量 API（需要有效 cookies） |
| GET | `/api/cursor-leaderboard` | 团队 composer-lines 排名（7d 与 30d） |
| GET | `/api/logshed-status` | 最新缓存的 Logshed 探测结果；`?live=1` 立即触发探测 |
| GET | `/api/logshed-history` | 完整 Logshed 历史 + 计算汇总 |
| GET | `/api/feeds` | 缓存的文本 Feed；`?platform=zhihu`、`?bookmarked=1` |
| GET | `/api/feeds/status` | 各平台抓取状态 |
| GET | `/api/feeds/items/{item_id}` | 条目详情（必要时实时抓取） |
| GET | `/api/feeds/items/{item_id}/comments` | 分页根评论 |
| POST | `/api/feeds/bookmarks` | 收藏条目（`{ "item_id": "..." }`） |
| DELETE | `/api/feeds/bookmarks/{item_id}` | 取消收藏 |
| POST | `/api/feeds/refresh` | 触发 Feed 抓取（`?platform=zhihu` 可选） |
| POST | `/api/feeds/load-more` | 分页加载更多条目 |

前端静态文件在 API 路由注册**之后**挂载到 `/`——不要重排 `main.py` 中的顺序，以免路由优先级出错。

## 数据文件（data/，已 gitignore）

| 文件 | 写入方 | 用途 |
|------|--------|------|
| `metrics.json` | `storage.save()` | 服务器指标快照 |
| `logshed-history.json` | `logshed_storage.save()` | Logshed 探测历史 |
| `feeds-cache.json` | `feeds_storage.save()` | 归一化 Feed 条目 + 平台状态 |
| `feed-bookmarks.json` | `bookmarks_storage.save()` | 本地书签（供后续到源站操作） |
| `server.log` | 看门狗 / uvicorn | 运行日志 |
| `server.pid` | 看门狗 | 看门狗进程 PID |
| `collect.log` | 可选外部 cron | 使用独立 `collect.py` 时 |

### `metrics.json` 结构

- `last_updated`、`servers[]`，含 `name`、`status`（`ok`/`error`）、`collected_at`、`disks[]`、可选 `du_data`、CPU/内存字段

### `logshed-history.json` 结构

- `name`、`url`、`last_probe_at`、`current`（最近一次探测结果）
- `timeline`：最近 6h 每分钟一条探测结果（最多 360 条）
- `recent_failures`：最近 20 条失败记录
- API 额外计算 `timeline_6h`（6h 内 360 个分钟桶）

探测成功规则：HTTP 状态 `200 <= code < 500`。超时：连接/读取 1.5s。

## 界面区域（前端修改相关）

| 区域 | DOM / ID | 数据源 |
|------|----------|--------|
| 服务器侧栏 | `#servers-container`, `#last-updated`, `#refresh-btn` | `/api/metrics` |
| Logshed 面板 | `#logshed-banner`, `#logshed-timeline` | `/api/logshed-history` |
| Cursor 面板 | `#cursor-chart`, `#cursor-stats` | `/api/cursor-usage`, `/api/cursor-leaderboard` |
| Feed 阅读器 | `#feed-masonry`, `#feed-detail` | `/api/feeds`, `/api/feeds/items/*` |
| 搜索 / 时钟 | `#search-input`, `#clock`, `#date` | 仅客户端 |

## Feed 子系统架构（backend/feeds/）

可插拔的多平台阅读器（Phase 1 = 仅 zhihu）。数据流：适配器产出原始 dataclass → `normalize` 转成 dict（过滤视频条目）→ `feeds_storage.merge_items` 按 item id 去重 → 缓存到 `data/feeds-cache.json`。

- [backend/feeds/base.py](backend/feeds/base.py) — `FeedAdapter` 抽象类（`fetch_recommend_feed`、`fetch_item_detail`、`fetch_comments`，可选 `fetch_child_comments`）；`RawItem` / `Comment` dataclass。
- [backend/feeds/registry.py](backend/feeds/registry.py) — 平台 id → 适配器类的映射；`get_adapter(platform_id, config)`。
- [backend/feeds/normalize.py](backend/feeds/normalize.py) — `make_item_id` = `"{platform}:{native_type}:{native_id}"`（该字符串即所有 Feed API 中的 `item_id`）；HTML→文本；**视频条目会被丢弃**（`normalize_item` 返回 `None`）。
- [backend/feeds/orchestrator.py](backend/feeds/orchestrator.py) — `run_fetch`（重置）vs `run_load_more`（分页），`record_platform_status` 记录 `feed_offset`/`has_more`，以及所有 Feed 响应构造。
- [backend/feeds/adapters/zhihu.py](backend/feeds/adapters/zhihu.py) — 调用 `api/v3/feed/topstory/recommend` 等接口。需要 `z_c0` cookie；按 `native_type`（`answer`/`article`/`pin`）构造 URL。

**新增平台的方法：** 实现 `FeedAdapter` → 在 [registry.py](backend/feeds/registry.py) 注册 → 在 `feeds.platforms.<id>` 下添加配置 → 端到端处理 `item_id` 解析（`platform:native_type:native_id`），包括书签逻辑。

## 编码约定

- **最小改动** — 匹配现有模式（`script.js` 用普通函数、JSON 原子写入、scheduler 用同步探测）。
- **密钥** — 绝不提交 `config.yaml`、SSH 密码或 Cursor cookies。
- **语言** — UI 字符串为中文；代码/注释/提交信息为英文。
- **无测试套件** — 目前没有测试，靠本机运行验证；通过浏览器访问 `http://127.0.0.1:8765/` 验证。
- **`collect.py`** 与 scheduler 的采集逻辑重复，供可选外部 cron 使用；后端运行时优先用 APScheduler。
- **自启脚本** — 保留 `setup_autostart.sh` + `server_watchdog.sh` 的行为（cron `@reboot`、3s 重启循环、限流、`EDGE_PANEL_AUTORESTART`、bash re-exec 守卫）。参见[自启与自动重启](#自启与自动重启生产环境)。
- **采集逻辑同步** — 修改采集逻辑时需同时更新 `collect.py` 与 `scheduler.py`（两者复制了相同的 target 循环）。

## 常见任务

```bash
# 开发启动
.venv/bin/python run.py

# 单次指标采集（无需后端）
.venv/bin/python collect.py

# 安装开机自启
bash setup_autostart.sh

# 调试（关闭自动重启）
EDGE_PANEL_AUTORESTART=0 bash server_watchdog.sh
```

## 故障排查速查表

| 现象 | 可能原因 |
|------|---------|
| 新标签页空白 | 后端未运行或重定向 URL 错误 |
| 端口被占用 | 看门狗或 8765 上有残留 uvicorn |
| 修改不生效 | 浏览器缓存；后端未重启 |
| 进程反复出现 | 看门狗自动重启——用 `EDGE_PANEL_AUTORESTART=0` 或停掉 cron |
| `set: Illegal option -o pipefail` | 用 `sh` 运行了脚本；改用 `bash setup_autostart.sh` |
| SSH 目标显示采集失败 | 凭据/网络问题；查看日志 |
| Cursor 图表为空 | `config.yaml` 中 cookies 过期 |
| Feed 阅读器为空 / 会话失效 | `feeds.platforms.zhihu` 中知乎 cookies 过期 |
| Logshed 全红/超时 | 本机无法访问 `logshed_url` |

## 相关文档

- [`README.md`](README.md) — 面向用户的设置说明（中文）

新增功能时，若影响运行时、API、数据格式、自启或智能体工作流，请同步更新**本文件**。
