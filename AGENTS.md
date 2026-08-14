# AGENTS.md — edge-panel

面向 AI 智能体与贡献者的仓库开发指南。

## 项目简介

`edge-panel` 是一个 **纯浏览器扩展**（MV3，零构建，改 JS/CSS 直接生效），把个人仪表盘搬进 **Edge / Chrome 右侧侧边栏**。单列布局自上而下：**Cursor 用量 → 服务器（SSH 磁盘）→ Logshed → 阅读（知乎）**；顶栏保留「阅读 / 设置」两个按钮，含搜索框与时钟。

- 扩展**直连源站**（Cursor / 知乎 / Logshed，免 CORS）；登录态自动读取浏览器 cookie
- 服务器磁盘（SSH）走 **Native Messaging → Go 宿主**（`native_host/`）按需采集
- **无后端服务、无 7×24 后台任务** —— 所有数据只在面板打开期间获取/轮询

**历史：** 项目最初是 FastAPI 后端 + 新标签页前端的 Python Web 服务；现已整体迁移为浏览器扩展，后端与旧前端已移除，SSH 配置也改为扩展设置页管理（不再依赖磁盘 config.yaml）。

## 目录结构

```
edge-panel/
├── package.sh              # 打包：交叉编译 Go 宿主 → 扩展+宿主+安装脚本 → dist/*.zip
├── extension/              # MV3 浏览器扩展（侧边栏面板，直连源站）
│   ├── manifest.json       # 清单：sidePanel/storage/cookies/downloads + host_permissions + WAR
│   ├── background.js       # 点击图标开关侧边栏 + declarativeNetRequest 动态规则 + SSH 采集（connectNative 流式进度）
│   ├── sidepanel.html/css  # 单列布局面板
│   ├── options.html/js     # 设置页（cursor、logshed、SSH 服务器；下载模板/导入）
│   ├── yaml.js             # 极简 YAML 子集解析器（「导入配置」用）
│   ├── config.example.yaml # 配置模板（设置页「下载配置模板」）
│   ├── chart.umd.min.js    # 本地 vendored Chart.js（避开扩展页 CSP）
│   ├── cookies.js / metrics.js / logshed.js / cursor.js / feeds.js / script.js
│   └── native/             # 打包产物（源仓库不存在；web_accessible_resources）
│       ├── edge-panel-host.exe            # Go 编译产物（Windows amd64）
│       └── install-edge-panel-host.{ps1,bat}  # 一键安装脚本
├── native_host/            # Go Native Messaging 宿主源码（SSH-only）
│   ├── main.go / config.go / collect_ssh.go / go.mod
│   └── install-edge-panel-host.{ps1,bat}  # 安装脚本模板（打包时复制进 native/）
└── config.yaml             # 旧版遗留的磁盘配置（已不再被读取，可删除）
```

## 常用命令

```bash
# 加载/重载扩展：edge://extensions → 开发人员模式 → 加载解压缩的扩展 → 选 extension/
# 打包可安装扩展包（交叉编译 Windows Native 宿主 + 扩展 → dist/edge-panel-v<ver>.zip）：
bash package.sh
# 改 native_host/ 或要生成新安装包时重跑 bash package.sh。
```

## 关键约束（改扩展代码前必读）

- **扩展页 `fetch` 无法设置 Cookie / Origin / Referer 等 forbidden headers** —— 由 [background.js](extension/background.js) 的 `declarativeNetRequest` 动态规则在请求前注入（cookie 每次面板打开时经 `onMessage` 刷新）；所有直连 fetch 用 `credentials:"omit"` 避免 cookie 重复。新增直连源站时，记得同步更新 background 的 DNR 规则。
- **Native 宿主必须在浏览器所在系统运行**（Windows 版 Edge → Windows 侧）。native messaging 只能拉起浏览器本机的进程。宿主与安装脚本由 `package.sh` 交叉编译后随扩展包分发，安装时由扩展从插件资源下载、用户双击 `install-edge-panel-host.bat` 用 `reg.exe` 注册 `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\`。
- 扩展页默认 CSP `script-src 'self'` —— 脚本必须用外部 `.js`（本目录已全部外置），**不要内联脚本**。
- 定时刷新只在侧边栏打开期间进行（`script.js` 的 60s `setInterval`）；无 7×24 后台探测。唯一例外：SSH 采集由 **background service worker** 持有（`chrome.runtime.connectNative` → 宿主流式上报进度 + 每 10s 心跳保活 SW），侧边栏关闭后采集继续，完成后即止。
- 需要 **Edge / Chrome 116+**（Side Panel API）。侧边栏**只**由手动点击工具栏图标开关（`background.js` 的 `openPanelOnActionClick: true`，点击图标即开/关），不做任何自动开/关。

## 扩展模块

- `extension/script.js` — UI 编排（面板渲染、60s 轮询、时钟/搜索）
- `extension/feeds.js` — 知乎直连 + 归一化/去重/收藏/评论；`item_id` 格式保持 `zhihu:<type>:<id>`；视频条目过滤
- `extension/cursor.js` — cursor.com 直连（数据函数带 `*Api` 后缀，避免与 script.js 的 UI 同名函数冲突）
- `extension/background.js` — 点击图标开关侧边栏 + DNR 头注入 + **SSH 采集持有者**（connectNative 流式接收宿主进度 → 持久化到 `chrome.storage.local` 的 `metricsProgress` 并广播到面板）
- `extension/metrics.js` — 页面侧辅助：采集缓存/进度读写（`metrics` / `metricsProgress`）、宿主安装引导、错误识别；不再直接 connectNative
- `extension/logshed.js` — 探测 + 历史（chrome.storage.local）；面板可见期间每 60s 探测一次
- `extension/cookies.js` — `chrome.cookies` 读取辅助（cursor.com 的 `WorkosCursorSessionToken`、zhihu.com 的 `z_c0`）
- `extension/options.html/js` — 存 Cursor `team_id/user_id/user_email`、Logshed URL 与 Release Matrix `version`（`releaseMatrixVersion`，侧边栏 Logshed 左侧链接用；这些不是 cookie，无法自动读取）

## 打包与 Native 宿主安装

- `bash package.sh`：交叉编译 Go 宿主为 Windows .exe，连同扩展文件、安装脚本、`config.example.yaml` 一起打包为 `dist/edge-panel-v<ver>.zip`（见[目录结构](#目录结构)）。
- 安装扩展：解压 zip → `edge://extensions` → 开启「开发人员模式」→「加载解压缩的扩展」→ 选解压目录。
- 安装宿主：打开侧边栏 → 服务器区块显示「Native 宿主未安装」时点「下载并安装 Native 宿主」→ 3 个文件下到下载目录 `edge-panel-host/` → 双击 `install-edge-panel-host.bat`（PowerShell 复制 exe 到 `%LOCALAPPDATA%\edge-panel-host`、写 host manifest、`reg.exe` 注册 Edge）→ 点 ↻ 重试。
- **扩展页无法静默注册宿主**（MV3 不能写注册表 / 任意外部路径），「下载 + 双击」是插件内唯一的安装通路。安装脚本是静态模板，位于 `native_host/`，打包时复制进 `native/`。

## Native 宿主（native_host/）

- 协议：stdin/stdout 各消息为 **4 字节小端长度前缀 + UTF-8 JSON**（标准 native messaging）
- 请求：`{"type":"collect","config":{...}}`。`config` 为**内联采集配置**（JSON/YAML 均可，宿主用 `yaml.Unmarshal` 解析，yaml.v3 兼容 JSON 且按 yaml 标签匹配 `ssh_defaults`/`du_paths`/`targets` 键）；也可用 `config_path` 指向磁盘文件
- **采集期间流式上报进度**：`{"type":"progress","done":N,"total":M,"current":"name","status":"start|collecting|ok|error","phase":"connect|collect|du","error":"...","heartbeat":false}` —— 逐服务器状态变化各上报一次，长耗时（du 最长 120s）期间每 10s 发一次心跳（`heartbeat:true`）保活扩展侧 service worker；最终结果仍以一条 `{"last_updated":...,"servers":[...]}` 返回（无 `type` 字段，扩展据此区分进度与结果）
- 响应：`{"last_updated":...,"servers":[...]}` 或 `{"error":"..."}`
- **只采 `type:ssh` 目标**（df + du），不做本机采集
- 配置优先级：内联 `config` > `config_path` / 环境变量 `EDGE_PANEL_CONFIG`。不再有编译期硬编码路径（旧的 WSL UNC 默认路径已删除）
- 只读取配置：`ssh_defaults` / `du_paths` / `targets`（其余字段被忽略）

## 配置（SSH 服务器，设置页）

SSH 配置在设置页（options.html）「SSH 服务器」区块编辑，保存到 `chrome.storage.sync`（键 `sshConfig`），采集时经 native 消息内联传给宿主。两种编辑方式：

- **表单直接填写**：默认用户名/密码/密钥、`du_paths`（每行一个）、服务器列表（name/host/port/username/password/key_file，可增删）
- **下载模板填写后导入**：「下载配置模板」下载 `config.example.yaml` → 填写 → 「导入配置」上传（YAML 或 JSON；YAML 由 [yaml.js](extension/yaml.js) 解析）

| 段 | 用途 |
|----|------|
| `ssh_defaults` | 所有 `type: ssh` 目标共用的 SSH 用户名/密码/密钥 |
| `du_paths` | 在 SSH 目标上执行 `du -sh *` 的目录 |
| `targets` | `type: ssh` 采集目标列表 |

各 target 的 SSH 字段可覆盖 `ssh_defaults`。仓库根的 `config.yaml` 为旧版遗留，已不再被读取。

## 维护注意

- 新增功能时同步更新 `extension/README.md` 与本文档。
- 改 `native_host/` 或扩展源码后重新 `bash package.sh` 生成安装包；开发期直接重载 `extension/` 即可（`native/` 下的编译产物只在打包时生成，源码目录里没有）。
- Go 工具链仅构建时需要（已装于 `~/.local/go`）；产物是单个 Windows .exe，运行零依赖。
- **不要提交** `config.yaml`（含 SSH 密码，已 gitignore）与 `dist/`（打包产物）。

## 故障排查速查表

| 现象 | 可能原因 |
|------|---------|
| 面板空白 | 扩展未加载；改 JS/CSS 后需在 edge://extensions 点「重新加载」+ 强制刷新侧边栏 |
| 服务器面板报 host not found | Native 宿主未注册——面板点「下载并安装 Native 宿主」，双击下载目录的 `install-edge-panel-host.bat` |
| Cursor / 知乎 403 | 浏览器里未登录对应站点（登录态 cookie 缺失）或 cookie 过期 |
| 服务器面板采集失败 | 检查设置页 SSH 服务器配置（凭据 / 网络） |
| Logshed 全红/超时 | 本机无法访问 `logshed_url`（在设置里改） |

## 编码约定

- **最小改动** — 匹配现有模式（普通函数、`credentials:"omit"` fetch、chrome.storage 缓存）。
- **密钥** — 绝不提交 `config.yaml`、SSH 密码或 Cursor cookies。
- **语言** — UI 字符串为中文；代码/注释/提交信息为英文。
- **无测试套件** — 目前没有测试，靠手动加载扩展 + 打开侧边栏验证。
