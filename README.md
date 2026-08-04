# edge-panel

Edge / Chrome **浏览器侧边栏扩展**（MV3，零构建）：个人仪表盘面板，自上而下 —— **Cursor 用量 → 服务器磁盘（SSH）→ Logshed 可用性 → 知乎阅读流**；顶栏含搜索框与时钟。

数据全部在浏览器内获取，**无需运行任何后端服务**：

- Cursor / 知乎 / Logshed **直连源站**（自动读取浏览器登录 cookie，免 CORS）
- 服务器磁盘经 **Native Messaging → Go 宿主** 按需 SSH 采集

## 功能

| 区块 | 实现方式 |
|------|----------|
| Cursor 用量 + 团队排名 | 直连 cursor.com；team_id / user_id 从 cookie 自动推导，设置里填 user_email 即可 |
| 服务器磁盘 | Native Messaging → Go 宿主按需 SSH 采集（df + du），缓存 24h 内不重复查询 |
| Logshed | 红绿状态按钮（点击重新探测） |
| 阅读（知乎） | 直连 zhihu API + 自动 cookie；归一化、去重缓存、收藏、评论都在扩展内完成 |

## 安装

### 1. 打包

```bash
bash package.sh
```

产出 `dist/edge-panel-v0.4.0.zip`（内含扩展全部文件、编译好的 Windows Native 宿主与安装脚本）。

### 2. 加载扩展

1. 解压 zip：`unzip dist/edge-panel-v0.4.0.zip -d dist/`
2. 打开 `edge://extensions/`（或 `chrome://extensions/`）→ 开启「开发人员模式」
3. 「加载解压缩的扩展」→ 选解压出的目录
4. 点工具栏图标打开右侧侧边栏

### 3. 首次设置（⚙）

- **Cursor**：`team_id` / `user_id` / `user_email`（cursor.com 账号设置里找）
- **SSH 服务器**：服务器面板的数据源（见下）
- **Logshed URL**（默认已填）
- Cookie 无需填写 —— 自动读取浏览器登录态（`WorkosCursorSessionToken`、`z_c0`）

### 4. 服务器面板（可选，需要 SSH）

在设置页「SSH 服务器」区块直接填写，或「下载配置模板」→ 填写 →「导入配置」上传（YAML / JSON 均可）。保存后，服务器面板会把配置经 Native Messaging **内联**传给 Go 宿主采集，不再需要磁盘 `config.yaml`。

若服务器区块提示「Native 宿主未安装」，点「下载并安装 Native 宿主」→ 3 个文件下到下载目录 `edge-panel-host/` → 双击 `install-edge-panel-host.bat` 完成注册，然后点 ↻ 重试。

## 目录结构

```
edge-panel/
├── package.sh              # 打包脚本（交叉编译 Go 宿主 + 扩展 → dist/*.zip）
├── extension/              # MV3 浏览器扩展（侧边栏面板，直连源站）
│   ├── manifest.json       # 清单：sidePanel/storage/cookies/downloads + host_permissions
│   ├── background.js       # 点击图标打开侧边栏 + declarativeNetRequest 动态规则
│   ├── sidepanel.html/css  # 单列布局面板
│   ├── options.html/js     # 设置页（cursor、logshed、SSH 服务器；下载模板/导入）
│   ├── config.example.yaml # 配置模板
│   ├── chart.umd.min.js    # 本地 vendored Chart.js
│   ├── cookies.js / metrics.js / logshed.js / cursor.js / feeds.js / script.js
│   └── native/             # 打包产物：edge-panel-host.exe + 安装脚本（web_accessible_resources）
├── native_host/            # Go Native Messaging 宿主源码（SSH-only）
│   ├── main.go / config.go / collect_ssh.go / go.mod
│   └── install-edge-panel-host.{ps1,bat}  # 安装脚本模板
└── config.yaml             # 旧版遗留磁盘配置（已不再被读取）
```

## 说明 / 限制

- 需 **Edge / Chrome 116+**（Side Panel API）。新标签页**自动打开**侧边栏不可行（`chrome.sidePanel.open()` 要求用户手势）；**离开新标签页自动关闭**依赖 `chrome.sidePanel.close()`（**Edge 141+**，低于 141 时静默降级）。
- **服务器磁盘**只在面板打开时采集，缓存 24h 内不重复查询（点刷新按钮强制）；不做 7×24 后台探测。Logshed 在面板可见期间每 60s 探测一次。
- 扩展页 `fetch` 无法设置 Cookie / Origin / Referer 等 forbidden headers，由 [background.js](extension/background.js) 的 `declarativeNetRequest` 动态规则在请求发出前注入（cookie 每次面板打开时从 `chrome.cookies` 刷新），fetch 统一用 `credentials:"omit"` 避免重复。若 Cursor / 知乎仍 403，通常是浏览器里未登录对应站点。
- SSH 配置保存在扩展设置页（`chrome.storage.sync`），采集时经 native 消息内联传给宿主；不再读取磁盘 `config.yaml`。宿主未注册时，扩展会引导从插件自身下载安装脚本，双击一次完成注册（MV3 无法静默写注册表）。

## 开发

改 `extension/` 下 JS/CSS 后，在 `edge://extensions` 点「重新加载」并强制刷新侧边栏即可生效（零构建）。改 `native_host/` 或需要生成新安装包时，重跑 `bash package.sh`。
