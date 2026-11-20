# AGENTS.md — edge-panel

面向 AI 智能体与贡献者的仓库开发指南。

## 项目简介

`edge-panel` 是一个 **纯浏览器扩展**（MV3，零构建，改 JS/CSS/HTML 直接生效），把个人仪表盘做成**新标签页上的悬浮卡片**，并在指定的 DeepSeek 会话页显示**持仓浮层**。

- **新标签页**（`chrome_url_overrides.newtab`）：空白页上浮三张卡片 —— **Cursor 费用 / 服务器磁盘 / Release Matrix 状态**，可拖动、可折叠、位置记忆
- **DeepSeek 会话页**（content script）：**持仓浮层** —— 默认是「持仓」悬浮球，点开是卡片；份额/成本手工录入，现价经 background 从腾讯+新浪双源拉取互验，市值/浮盈/四类占比本地算，「复制快照」或「填入输入框」
- **安居客地图找房页**（content script）：**户型浮层** —— 地图气泡下挂「**详情**」按钮；点开面板**自动**调 `LoudongHuxing` 接口取全部户型（表格只列 **户型/面积/总价** 三列），标签文字随即就地刷新成 `2/2/1-95平-92万|3/2/2-96平-144万` 这样的缩略摘要（`|` 分隔，最多 `BADGE_MAX_ITEMS` 条，超出 `…+N`，完整列表在 `title` 与面板里）
- **点工具栏图标 = 打开设置页**；**没有侧边栏**（Side Panel API 与相关权限已移除）
- 扩展**直连源站**（Cursor / 行情，免 CORS）；登录态自动读取浏览器 cookie
- 服务器磁盘（SSH）走 **Native Messaging → Go 宿主**（`native_host/`）按需采集
- **无后端服务、无 7×24 后台任务** —— 数据只在新标签页打开期间获取；SSH 采集由 background 持有，关页面也会继续

**历史：** 项目最初是 FastAPI 后端 + 新标签页前端的 Python Web 服务 → 迁移为「侧边栏扩展」→ 现回到新标签页形态，并移除了 Logshed 探测与知乎阅读流（`logshed.js` / `feeds.js` / `sidepanel.*` / `script.js`）。

## 目录结构

```
edge-panel/
├── package.sh              # 打包：交叉编译 Go 宿主 → 扩展+宿主+安装脚本 → dist/*.zip
├── extension/              # MV3 浏览器扩展（零构建）
│   ├── manifest.json       # 清单：newtab 覆盖 + content_scripts + host_permissions + WAR
│   ├── background.js       # 图标点击开设置页 + declarativeNetRequest 头注入 + SSH 采集持有者 + 行情取价代理
│   ├── theme.css           # 设计令牌 + 基础控件（亮/暗跟随系统，贴近浏览器原生观感）
│   ├── newtab.html/css/js  # 新标签页悬浮仪表盘（三张卡片：拖动/折叠/位置持久化）
│   ├── options.html/css    # 设置页（可折叠分块 + 左标签右控件 + 单行字段网格）
│   ├── deepseek-overlay.js # content script：DeepSeek 会话页持仓浮层（悬浮球 + 卡片；复制/填入输入框）
│   ├── anjuke-overlay.js   # content script：安居客地图找房气泡户型浮层（标签 + 面板 + 调接口补齐）
│   ├── yaml.js             # 极简 YAML 子集解析器（「导入配置」用）
│   ├── config.example.yaml # SSH 配置模板（设置页「下载配置模板」）
│   ├── chart.umd.min.js    # 本地 vendored Chart.js（避开扩展页 CSP）
│   ├── cookies.js / metrics.js / cursor.js
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
#   （改 JS/CSS 后点「重新加载」，再刷新新标签页即可生效；零构建）
# 打包（交叉编译 Windows Native 宿主 + 扩展）：
#   dist/edge-panel-v<ver>.zip       首次安装（外层带一层同名目录）
#   dist/edge-panel-v<ver>-flat.zip  原地覆盖升级（无外层目录，解压进当前已加载目录）
bash package.sh
# 改 native_host/ 或要生成新安装包时重跑 bash package.sh。
```

## 关键约束（改扩展代码前必读）

- **扩展页 `fetch` 无法设置 Cookie / Origin / Referer 等 forbidden headers** —— 由 [background.js](extension/background.js) 的 `declarativeNetRequest` 动态规则在请求前注入（cursor cookie 每次打开新标签页时经 `refresh-auth` 刷新），所有直连 fetch 用 `credentials:"omit"` 避免 cookie 重复。新增直连源站时同步更新 DNR 规则。现有规则 id：**1** cursor 排名、**2** cursor dashboard API（`/api/dashboard/` 整个命名空间：`get-monthly-billing-cycle` 账期 + `get-filtered-usage-events` 用量事件）、**4** 新浪行情 Referer、**5** cygnus（Release Matrix 取数的 cookie + Origin + Referer）、**6** 贝壳小区页（只注入 cookie）；**3 = 已删除的知乎规则**，仅在 `removeRuleIds` 里保留以清理旧安装残留。
- **content script 的 `fetch` 受页面源 CORS 约束**，扩展 `host_permissions` 对它**不生效**，行情接口也不返回 CORS 头 —— 因此 `deepseek-overlay.js` 的取价必须走 background 代理（`{type:"finance-quotes"}`），不能在浮层里直接 fetch。腾讯行情是 **GBK**，必须 `TextDecoder("gbk")`；新浪行情缺 Referer 会 403（实测），靠 DNR 规则 4。
- **安居客浮层的取数参数靠 `webRequest` 观察，不靠注入页面世界**（改 `anjuke-overlay.js` / `background.js` 前必读）：地图页自己用 jQuery JSONP 调 `api.fang.anjuke.com/web/loupan/mapNewlist/`，该接口**不返回任何 `Access-Control-*` 头**，所以 content script 不能自己 fetch；background 用 `chrome.webRequest.onBeforeRequest`（**MV3 只能观察、不能拦截**）抄下那条请求 URL 里的 `bbox/zoom/筛选`，再用同参数取纯 JSON（去掉 `callback` 就是纯 JSON，`page_size` 服务端硬上限 100）推回浮层。这样零页面上下文代码、不依赖页面用的 jQuery 内部实现，也不用把 `minimum_chrome_version` 抬到 `world:"MAIN"` 要求的 111 —— **manifest 的 `webRequest` 权限和 `*://api.fang.anjuke.com/*` host 权限不能删**。接口实测**不需要 cookie / Referer**，故不新增 DNR 规则。
- **安居客气泡的 DOM 特性**：气泡是 `div.mark.mark-point`（纯 DOM，无 canvas/iframe），坐标是内联 `left/top`；**地图平移会回收复用这些节点**（只改 `style` 与文本，不增不删）→ `MutationObserver` 必须同时监听 `attributes`（`attributeFilter:["style","class"]`）+ `characterData`，且重扫必须幂等（`markText()` 文本比对 + `rAF` 节流）。**读气泡文本必须用 `markText()` 排除自己注入的标签/面板**，否则标签文字会被读回来污染名称解析（实测会退化成前缀匹配）。价格单位是 **`m²`(U+00B2)**，不是 `㎡`(U+33A1)。楼盘名与价格**连写无分隔符**（`浐灞1016000元/m²`）→ 名称匹配三级：剥价格精确 / 原文精确 / 索引最长前缀。DOM 上拿不到 `loupan_id`，只能靠名字匹配。
- **安居客全量户型走专用接口，不要解析详情页 HTML**：`GET {origin}/aifang/web/ajax/LoudongHuxing/?loupan_id=<id>` —— 与地图页**同源**（content script 直接 fetch 即可，cookie 自动带），需要 `x-requested-with: XMLHttpRequest`（该头**不是** forbidden header，content script 和 background 都能设）。地图接口自带的 `house_types` **服务端写死最多 3 条**（加 `loupan_id` 过滤无效，实测），要全部户型就调这个接口。
  - 该接口**响应结构未公开**，所以 `parseHouseTypes()` 写成**不依赖字段名**：递归遍历 JSON（深度 ≤8），凡是「自己身上带着房型串（`3室2厅2卫` / `5居室`）」的对象就当一条户型记录，再从候选键名里取面积/总价/朝向。候选键：面积 `area|build_area|jianzhu_area|area_size|mianji|size|…`、总价 `total_price|zongjia|total_amount|…`、均价 `price|avg_price|…`、朝向 `orient|chaoxiang|…`。字段名对不上时会把**原始响应打 1500 字到 console**，照着写死映射即可（`window.__edgePanelAnjuke.parseApi(json)` 可离线验解析）。
  - 两个已踩过的坑：① **拼接式字符串**（`3室2厅2卫/105㎡`）只在**自带面积**时才认，否则会和对象分支抓到的同一条重复一遍（空面积那次）；② `price` 一般是**均价**（元/m²），但有的响应里放的是**总价** —— 按量级判（均价现实中到不了 30 万/㎡，`≥ 300000` 就当总价），否则留给 `面积×均价` 推导并在显示时带 `~`。
  - 兜底顺序：**户型接口 → 详情页 HTML 文本特征聚类 → 同源 iframe 渲染读 DOM**。详情页与地图页同源、前端渲染读不到时用同源 iframe（该站 CSP `frame-ancestors` 允许 `*.anjuke.com`）；HTML 提取**不依赖 class 名**，按「房型 + 面积 + 总价」文本特征聚类。`rec.via` 会标出这次数据是 `api` / `html` / `iframe` 哪条路来的。
- **「空白页悬浮卡片」只能靠接管新标签页实现** —— 扩展无法向 `about:blank` 注入脚本，`chrome_url_overrides.newtab` 是唯一稳妥做法。改 `newtab.*` 就是改整个仪表盘。
- **扩展目录路径不能变**：Edge/Chrome 给解压缩扩展分配的 ID 由**目录绝对路径**算出（manifest 无 `key`）。换路径 = 新 ID = `storage.sync` 配置清空 + Native 宿主 `allowed_origins` 失配（服务器卡片报 host not found，需重跑 `install-edge-panel-host.bat`）。**原地覆盖升级**是正确姿势。
- **content script 边界**（`deepseek-overlay.js`）：**不读对话内容、不自动发送**；挂载判定**只看 URL**（`/a/:agentId/s/:sessionId`），不依赖页面 DOM 选择器；样式用 Shadow DOM + `adoptedStyleSheets` 隔离，配色跟随 **DeepSeek 自己的浅色/深色**（采样页面实际背景色，2s 轮询，非浏览器主题）。写页面的动作只有用户点击才发生：**填入**（合成一次 `paste` 事件让 DeepSeek 自己决定"文本 / 转 .txt 附件"；它不接管时用 `execCommand("insertText")` 或原生 setter + `input` 事件追加文本）与**转附件**（`file input` 注入 `File` + 派发 `change`）。**两条路都失败就退回剪贴板，绝不静默**。默认形态是「持仓」悬浮球，点开才是卡片。
- **Release Matrix 取数靠 DNR 规则 5，且 cookie 与 CSRF token 必须同源**：`POST https://cygnus.telenav.com/release_matrix/releases/index` 是 Django 的 DataTables serverSide 接口，实测三件事缺一不可 —— ① Cookie（SameSite=Lax，扩展发的跨站请求带不上 → 只能 DNR 注入）② `Referer`（Django 对 HTTPS 请求做 CSRF 校验，没 Referer 直接 403）③ `Origin` —— **Chrome 对跨源 POST 会自动加 `Origin: chrome-extension://<id>`，而该站点只要 Origin 不等于站点自身就 403**（实测：`chrome-extension://…` → 403、`Origin: null` → 403、站点 origin → 200、**完全不发 Origin → 200**），所以 DNR 必须用 `set` 把它覆盖回 `https://cygnus.telenav.com`）④ `X-CSRFToken`（**值可以直接用 `csrftoken` cookie 原文**：Django 同时接受 32 位未掩码 secret 与 64 位掩码 token，因此不必刮页面 HTML）。**漏掉 ③ 是上线后唯一的 403 原因** —— 本地用 node/curl 验证时不会自动带 Origin，会「假绿」，离线测试必须自己补上 `Origin: chrome-extension://<id>` 再套 DNR 规则。取数放在 **background** 而不是新标签页，就是为了让 DNR 注入的 cookie 与 header 里的 token 来自**同一次** `chrome.cookies` 读取（`updateAuthRules()` 现在返回 `{cursorCookie, cygnusCookie}`）—— 分两次读会在 csrf cookie 轮换时 403。请求体必须**照抄 DataTables 的序列化**（`columns[…]` / `order[0]` / `search[value]` 全都要，少一个服务端返回 0 行而不报错）；面板列 `region-version-<环节…>` 里 region/version 行内没有独立字段，只能从行名 `PRODUCT-REGION-VERSION-<14 位时间戳>` 拆（`parseReleaseName`），各环节状态取 `nodes[<环节>].status`（环节名来自 `releaseMatrixStages`，大小写不敏感匹配）。manifest 的 `*://cygnus.telenav.com/*` host 权限不能删（DNR modifyHeaders 与 `chrome.cookies` 都依赖它）。
- **贝壳二手房是安居客气泡里的「第三方信息源」，规则 6 的过滤器只能用正则**：sug 联想接口 `GET /mensa/<city>/sug/index?channel=ershoufang&query=<小区名>` **不需要任何 cookie/Referer/UA**，返回小区 id/在售套数/region/mUrl，`<city>` 段起城市限定作用（`bj`/`xx` → 0 条），取安居客主机首段（`xa.fang.anjuke.com` → `xa`）；小区二手房页 `/xa/ershoufang/c<id>/` 则**必须带登录 cookie**（不带 → 302 到 `hip.ke.com/captcha` 风控页；只带访客 cookie → 200 但 `__PRELOADED_STATE__.ershoufangList.list` 为空；带 `lianjia_token`+`security_ticket` → 完整数据），房源就在 HTML 的 `window.__PRELOADED_STATE__` 里（服务端预加载，不用跑 JS）。**坑一**：小区页路径是 `/<city>/ershoufang/c<id>/`，城市段夹在中间，`urlFilter` 是连续匹配，写 `||m.ke.com/ershoufang/c` 永远匹配不上（表现为 cookie 注不进去 → 一律 302 风控），必须用 `regexFilter`。**坑二**：该站风控**拒绝没有 User-Agent 的请求**（无 UA → 302 风控）—— 浏览器 fetch 自带 UA 所以线上没事，但用 node/curl 离线复现时必须自己补 UA，否则会得出假的「被风控」结论。风控敏感：只在用户点开气泡面板时按小区取一次，`城市|小区名` 缓存 6h，连续失败 2 次后**暂停自动取数**（`BEIKE_COOLDOWN_MS=3 分钟` 冷却后自动恢复，不是永久闩死；`force=true` 的手点不受限）。**失败必须带上一次的真实原因**：踩过「只回一句『已暂停自动取数』」的坑 —— 用户看到面板失败却不知道为什么（真实原因是更早那两次失败的报错被覆盖了）；现在 `beikeLastError` 会拼进冷却提示，且**只有真实尝试才计数**（冷却自身不再累加，否则 3ms 拒绝也会把计数刷到 3、4…）。**读 cookie 必须同时用 `{url}` 与 `{domain}` 再合并**（`readCookies(url, domain)`）：`{url}` 只返回**路径也匹配**的 cookie，站点把登录 token 设在子路径（Path=/xxx）时就读不到 —— 实测踩过「明明在另一个 tab 登录着、却被判成没登录」。同名冲突以 `{url}` 那份为准。两个坑：① `{domain}` 查询在 host 权限不足时会**抛错**，必须各自 `.catch` 成空数组（早期写成 `Promise.all` 会把 url 那份一起打成空 → cursor/cygnus/ke 三个源站的头注入全废）；② manifest 因此补了 `*://ke.com/*` 与 `*://*.ke.com/*`。**登录态检查只作提示，绝不拦请求**：`hasLoginMark`（`lianjia_token|security_ticket|login_ucid`）只影响报错文案 —— 用名字猜登录态去 throw 会把本可成功的请求挡死（用户实测第二条：面板说"缺 lianjia_token"，可浏览器里登录着、站点也正常）。只有「一个 cookie 都读不到」才快速失败（那种情况下站点必然 302）。第二段的失败文案按情况区分：没有 cookie → 「请用本浏览器打开一次 m.ke.com（并登录）」；跳 `hip.ke.com` → 「被风控拦截」；200 但列表为空 / 没有 `__PRELOADED_STATE__` → 「该小区可能确实没有在售，或登录态没被读到」并附上**读到的 cookie 名称清单**（只列名字，绝不含值）。**贝壳区块的状态机有一条硬规则：没有记录 ≠ 查询中**（踩过：无记录也渲染成 loading，于是自动取数被熔断、或回调丢失时，面板会永远停在「查询中」而其实一个请求都没发 —— 用户实测报的就是这个）。现在五个状态各有明确文案：`ok`（N 套在售 · 区域）/ `loading`（查询中…）/ `idle`（未查询 或 已暂停自动取数）/ `stall`（超过 `BEIKE_STALL_MS=20s` 没结果 → 查询超时 + 提示手点）/ `miss`·`fail`（带原因）；渲染层整块包 try/catch，抛错也只显示「贝壳区块出错」而不是半渲染卡住。background 两段请求各有硬超时（sug 10s / 小区页 15s，`fetchWithTimeout` + AbortController），所以 fetch 拖住一定会给出结论。调试：`window.__edgePanelAnjuke.beike()` 看 `{city, fails, blockedSeconds, lastError, cache[]}`，`beikeRetry(name)` 强制重查。
- **存储分区**：Cursor / Matrix / SSH 配置在 `chrome.storage.sync`；**持仓配置（`financeConfig`）与卡片位置（`newtabCards`）在 `chrome.storage.local`** —— 含金额，不要挪到 sync（sync 会同步到浏览器账号云端）。Matrix 取数结果缓存 `matrixReleases`（5 分钟）与贝壳小区缓存 `beikeCommunities`（6 小时）也在 local。
- **Native 宿主必须在浏览器所在系统运行**（Windows 版 Edge → Windows 侧）。native messaging 只能拉起浏览器本机的进程。宿主与安装脚本由 `package.sh` 交叉编译后随扩展包分发，安装时由扩展从插件资源下载、用户双击 `install-edge-panel-host.bat` 用 `reg.exe` 注册 `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\`。
- 扩展页默认 CSP `script-src 'self'` —— 脚本必须用外部 `.js`，**不要内联脚本**（样式同理：页面只 `<link>` 外置 CSS，不写内联 `<style>`）。
- **外观统一走 `theme.css` 的 CSS 变量**（`prefers-color-scheme` 切亮/暗，取色贴近浏览器原生界面）：新标签页与设置页都引用它，**不要在页面里硬编码颜色**。`newtab.js` 的图表配色是运行时从这些变量读的（`themeColors()`），系统主题变化时重绘 —— 新增图形沿用这个模式。唯一例外是 `deepseek-overlay.js`：它浮在别人的网页上、样式内联在 JS 里，配色跟随 **DeepSeek 自己的浅色/深色**（采样页面背景色），不走 `theme.css`。
- 定时刷新只在新标签页打开期间进行（`newtab.js`）；无 7×24 后台探测。唯一例外：SSH 采集由 **background service worker** 持有（`chrome.runtime.connectNative` → 宿主流式上报进度 + 每 10s 心跳保活 SW），关页面后采集继续，完成后即止。

## 扩展模块

- `extension/newtab.js` — 新标签页编排：卡片拖动/折叠/位置持久化（`newtabCards`）+ Cursor 图表（Chart.js，**主口径仍是最近 30 天**；芯片区最前面额外一个「本月消耗」= `get-monthly-billing-cycle` 账期内事件的 `chargedCents` 合计，账期取不到就显示「—」，不影响 30 天曲线）+ 服务器磁盘渲染（采集进度、宿主安装引导）+ Matrix 状态表（渲染 background 取回的 release 列表，列 `region-version-<环节…>`；三个参数都在设置页配：`releaseMatrixVersion` / `releaseMatrixRegion` / `releaseMatrixStages`，均逗号分隔；**卡头上的 version 点一下就地编辑**，Enter/失焦保存到 sync 并自动强制刷新，Esc 取消；↻ 强刷，页面挂着时每 5 分钟对一次）
- `extension/deepseek-overlay.js` — content script：持仓浮层。**默认收成「持仓」悬浮球**：`[● 持仓 | ⧉ | ⌄]` —— 圆点=状态（绿在带内/橙出带/红行情失败）；**点圆点+「持仓」= 直接转附件**（成功留在球里，没进附件通道就自动展开卡片让用户换按钮）；`⧉` 复制快照；`⌄` 展开看明细。整块可拖动。卡片三个动作：**复制**、**填入**、**转附件**。
  - **「长文本自动转 .txt 附件」是 DeepSeek 自己的逻辑**（`onPaste` 里：`pastedText.length > pasteTextToFileLimit && canAddFile` → `preventDefault()` + `new File([text], "<首行≤50字>.txt", {type:"text/plain;charset=utf-8"})` + `fileSource:"paste"` 上传）。阈值是**运行时 config，前端 bundle 里没有字面量**，无法静态得知。
  - 因此「填入」= **合成一次真实粘贴**（`new ClipboardEvent("paste",{clipboardData: dt})`）让 DeepSeek 自己判断；`dispatchEvent()` **返回 false 就等于它接管了（已转附件）**，因为它只在转附件那条分支调用 `preventDefault()`。「转附件」= 先走同一条粘贴路径，它没接管再用 **file input 注入**（`new File(...)` → `input.files = dt.files` → 派发 `change`）兜底，确保一定进文件通道。
  - 附件文件名由**快照首行**派生（DeepSeek 会删掉 `\ / : * ? " < > |`，所以首行只放日期不放 `16:15` 这样的时间）。`derivedFileName()` 复刻了这条规则。
  - 三条通道都用 `attachmentVisible()`（轮询页面里是否出现文件名）与输入框回读来**确认结果**，失败一律退回剪贴板，绝不静默。
  - `window.__edgePanelFinance` 是隔离世界里的调试钩子（页面脚本不可见）：`setTestState(cfg, quotes)` + `buildSnapshot()` 验算术、`deliverToComposer()`/`derivedFileName()` 验投递通道、`matchSession(pathname)` 验挂载判定、`detectPageTheme()` 验主题采样
- `extension/anjuke-overlay.js` — content script：安居客「地图找房」气泡户型浮层。气泡（`div.mark.mark-point`）下方挂小标签 `2/2/1-95平-92万`（房型/面积/参考总价，取接口自带的 `house_types`）；标签**默认只显示「详情」**（不再回显地图接口那 3 条）；点开 Shadow DOM 面板会**自动**调 `LoudongHuxing` 取全部户型，表格只列 **户型/面积/总价**，加载成功后标签就地刷新成 `|` 分隔的缩略摘要（详情未到/失败时保持「详情」；失败给「重试」按钮，`rec.via` 标明来源是 `api` / `html` / `iframe`）。取数参数由 background 的 `webRequest` 观察页面自己的 `mapNewlist` 请求得到，数据由 background 取纯 JSON 推回（`{type:"ajk-rows"}`）；详情页 HTML 由浮层同源 fetch，失败再走 background 代理（`{type:"ajk-fetch-text"}`）。面板下半部是**贝壳二手房第三方信息源**（`{type:"beike-community"}`，见「关键约束」）：点开面板自动查一次（6h 缓存、失败熔断），显示在售套数、前 10 条（户型/面积/总价/单价/标签）与「贝壳挂牌中位 vs 安居客小区均价」对比，可手点「查贝壳」强刷，也可整行点进贝壳。**面板尺寸**：两个列表都封顶 **5 行**（`.tbl` 容器 + `thead th { position: sticky }`，超出在**列表内**滚动，`--row-h/--head-h` 按各自行高算出「5 行 + 表头」），面板整体 `max-height: calc(100vh - 48px)` 兜底；`fitPanel()` 在每次刷新后测量，**下方放不下就把面板翻到气泡上方**（直接改 host 的行内 style —— 定位是行内写死的，`:host` 规则压不过它），并绑定 resize 重算。户型接口最多见过 26 条，正是把面板撑出屏幕的场景。日志前缀 `[ajk-overlay]` / `[ajk-bg]`，调试钩子 `window.__edgePanelAnjuke`（`dump()` 看逐气泡名称匹配率、`detail(id)` 手动抓某个楼盘）。
- `extension/background.js` — 图标点击开设置页 + DNR 头注入 + **SSH 采集持有者**（connectNative 流式接收宿主进度 → 持久化 `metricsProgress` 并广播）+ **行情取价代理**（腾讯+新浪双源互验、GBK 解码、按开市/休市分档缓存）
- `extension/metrics.js` — 页面侧辅助：采集缓存/进度读写（`metrics` / `metricsProgress`）、宿主安装引导、错误识别；不直接 connectNative
- `extension/cookies.js` — `chrome.cookies` 读取辅助（cursor.com 的 `WorkosCursorSessionToken`）
- `extension/cursor.js` — cursor.com 直连（数据函数带 `*Api` 后缀）；含 403 自愈重试
- `extension/options.html/js` + `options.css` — 设置页（浏览器设置页风格：**分块 `<details>`，默认全部折叠**，点标题栏展开；左标签右控件、列表字段单行网格）。**只有一个「保存」按钮**，一次写入两处存储：sync 存 Cursor `team_id/user_id/user_email`、Matrix `releaseMatrixVersion/Region/Stages`（均逗号分隔）与 `sshConfig`；local 存持仓 `financeConfig`（会话 id / 持仓列表 / 应急金 / 可投资现金腿 / 目标占比与带宽 / 佣金 / 未匹配角标开关）。保存后回读存储渲染摘要，页面显示的是「实际存进去的」
- `extension/theme.css` — 设计令牌（亮/暗两套）+ 基础控件；`newtab.css` / `options.css` 只写各自页面独有的规则

## 打包与 Native 宿主安装

- `bash package.sh`：交叉编译 Go 宿主为 Windows .exe，连同扩展文件、安装脚本、`config.example.yaml` 一起打包，**出两个 zip**（见[目录结构](#目录结构)）：
  - `dist/edge-panel-v<ver>.zip` —— 外层带一层 `edge-panel-v<ver>/`，首次安装用。
  - `dist/edge-panel-v<ver>-flat.zip` —— 顶层直接是扩展文件（无外层目录），**原地覆盖升级**用。扩展 ID 由目录绝对路径算出，所以升级必须覆盖【当前已加载的那个目录】；用带外层目录的包解压会多出一层新目录 = 新 ID = `storage.sync` 配置清空 + Native 宿主 `allowed_origins` 失配。**注意 Windows 资源管理器的「全部解压」会自动建一层与 zip 同名的文件夹**，升级时应打开 zip 全选复制粘贴进目标目录，或用 7-Zip「解压到当前文件夹」。
- 安装扩展：解压 zip → `edge://extensions` → 开启「开发人员模式」→「加载解压缩的扩展」→ 选解压目录；按 Ctrl+T 看新标签页仪表盘。
- 安装宿主：卡片提示「Native 宿主未安装」时点「下载并安装 Native 宿主」→ 3 个文件下到下载目录 `edge-panel-host/` → 双击 `install-edge-panel-host.bat`（PowerShell 复制 exe 到 `%LOCALAPPDATA%\edge-panel-host`、写 host manifest、`reg.exe` 注册 Edge）→ 点 ↻ 重试。
- **扩展页无法静默注册宿主**（MV3 不能写注册表 / 任意外部路径），「下载 + 双击」是插件内唯一的安装通路。安装脚本是静态模板，位于 `native_host/`，打包时复制进 `native/`。

## Native 宿主（native_host/）

- 协议：stdin/stdout 各消息为 **4 字节小端长度前缀 + UTF-8 JSON**（标准 native messaging）
- 请求：`{"type":"collect","config":{...}}`。`config` 为**内联采集配置**（JSON/YAML 均可，宿主用 `yaml.Unmarshal` 解析，yaml.v3 兼容 JSON 且按 yaml 标签匹配 `ssh_defaults`/`du_paths`/`targets` 键）；也可用 `config_path` 指向磁盘文件
- **采集期间流式上报进度**：`{"type":"progress","done":N,"total":M,"current":"name","status":"start|collecting|ok|error","phase":"connect|collect|du","error":"...","heartbeat":false}` —— 逐服务器状态变化各上报一次，长耗时（du 最长 120s）期间每 10s 发一次心跳（`heartbeat:true`）保活扩展侧 service worker；最终结果仍以一条 `{"last_updated":...,"servers":[...]}` 返回（无 `type` 字段，扩展据此区分进度与结果）
- 响应：`{"last_updated":...,"servers":[...]}` 或 `{"error":"..."}`
- **只采 `type:ssh` 目标**（df + du），不做本机采集
- 配置优先级：内联 `config` > `config_path` / 环境变量 `EDGE_PANEL_CONFIG`。不再有编译期硬编码路径
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

- 新增功能时同步更新 `extension/README.md`、根 `README.md` 与本文档。
- 改 `native_host/` 或扩展源码后重新 `bash package.sh` 生成安装包；开发期直接重载 `extension/` 即可（`native/` 下的编译产物只在打包时生成）。
- 部署到 Windows 侧时**原地覆盖**同一目录（见「关键约束」里的扩展 ID 说明）；不要新建目录改名。
- Go 工具链仅构建时需要（已装于 `~/.local/go`）；产物是单个 Windows .exe，运行零依赖。
- **不要提交** `config.yaml`（含 SSH 密码，已 gitignore）与 `dist/`（打包产物）。

## 故障排查速查表

| 现象 | 可能原因 |
|------|---------|
| 新标签页还是浏览器默认页 | 扩展未启用；或 `chrome_url_overrides.newtab` 被别的扩展占用（同一时刻只能有一个扩展接管新标签页） |
| 卡片不见了 | 拖到了屏幕外（`newtabCards` 里存了越界坐标）；清掉 `chrome.storage.local` 里的 `newtabCards` 即恢复默认落位 |
| 改完 JS 没生效 | 需在 edge://extensions 点「重新加载」，再刷新新标签页 |
| 服务器卡片报 host not found | Native 宿主未注册，或扩展目录路径变过导致 ID 变了（重新双击 `install-edge-panel-host.bat`） |
| Cursor 卡片 403 | 浏览器里未登录 cursor.com，或 cookie 过期 |
| Cursor 芯片「本月消耗」显示「—」 | `get-monthly-billing-cycle` 没取到（未登录 / 该账号没有此账期接口 / 响应缺 `startDateEpochMillis`），只有这一个芯片降级，30 天曲线照常；鼠标悬停能看到原因 |
| Cursor 芯片「本月消耗」比 dashboard 少 | 0.9.4 及更早只取单页 1000 条事件（事件过千时会静默截断，账面偏低）。0.9.5 起按 `totalUsageEventsCount` 翻页并按 `usageEventId` 去重 |
| Cursor 卡片报「usage 接口报错…数字 id」 | 设置里的 `user_id` 不是 dashboard 的数字 id（`owningUser`，如 `352801240`）；从 cookie 推导出的 WorkOS id（`user_01KQ…`）这个接口不认 |
| Matrix 卡片 403 | 浏览器里未登录 cygnus.telenav.com（读不到 `csrftoken`/`auth_token` cookie），或 DNR 规则 5 没生效 —— 重载扩展后点 ↻；设置页 `version` 写错版本号不会 403，只会「暂无 release」 |
| Matrix 卡片「暂无 release」 | `version` 参数与站点上的版本号不一致（大小写不敏感，但 `26m10w2` ≠ `26q3`）；`region` 只出配置里那几个（默认 `hkm,isc,sea`），别的 region 的 release 不会出现 |
| Matrix 卡头点 version 没反应 | 0.9.5 及更早卡头是 `<span>`，点击被卡片拖拽逻辑吞掉。0.9.6 起改成 `<button>`，且拖拽的 `pointerdown` 排除了 `button/a/input/textarea` |
| Matrix 卡片空白/报「返回的不是 JSON」 | 登录态失效被重定向到登录页；登录站点后点 ↻ |
| 安居客气泡里「贝壳」显示未匹配到小区 | 贝壳 sug 按城市限定，城市段取自安居客主机名首段（`xa.fang.anjuke.com` → `xa`）；主机名不是城市前缀（`www`/`m`）时会退回默认 `xa`（西安），其它城市可能搜不到 |
| 安居客气泡里「贝壳」报被风控拦截 | `hip` 风控 cookie 或登录态失效：浏览器打开一次 `m.ke.com` 过掉验证码再点「查贝壳」；连续失败 2 次后自动取数会暂停，需手动点 |
| 安居客气泡里「贝壳」报没返回在售房源 | 未登录贝壳（登录后才返回数据），或该小区确实没有在售 |
| 安居客气泡里「贝壳」一直显示「查询中」 | 修复前有三种假死：无记录也渲染成 loading（熔断后最常见）、fetch 无超时、渲染层抛错。现在都不会再停在「查询中」；若仍出现，跑 `__edgePanelAnjuke.beike()` 看每个小区的 `status` |
| 安居客气泡里「贝壳」报「已暂停自动取数（上次失败：…）」 | 连续失败 2 次后的 3 分钟冷却（`force` 手点不受限）——原因就写在括号里；读不到 cookie 说明该浏览器没打开/登录过 `m.ke.com` |
| 贝壳报「没有登录态/缺 lianjia_token」但浏览器确实登录着 | 0.9.2 及更早的误判：`{url}` 查询读不到子路径下的 token。0.9.3 起改成 `{url}`+`{domain}` 合并读取，且登录标记只作提示不再拦请求；报错里会列出实际读到的 cookie 名便于核对 |
| 服务器采集失败 | 检查设置页 SSH 配置（凭据 / 网络） |
| DeepSeek 会话页看不到浮层 | ①设置里没填该会话 id（可直接粘整条 URL）②扩展未重载 ③该页是首页/分享页而非会话页。会话页上会出现说明原因的小角标 |
| 安居客气泡没出现标签 | ①扩展没重载（改了 manifest，必须重新加载）②日志里没有 `[ajk-bg] 观察到 mapNewlist 请求` → `webRequest` 权限或 host 权限没生效 ③气泡文本与接口名字对不上，用 `__edgePanelAnjuke.dump()` 看 `hit` |
| 安居客面板太高/装不下 | 两个列表各封顶 5 行、超出列表内滚动（表头吸顶）；面板整体兜底 `100vh-48px`，下方空间不够会自动翻到气泡上方。列表行高改了要同步 `--row-h/--head-h`，否则「5 行」会不准 |
| 安居客面板「没取到全部户型」 | 日志里 `[ajk-overlay] 户型接口解析：N 条` 会带 `{objects, objHits, strHits}`；若为 0，紧随其后会打印 `↓ 户型接口原始响应（前 1500 字）`，把那段发出来即可写死字段映射。三条兜底路都失败时还会打印 `↓ 详情页 HTML 片段` |
| 安居客标签显示「详情?」 | 该气泡的名字在接口返回里没有（被缩写/改写过）；`dump()` 里看 `raw -> name` 就知道差在哪。正常态的标签是「详情」（还没点过）或 `|` 分隔的缩略摘要（点过且取到了） |
| 浮层「行情失败」 | 行情源不可达/被限流；点 ↻ 重试。腾讯、新浪均实测可用，东财接口本机不通 |
| 浮层某行「价缺」 | 该代码未返回行情（停牌/代码写错）；该行按成本计入并在快照里标注 |
| 点「填入」变成输入框里的长文本，而不是 .txt 附件 | 快照没超过 DeepSeek 的 `pasteTextToFileLimit`（运行时配置，无法静态读取）。想要附件就点「转附件」 |
| 点「填入」/「转附件」都没反应 | 合成 paste 事件或 file input 注入被页面拒了；提示会显示"已复制 → 请手动粘贴"，直接在输入框里 Ctrl+V 即可（手粘本来就会触发 DeepSeek 自己的转附件） |
| 附件名变成 `1615` 这种 | DeepSeek 派生文件名时删掉 `:`；快照首行已只放日期，不要往首行加带冒号的时间 |

## 编码约定

- **最小改动** — 匹配现有模式（普通函数、`credentials:"omit"` fetch、chrome.storage 缓存）。
- **密钥** — 绝不提交 `config.yaml`、SSH 密码或 Cursor cookies。
- **语言** — UI 字符串为中文；代码/注释/提交信息为英文。
- **无测试套件** — 靠手动重载扩展 + 刷新新标签页验证。可自动化的部分：
  - 持仓浮层算术：`window.__edgePanelFinance.setTestState(cfg, quotes)` + `buildSnapshot()`；挂载判定用 `matchSession(pathname)`。
  - 行情解析/合并：`background.js` 的 `parseTencentQuotes` / `parseSinaQuotes` / `fetchFinanceQuotes` 是顶层函数，可用 node 的 `vm` + stub `chrome`，并把本地抓好的 **GBK 原始字节**喂给 `fetch` 桩（无需联网）。
  - 结构自检：核对 manifest/HTML 引用的文件都存在、JS 里 `getElementById` 的 id 在配对 HTML 里存在。
  - 安居客户型提取器：`anjuke-overlay.js` 的 `extractFromDoc(doc, rec)` 是顶层函数、只依赖 `DOMParser`，可用 headless Chromium（`--dump-dom`）把「合成详情页 HTML」喂进去跑回归 —— 已验证卡片式 / 表格式 / 居室式 / 两类噪音句（只有房型没面积总价）。整套浮层也能离线冒烟：造假 `.mapmain` + 几个 `div.mark`，stub `chrome.runtime.sendMessage/onMessage` 与 `fetch`，加载 `anjuke-overlay.js` 后断言标签文本、面板展开、详情页补齐行数、以及**节点被回收复用后标签是否跟着更新**。

