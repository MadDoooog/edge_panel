# AGENTS.md — edge-panel

面向 AI 智能体与贡献者的仓库开发指南。

## 项目简介

`edge-panel` 是一个 **纯浏览器扩展**（MV3，零构建，改 JS/CSS/HTML 直接生效），把个人仪表盘做成**新标签页上的悬浮卡片**，并在指定的 DeepSeek 会话页显示**持仓浮层**。

- **新标签页**（`chrome_url_overrides.newtab`）：空白页上浮三张卡片 —— **Cursor 费用 / 服务器磁盘 / Release Matrix 跳转**，可拖动、可折叠、位置记忆
- **DeepSeek 会话页**（content script）：**持仓浮层** —— 默认是「持仓」悬浮球，点开是卡片；份额/成本手工录入，现价经 background 从腾讯+新浪双源拉取互验，市值/浮盈/四类占比本地算，「复制快照」或「填入输入框」
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
│   ├── options.html/css    # 设置页（分节卡片 + 左标签右控件 + 单行字段网格）
│   ├── deepseek-overlay.js # content script：DeepSeek 会话页持仓浮层（悬浮球 + 卡片；复制/填入输入框）
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
# 打包可安装扩展包（交叉编译 Windows Native 宿主 + 扩展 → dist/edge-panel-v<ver>.zip）：
bash package.sh
# 改 native_host/ 或要生成新安装包时重跑 bash package.sh。
```

## 关键约束（改扩展代码前必读）

- **扩展页 `fetch` 无法设置 Cookie / Origin / Referer 等 forbidden headers** —— 由 [background.js](extension/background.js) 的 `declarativeNetRequest` 动态规则在请求前注入（cursor cookie 每次打开新标签页时经 `refresh-auth` 刷新），所有直连 fetch 用 `credentials:"omit"` 避免 cookie 重复。新增直连源站时同步更新 DNR 规则。现有规则 id：**1** cursor 排名、**2** cursor 用量、**4** 新浪行情 Referer；**3 = 已删除的知乎规则**，仅在 `removeRuleIds` 里保留以清理旧安装残留。
- **content script 的 `fetch` 受页面源 CORS 约束**，扩展 `host_permissions` 对它**不生效**，行情接口也不返回 CORS 头 —— 因此 `deepseek-overlay.js` 的取价必须走 background 代理（`{type:"finance-quotes"}`），不能在浮层里直接 fetch。腾讯行情是 **GBK**，必须 `TextDecoder("gbk")`；新浪行情缺 Referer 会 403（实测），靠 DNR 规则 4。
- **「空白页悬浮卡片」只能靠接管新标签页实现** —— 扩展无法向 `about:blank` 注入脚本，`chrome_url_overrides.newtab` 是唯一稳妥做法。改 `newtab.*` 就是改整个仪表盘。
- **扩展目录路径不能变**：Edge/Chrome 给解压缩扩展分配的 ID 由**目录绝对路径**算出（manifest 无 `key`）。换路径 = 新 ID = `storage.sync` 配置清空 + Native 宿主 `allowed_origins` 失配（服务器卡片报 host not found，需重跑 `install-edge-panel-host.bat`）。**原地覆盖升级**是正确姿势。
- **content script 边界**（`deepseek-overlay.js`）：**不读对话内容、不自动发送**；挂载判定**只看 URL**（`/a/:agentId/s/:sessionId`），不依赖页面 DOM 选择器；样式用 Shadow DOM + `adoptedStyleSheets` 隔离，配色跟随 **DeepSeek 自己的浅色/深色**（采样页面实际背景色，2s 轮询，非浏览器主题）。写页面的动作只有用户点击才发生：**填入**（合成一次 `paste` 事件让 DeepSeek 自己决定"文本 / 转 .txt 附件"；它不接管时用 `execCommand("insertText")` 或原生 setter + `input` 事件追加文本）与**转附件**（`file input` 注入 `File` + 派发 `change`）。**两条路都失败就退回剪贴板，绝不静默**。默认形态是「持仓」悬浮球，点开才是卡片。
- **存储分区**：Cursor / Matrix / SSH 配置在 `chrome.storage.sync`；**持仓配置（`financeConfig`）与卡片位置（`newtabCards`）在 `chrome.storage.local`** —— 含金额，不要挪到 sync（sync 会同步到浏览器账号云端）。
- **Native 宿主必须在浏览器所在系统运行**（Windows 版 Edge → Windows 侧）。native messaging 只能拉起浏览器本机的进程。宿主与安装脚本由 `package.sh` 交叉编译后随扩展包分发，安装时由扩展从插件资源下载、用户双击 `install-edge-panel-host.bat` 用 `reg.exe` 注册 `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\`。
- 扩展页默认 CSP `script-src 'self'` —— 脚本必须用外部 `.js`，**不要内联脚本**（样式同理：页面只 `<link>` 外置 CSS，不写内联 `<style>`）。
- **外观统一走 `theme.css` 的 CSS 变量**（`prefers-color-scheme` 切亮/暗，取色贴近浏览器原生界面）：新标签页与设置页都引用它，**不要在页面里硬编码颜色**。`newtab.js` 的图表配色是运行时从这些变量读的（`themeColors()`），系统主题变化时重绘 —— 新增图形沿用这个模式。唯一例外是 `deepseek-overlay.js`：它浮在别人的网页上、样式内联在 JS 里，配色跟随 **DeepSeek 自己的浅色/深色**（采样页面背景色），不走 `theme.css`。
- 定时刷新只在新标签页打开期间进行（`newtab.js`）；无 7×24 后台探测。唯一例外：SSH 采集由 **background service worker** 持有（`chrome.runtime.connectNative` → 宿主流式上报进度 + 每 10s 心跳保活 SW），关页面后采集继续，完成后即止。

## 扩展模块

- `extension/newtab.js` — 新标签页编排：卡片拖动/折叠/位置持久化（`newtabCards`）+ Cursor 图表（Chart.js）+ 服务器磁盘渲染（采集进度、宿主安装引导）+ Matrix 链接（`releaseMatrixVersion`）
- `extension/deepseek-overlay.js` — content script：持仓浮层。**默认收成「持仓」悬浮球**：`[● 持仓 | ⧉ | ⌄]` —— 圆点=状态（绿在带内/橙出带/红行情失败）；**点圆点+「持仓」= 直接转附件**（成功留在球里，没进附件通道就自动展开卡片让用户换按钮）；`⧉` 复制快照；`⌄` 展开看明细。整块可拖动。卡片三个动作：**复制**、**填入**、**转附件**。
  - **「长文本自动转 .txt 附件」是 DeepSeek 自己的逻辑**（`onPaste` 里：`pastedText.length > pasteTextToFileLimit && canAddFile` → `preventDefault()` + `new File([text], "<首行≤50字>.txt", {type:"text/plain;charset=utf-8"})` + `fileSource:"paste"` 上传）。阈值是**运行时 config，前端 bundle 里没有字面量**，无法静态得知。
  - 因此「填入」= **合成一次真实粘贴**（`new ClipboardEvent("paste",{clipboardData: dt})`）让 DeepSeek 自己判断；`dispatchEvent()` **返回 false 就等于它接管了（已转附件）**，因为它只在转附件那条分支调用 `preventDefault()`。「转附件」= 先走同一条粘贴路径，它没接管再用 **file input 注入**（`new File(...)` → `input.files = dt.files` → 派发 `change`）兜底，确保一定进文件通道。
  - 附件文件名由**快照首行**派生（DeepSeek 会删掉 `\ / : * ? " < > |`，所以首行只放日期不放 `16:15` 这样的时间）。`derivedFileName()` 复刻了这条规则。
  - 三条通道都用 `attachmentVisible()`（轮询页面里是否出现文件名）与输入框回读来**确认结果**，失败一律退回剪贴板，绝不静默。
  - `window.__edgePanelFinance` 是隔离世界里的调试钩子（页面脚本不可见）：`setTestState(cfg, quotes)` + `buildSnapshot()` 验算术、`deliverToComposer()`/`derivedFileName()` 验投递通道、`matchSession(pathname)` 验挂载判定、`detectPageTheme()` 验主题采样
- `extension/background.js` — 图标点击开设置页 + DNR 头注入 + **SSH 采集持有者**（connectNative 流式接收宿主进度 → 持久化 `metricsProgress` 并广播）+ **行情取价代理**（腾讯+新浪双源互验、GBK 解码、按开市/休市分档缓存）
- `extension/metrics.js` — 页面侧辅助：采集缓存/进度读写（`metrics` / `metricsProgress`）、宿主安装引导、错误识别；不直接 connectNative
- `extension/cookies.js` — `chrome.cookies` 读取辅助（cursor.com 的 `WorkosCursorSessionToken`）
- `extension/cursor.js` — cursor.com 直连（数据函数带 `*Api` 后缀）；含 403 自愈重试
- `extension/options.html/js` + `options.css` — 设置页（浏览器设置页风格：分节卡片、左标签右控件、列表字段单行网格）。**只有一个「保存」按钮**，一次写入两处存储：sync 存 Cursor `team_id/user_id/user_email` 与 Matrix `releaseMatrixVersion` + `sshConfig`；local 存持仓 `financeConfig`（会话 id / 持仓列表 / 应急金 / 可投资现金腿 / 目标占比与带宽 / 佣金 / 未匹配角标开关）。保存后回读存储渲染摘要，页面显示的是「实际存进去的」
- `extension/theme.css` — 设计令牌（亮/暗两套）+ 基础控件；`newtab.css` / `options.css` 只写各自页面独有的规则

## 打包与 Native 宿主安装

- `bash package.sh`：交叉编译 Go 宿主为 Windows .exe，连同扩展文件、安装脚本、`config.example.yaml` 一起打包为 `dist/edge-panel-v<ver>.zip`（见[目录结构](#目录结构)）。
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
| 服务器采集失败 | 检查设置页 SSH 配置（凭据 / 网络） |
| DeepSeek 会话页看不到浮层 | ①设置里没填该会话 id（可直接粘整条 URL）②扩展未重载 ③该页是首页/分享页而非会话页。会话页上会出现说明原因的小角标 |
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
