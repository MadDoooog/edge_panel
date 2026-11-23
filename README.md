# edge-panel

Edge / Chrome **浏览器扩展**（MV3，零构建）：把个人仪表盘做成**新标签页上的悬浮卡片**，另在指定的 DeepSeek 会话页显示**持仓浮层**。

- **新标签页（Ctrl+T）= 空白页 + 四张悬浮卡片**：Cursor 费用 / 服务器磁盘 / Release Matrix 状态 / 蓝牙电量 —— 可拖动、可折叠，位置与折叠状态记忆在你自己的浏览器里
- **DeepSeek 会话页 = 持仓浮层**：默认收成一颗悬浮球 `[● 持仓 | ⧉ | ⌄]` —— 圆点表示状态（绿=在带内 / 橙=出带 / 红=行情失败），**点「持仓」直接把它作为 .txt 附件发到输入框**（成功就继续待在球里，没成功自动展开卡片），`⧉` 复制快照，`⌄` 展开看明细（持仓明细、合计、四类占比、出带信号）。卡片里还有「复制 / 填入 / 转附件」三个动作。配色跟随 DeepSeek 自己的浅色/深色主题
- **点工具栏图标 = 打开设置页**
- **无后端服务、无 7×24 后台任务**：数据只在新标签页打开期间获取，SSH 采集由扩展后台持有（关页面也会继续）

数据来源：

- Cursor 用量 / 行情 **直连源站**（`host_permissions` 免 CORS；Cookie 与 Referer 由 background 的 `declarativeNetRequest` 动态规则注入）
- 服务器磁盘走 **Native Messaging → Go 宿主** 按需 SSH 采集（df + du）；**蓝牙电量**同样经宿主（扩展拿不到本机硬件），宿主在浏览器所在的 Windows 上用 PowerShell 查「已连接设备 + 电量」

## 功能

| 位置 | 内容 | 实现方式 |
|------|------|----------|
| 新标签页卡片 | Cursor 用量 + 团队排名 | 直连 cursor.com；team_id / user_id 从 cookie 自动推导，设置里填 user_email 即可；图表按最近 30 天，芯片最前面另显示「**本月消耗**」（Cursor 自己返回的账期）；10 分钟缓存 |
| 新标签页卡片 | 服务器磁盘 | Native Messaging → Go 宿主 SSH 采集（df + du）；宿主流式上报进度、采集由后台持有；24h 内不重复查询 |
| 新标签页卡片 | 蓝牙电量 | 经 Native Messaging 问 Go 宿主；宿主用 PowerShell 读 WinRT 的「已连接」设备 + PnP 的 `DEVPKEY_Bluetooth_Battery` 电量，**只列此刻连着的设备**，余量 ≤20% 红、>20% 绿；60s 缓存，页面挂着时 2 分钟刷一次 |
| 新标签页卡片 | Release Matrix 状态 | 直连 cygnus 的 DataTables 取数接口（`POST /release_matrix/releases/index`，Cookie/Referer 由 background 的 DNR 注入、`X-CSRFToken` 取 `csrftoken` cookie），每行按 **region - version - PBF - NGX - QA-NGX** 展示；`version` 参数在设置页配置（默认 `26q3`，多个用英文逗号分隔，如 `26m10w2,26m10w1`）；5 分钟缓存 |
| DeepSeek 会话页 | 持仓浮层 | 仅在设置为指定会话 id 的会话页显示；行情经后台代理（腾讯+新浪双源互验）、算术与快照文本在本地 |
| 安居客地图找房页 | 户型浮层 + 贝壳比价 | 地图气泡下方挂「**详情**」按钮，点开面板**自动**调 `LoudongHuxing` 接口取全部户型（表格只列 **户型/面积/总价**），面板下半部再叠一层**第三方信息源** —— 贝壳 `m.ke.com`：按小区名搜到贝壳小区后取该小区在售二手房前 10 条（户型/面积/总价/单价/标签），并给出「贝壳挂牌中位 vs 安居客小区均价」；按钮文字随即刷新成 `2/2/1-95平-92万|3/2/2-96平-144万` 缩略摘要；取数参数由 background 用 `webRequest` **观察页面自己调的** `mapNewlist` 请求取得，再由 background 代取纯 JSON 推回浮层 |
| 设置页 | 配置 | 点工具栏图标打开；分块默认折叠，点标题展开。Cursor 标识、Matrix version/region/环节、持仓、SSH 服务器 |

## 安装

### 1. 打包

```bash
bash package.sh
```

产出两个包（都内含扩展全部文件、编译好的 Windows Native 宿主与安装脚本）：

- `dist/edge-panel-v0.7.0.zip` —— 外层带一层 `edge-panel-v0.7.0/`，**首次安装**用
- `dist/edge-panel-v0.7.0-flat.zip` —— 顶层直接是扩展文件，**原地覆盖升级**用：解压进你当前已加载的那个目录并覆盖，路径不变 → 扩展 ID 不变 → `storage.sync` 配置与 Native 宿主注册都保住

### 2. 加载扩展

1. 解压：`unzip dist/edge-panel-v0.7.0.zip -d dist/`
2. 打开 `edge://extensions/`（或 `chrome://extensions/`）→ 开启「开发人员模式」
3. 「加载解压缩的扩展」→ 选解压出的目录
4. 按 **Ctrl+T** 打开新标签页，应看到三张悬浮卡片

> 覆盖升级时**务必保持目录路径不变**：Edge/Chrome 给解压缩扩展分配的 ID 由目录路径算出，换路径 = 新 ID = 配置清空 + Native 宿主需重新注册。

### 3. 首次设置（点工具栏图标）

- **Cursor**：`team_id` / `user_id` / `user_email`（通常只需填 user_email，其余从 cookie 推导）
- **Release Matrix**：`version` —— 即取数接口的 `version` 过滤参数（如 `26q3` 或 `26m10w2,26m10w1`）；需先在浏览器登录 cygnus.telenav.com，Cookie 自动读取
- **持仓**（可选）：DeepSeek 会话 id + 持仓列表（代码/类别/份额/成本/对账日）+ 应急金与可投资现金腿 + 目标占比与带宽
- **SSH 服务器**：服务器磁盘卡片的数据源
- Cookie 无需填写 —— 自动读取浏览器登录态

### 4. 服务器卡片（可选，需要 SSH）

在设置页「SSH 服务器」区块直接填写，或「下载配置模板」→ 填写 →「导入配置」上传（YAML / JSON）。保存后采集时经 Native Messaging **内联**传给 Go 宿主，不读磁盘 `config.yaml`。

若卡片提示「Native 宿主未安装」，点「下载并安装 Native 宿主」→ 3 个文件下到下载目录 `edge-panel-host/` → 双击 `install-edge-panel-host.bat` 完成注册，然后点 ↻ 重试。

## 目录结构

```
edge-panel/
├── package.sh              # 打包脚本（交叉编译 Go 宿主 + 扩展 → dist/*.zip）
├── extension/              # MV3 浏览器扩展（零构建）
│   ├── manifest.json       # 清单：newtab 覆盖 + content_scripts + host_permissions
│   ├── background.js       # 图标点击开设置页 + DNR 头注入 + SSH 采集持有者 + 行情取价代理
│   ├── newtab.html/css/js  # 新标签页悬浮仪表盘（Cursor / 磁盘 / Matrix / 蓝牙 四张卡片）
│   ├── options.html/js     # 设置页（可折叠分块：cursor、Matrix、持仓、SSH；下载模板/导入）
│   ├── deepseek-overlay.js # content script：DeepSeek 会话页持仓浮层（只读 + 复制快照）
│   ├── anjuke-overlay.js   # content script：安居客地图找房气泡户型浮层（标签 + 面板 + 调接口补齐）
│   ├── yaml.js             # 极简 YAML 子集解析器（「导入配置」用）
│   ├── config.example.yaml # SSH 配置模板
│   ├── chart.umd.min.js    # 本地 vendored Chart.js
│   ├── cookies.js / metrics.js / cursor.js
│   └── native/             # 打包产物：edge-panel-host.exe + 安装脚本（web_accessible_resources）
├── native_host/            # Go Native Messaging 宿主源码（SSH 采集 + 蓝牙电量）
│   ├── main.go / config.go / collect_ssh.go / go.mod
│   └── install-edge-panel-host.{ps1,bat}  # 安装脚本模板
└── config.yaml             # 旧版遗留磁盘配置（已不再被读取）
```

## 说明 / 限制

- 需 Chrome / Edge **101+**（MV3 + 可构造样式表）。
- **外观跟随浏览器主题**：亮/暗由 `prefers-color-scheme` 自动切换，取色贴近浏览器原生界面（`extension/theme.css`）；Cursor 图表配色也跟着主题走。
- **设置页只有一个「保存」按钮**，一次写入 Cursor / Matrix（version/region/环节）/ SSH（`storage.sync`）与持仓（`storage.local`）；保存后回读存储显示「实际存进去了什么」。各分块默认折叠，点标题栏展开。
- **新标签页被本扩展接管**（`chrome_url_overrides.newtab`）—— 这是让卡片"浮在空白页上"的唯一稳妥做法：扩展无法向 `about:blank` 注入脚本。想恢复默认新标签页就在 `edge://extensions` 里停用本扩展。
- **侧边栏已移除**（不再需要 Side Panel API）：四张卡片在新标签页，持仓在 DeepSeek 页，设置页点图标打开。
- 卡片位置/折叠状态存 `chrome.storage.local`（`newtabCards`）；持仓配置同样存 local（含金额，**不**随浏览器账号上云）；Cursor / Matrix / SSH 配置仍在 `chrome.storage.sync`（Matrix 取数结果缓存 `matrixReleases` 在 local，5 分钟）。
- **Release Matrix 卡片**取数在 background：`POST https://cygnus.telenav.com/release_matrix/releases/index` 是 Django 的 DataTables serverSide 接口，**必须带** `Referer`（HTTPS CSRF 校验，缺了直接 403）、Cookie（SameSite=Lax，扩展发的跨站请求带不上 → DNR 注入）、`Origin`（Chrome 自动加的 `chrome-extension://<id>` 会被站点判 403，DNR 覆盖回站点 origin）与 `X-CSRFToken`（值就是 `csrftoken` cookie 原文，Django 同时接受 32 位未掩码 secret）；三者都来自**同一次** `chrome.cookies` 读取，避免 cookie 轮换导致 403。`version` / `region` / 环节（表格列，如 `PBF,NGX,QA-NGX`）都在设置页配，逗号分隔；`version` 还能在卡片头上直接点改，改完自动刷新。
- **服务器磁盘**由扩展后台（service worker）经 `connectNative` 发起采集，宿主流式上报进度（逐服务器 + 每 10s 心跳保活），因此**关掉新标签页采集仍继续**；进度持久化在 `chrome.storage.local`，重新打开时先显示「正在采集到 xx」。
- 扩展页 `fetch` 无法设置 Cookie / Origin / Referer 等 forbidden headers，统一由 [background.js](extension/background.js) 的 `declarativeNetRequest` 规则注入（cursor cookie 每次打开新标签页时从 `chrome.cookies` 刷新；新浪行情强制要求 Referer）。**content script 的 fetch 受页面源 CORS 约束**，所以持仓浮层的行情一律经 background 代理。
- **安居客地图找房浮层**（`anjuke-overlay.js`）：气泡是纯 DOM（`div.mark.mark-point`），但**地图平移时会回收复用这些节点**，所以重扫靠「文本比对 + rAF 节流」做幂等。取数参数不是猜的 —— background 用 `webRequest`（MV3 只能观察、不能拦截）**看页面自己发的那条请求**，抄下 bbox/zoom/筛选后再由 background 取纯 JSON（该接口不返回 CORS 头，content script 自己 fetch 会被页面源 CORS 拦）。
- **安居客气泡里叠了第三方信息源（贝壳）**：安居客只给楼盘，贝壳给同一小区的**在售二手房挂牌价**，两者拼在一个面板里才能比价。取数两段：贝壳 sug 联想接口（**不需要登录**，按 `城市` 路径段限定，城市取自安居客主机首段 `xa.fang.anjuke.com` → `xa`）找到小区 → 小区二手房页（**必须带登录 cookie**，否则 302 到 `hip.ke.com` 风控验证页，或 200 但房源列表为空）。房源在 HTML 的 `window.__PRELOADED_STATE__` 里（服务端预加载，不用跑 JS）。**两个坑**：① 小区页路径 `/<city>/ershoufang/c<id>/` 城市段夹在中间，DNR 的 `urlFilter` 是连续匹配、写 `||m.ke.com/ershoufang/c` 永远匹配不上（表现为 cookie 注不进去 → 一律风控），必须用 `regexFilter`；② 该站风控**拒绝没有 User-Agent 的请求**，浏览器自带所以线上无碍，但离线用 node/curl 复现时必须补 UA，否则会得出假的「被风控」结论。风控敏感，所以只在点开气泡面板时按小区取一次，缓存 6 小时，连续失败 2 次自动熔断改手动。
- 安居客全量户型走专用接口 `GET {origin}/aifang/web/ajax/LoudongHuxing/?loupan_id=<id>`（与地图页**同源**、需 `x-requested-with: XMLHttpRequest`）—— 地图接口自带的 `house_types` **服务端写死最多 3 条**。响应结构未公开，解析器**不依赖字段名**（递归找「带房型串」的对象），解析不出会把原始响应打到 console；兜底顺序：接口 → 详情页 HTML 文本特征 → 同源 iframe；详情页若前端渲染拿不到，用**同源 iframe** 渲染后读 `contentDocument` 兜底（该站 CSP `frame-ancestors` 允许 `*.anjuke.com`）。户型提取**不依赖 class 名**，按「房型+面积+总价」文本特征聚类，页面改版不易失效。参考总价 = 面积 × 均价（接口不给总价，显示时带 `~`）。
- 历史：项目最初是 FastAPI 后端 + 新标签页前端的 Python 服务，后迁移为侧边栏扩展；现已回到新标签页形态，并移除了 Logshed 探测与知乎阅读流。

## 开发

改 `extension/` 下 JS/CSS/HTML 后，在 `edge://extensions` 点「重新加载」，然后刷新新标签页即可生效（零构建）。改 `native_host/` 或需要生成新安装包时重跑 `bash package.sh`。
