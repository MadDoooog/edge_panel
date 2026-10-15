# extension — 浏览器扩展（新标签页仪表盘 + 持仓浮层）

MV3 零构建扩展，改 JS/CSS/HTML 直接生效。三个显示位置：

1. **新标签页**（`chrome_url_overrides.newtab` → `newtab.html`）：空白页上浮三张卡片 —— **Cursor 费用 / 服务器磁盘 / Release Matrix 跳转**，可拖动、可折叠，位置记忆。
2. **DeepSeek 会话页**（content script `deepseek-overlay.js`）：在设置为指定会话 id 的会话页显示**持仓浮层**。
3. **安居客地图找房页**（content script `anjuke-overlay.js`）：地图气泡下方挂标签显示**户型 / 面积 / 参考总价**，点开面板可调 `LoudongHuxing` 接口补齐全部户型。

点工具栏图标 = 打开设置页（`options.html`）。**没有侧边栏**。

## 功能

| 位置 | 内容 | 实现方式 |
|------|------|----------|
| 新标签页卡片 | Cursor 用量 + 团队排名 | 直连 cursor.com（host_permissions 免 CORS；Cookie/Origin/Referer 由 background 的 DNR 注入）；team_id / user_id 从 cookie 自动推导，通常只需填 user_email；10 分钟缓存 + 403 自愈重试 |
| 新标签页卡片 | 服务器磁盘 | Native Messaging → Go 宿主按需 SSH 采集（df + du）；宿主流式上报进度，采集由 background 持有，关页面后继续；24h 内不重复查询 |
| 新标签页卡片 | Release Matrix 跳转 | 纯链接卡片；`version` 在设置页配置（`releaseMatrixVersion`，默认 `26q3`） |
| DeepSeek 会话页 | 持仓浮层 | **默认收成悬浮球** `[● 持仓 \| ⧉ \| ⌄]`：圆点=状态（绿在带内 / 橙出带 / 红行情失败）；**点「持仓」= 直接转附件**（成功留在球里，没进附件通道就自动展开卡片）；`⧉` 复制、`⌄` 展开明细；整块可拖动。卡片里：持仓明细、合计、四类占比、出带信号 + 三个动作（**复制** / **填入** / **转附件**）。份额/成本手工录入，现价经 background 从**腾讯+新浪双源**拉取互验（GBK 解码）；**配色跟随 DeepSeek 自己的浅色/深色** |
| 安居客地图找房页 | 户型浮层 | 气泡（`div.mark.mark-point`）下方挂「**详情**」按钮（**默认不回显**地图接口自带的那 3 条）。点开 Shadow DOM 面板会**自动**调 `LoudongHuxing` 取全部户型，表格只列 **户型/面积/总价** 三列 + 复制 + 去详情页；加载成功后按钮文字就地刷新成 `2/2/1-95平-92万|3/2/2-96平-144万` 缩略摘要（`|` 分隔，最多 `BADGE_MAX_ITEMS=4` 条，超出 `…+N`；完整列表见 `title` 与面板）。失败时给「重试」按钮并保留地图接口自带的前几条兜底 |
| 设置页 | 配置 | Cursor 标识、Matrix version、持仓、SSH 服务器；下载配置模板 / 导入 |

## 安装

1. 打包：`bash package.sh` → `dist/edge-panel-v<ver>.zip`；解压后在 `edge://extensions/` → 开发人员模式 →「加载解压缩的扩展」→ 选解压目录。（开发期可直接加载 `extension/` 目录，但 `native/` 下的宿主与安装脚本只在打包时生成。）
2. 按 **Ctrl+T**：新标签页即仪表盘。卡片标题栏**单击折叠/展开、拖动移动**，位置与折叠状态存 `chrome.storage.local`。
3. 点工具栏图标（或新标签页右上角 ⚙）进设置页：
   - **Cursor**：`team_id` / `user_id` / `user_email`
   - **Release Matrix**：`version`
   - **持仓**：DeepSeek 会话 id（可直接粘整条 URL）、持仓列表、应急金、可投资现金腿、目标占比与带宽、佣金
   - **SSH 服务器**：服务器卡片的数据源（直接填写，或下载模板填写后导入）
   - Cookie 无需填写——自动读取浏览器登录态（cursor.com 的 `WorkosCursorSessionToken`）
4. 服务器卡片需要 Native 宿主（一次性，Windows 侧）：卡片提示「Native 宿主未安装」时点「下载并安装 Native 宿主」→ 3 个文件下到下载目录 `edge-panel-host/` → 双击 `install-edge-panel-host.bat` 完成注册，然后点 ↻ 重试。

## 文件结构

```
extension/
├── manifest.json      # MV3 清单：newtab 覆盖 + content_scripts + host_permissions + WAR
├── background.js      # 图标点击开设置页 + DNR 头注入 + SSH 采集持有者 + 行情取价代理
├── theme.css          # 设计令牌与基础控件（亮/暗跟随系统，贴近浏览器原生观感）
├── newtab.html/css/js # 新标签页悬浮仪表盘（三张卡片：拖动/折叠/位置记忆；图表配色取自 CSS 变量）
├── options.html/css   # 设置页（浏览器设置页风格：分节卡片 + 左标签右控件 + 单行字段网格）
├── deepseek-overlay.js# content script：DeepSeek 会话页持仓浮层（只读、复制快照）
├── anjuke-overlay.js  # content script：安居客地图找房气泡户型浮层（标签 + 面板 + 调接口补齐）
├── yaml.js            # 极简 YAML 子集解析器（「导入配置」用）
├── config.example.yaml# SSH 配置模板（「下载配置模板」）
├── chart.umd.min.js   # 本地 vendored Chart.js（避开扩展页 CSP）
├── cookies.js         # chrome.cookies 读取辅助（cursor.com）
├── metrics.js         # 采集缓存/进度读写 + 宿主安装引导 + 错误识别（采集由 background 发起）
└── cursor.js          # 直连 cursor.com（用法/排名）
```

## 说明 / 限制

- 需 **Chrome / Edge 101+**（MV3 + `adoptedStyleSheets`）。**侧边栏已移除**，不需要 Side Panel API。
- **外观跟随浏览器主题**：`theme.css` 用 `prefers-color-scheme` 提供亮/暗两套令牌（取色贴近浏览器原生界面），新标签页与设置页共用；Cursor 图表配色由 `newtab.js` 从这些 CSS 变量读出，系统主题切换时自动重绘。
- **设置页只有一个「保存」按钮**：一次写入 `storage.sync`（Cursor / Matrix / SSH）与 `storage.local`（持仓）。保存后会回读存储渲染摘要 —— 页面显示的永远是「实际存进去的」，而不是「表单里填的」。
- **扩展无法向 `about:blank` 注入脚本**，所以「空白页上悬浮卡片」只能靠**接管新标签页**实现；想用回默认新标签页就在 `edge://extensions` 停用本扩展。
- **服务器磁盘**由 background（service worker）经 `connectNative` 发起采集，宿主流式上报进度（逐服务器 + 每 10s 心跳保活），因此**新标签页关掉后采集仍继续**；进度持久化在 `chrome.storage.local`（`metricsProgress`），重新打开先显示「正在采集到 xx」，完成后「更新于 xx」。缓存 **24h 内不重复查询**（点 ↻ 强制重新采集）；不做 7×24 后台探测。
- 扩展页 `fetch` **无法设置 Cookie / Origin / Referer 等 forbidden headers**，由 [background.js](background.js) 的 `declarativeNetRequest` 动态规则在请求发出前注入（cursor cookie 每次打开新标签页时从 `chrome.cookies` 刷新），fetch 统一用 `credentials:"omit"`。若 Cursor 仍 403，通常是浏览器里未登录 cursor.com。
- **行情（持仓浮层）**：`deepseek-overlay.js` 是本项目唯一的 content script（`matches: https://chat.deepseek.com/*`）：
  - **挂载判定只看 URL**（`/a/:agentId/s/:sessionId` 里的 sessionId 与设置比对），不依赖任何页面 DOM 选择器；不在指定会话页时不挂载。
  - **取价必须经 background 代理**（`{type:"finance-quotes"}`）：content script 的 fetch 受**页面源** CORS 约束，扩展 `host_permissions` 对它不生效，行情接口也不返回 CORS 头。新浪行情缺 Referer 会 403，由 DNR **规则 4** 注入；腾讯行情是 **GBK**，需 `TextDecoder("gbk")`。
  - 浮层用 **Shadow DOM + `adoptedStyleSheets`**，隔离页面样式并绕开页面 CSP 对内联 `<style>` 的限制。
  - **只读**：不读对话内容、不碰输入框、不自动发送；只有「📋 复制快照」。
  - 会话页上若没匹配到（未配置 / URL 不一致），显示一枚小角标说明原因，避免「什么都不显示」的静默状态。
- **安居客地图找房浮层**（`anjuke-overlay.js`，`matches: https://*.fang.anjuke.com/map/*`）：
  - 气泡是纯 DOM，但**地图平移会回收复用这些节点**（不增不删，只改 `style` 与文本）→ `MutationObserver` 必须同时监听 `attributes` + `characterData`，重扫靠「`markText()` 文本比对 + `rAF` 节流」做幂等。读气泡文本时必须**排除自己注入的标签**，否则标签文字会被读回来污染名称解析。
  - 取数参数**不是猜的**：background 用 `chrome.webRequest`（MV3 只能观察、不能拦截）看页面自己发的那条 `mapNewlist` 请求，抄下 bbox/zoom/筛选；再由 background 取纯 JSON（去掉 `callback` 参数即纯 JSON）推回浮层。**不能**在 content script 里直接 fetch —— 该接口不返回 CORS 头，content script 的 fetch 受页面源 CORS 约束。
  - 名称匹配三级：剥掉价格精确 → 原文精确 → **索引最长前缀**（后者专治「浐灞101」+「6000元/m²」连写成「浐灞1016000元/m²」）。
  - **全量户型走专用接口**：`GET {origin}/aifang/web/ajax/LoudongHuxing/?loupan_id=<id>`，与地图页同源、需 `x-requested-with: XMLHttpRequest`（**不是** forbidden header，能设）。响应结构未公开，所以 `parseHouseTypes()` **不依赖字段名**：递归遍历 JSON（深度 ≤8），凡是「自己身上带着房型串（`3室2厅2卫` / `5居室`）」的对象就当一条户型记录，再从候选键名里取面积/总价/朝向；解析不出会把**原始响应打 1500 字到 console**。两个已踩的坑：① 拼接式字符串（`3室2厅2卫/105㎡`）只在**自带面积**时才认，否则会与对象分支抓到的同一条重复；② `price` 一般是**均价**，但按量级判（`≥ 300000` 视为总价）—— 否则留给 `面积×均价` 推导并标 `~`。
  - **兜底顺序**：户型接口 → 详情页 HTML 文本特征聚类 → 同源 iframe。详情页与地图页**同源**，所以直接 `fetch` 即可（无 CORS 问题）；前端渲染读不到时用**同源 iframe** 渲染后读 `contentDocument` 兜底（该站 CSP `frame-ancestors` 允许 `*.anjuke.com`）。户型提取**不依赖 class 名**，按「房型 + 面积 + 总价」文本特征聚类。
  - **参考总价 = 面积 × 均价**（接口不给总价）：详情页解析到真值显示 `414万`，否则推导值带 `~`。
  - 日志前缀 `[ajk-overlay]`（content）/ `[ajk-bg]`（background），`DEBUG` 开关在 `anjuke-overlay.js` 顶部；控制台可用 `__edgePanelAnjuke.dump()` 看逐气泡的名称匹配率。
- SSH 配置与 Cursor / Matrix 配置存 `chrome.storage.sync`；**持仓配置与卡片位置存 `chrome.storage.local`**（含金额，不上云）。
