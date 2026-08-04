# extension — 浏览器侧边栏扩展

把 edge-panel 的功能搬进浏览器**右侧侧边栏**（MV3，零构建，改 JS/CSS 直接生效）。单列布局，自上而下：**Cursor 用量 → 服务器（SSH 磁盘）→ Logshed → 阅读**；顶栏仅保留「阅读 / 设置」两个按钮。

## 功能

| 区块 | 实现方式 |
|------|----------|
| Cursor 用量 + 团队排名 | **直连 cursor.com**（host_permissions 免 CORS；Cookie/Origin/Referer 由 background 的 `declarativeNetRequest` 规则注入）；team_id / user_id 从 cookie 自动推导，通常只需在设置填 user_email |
| 服务器磁盘 | **Native Messaging → Go 宿主**按需 SSH 采集 `type:ssh` 目标（df + du） |
| Logshed | 单按钮红绿状态（点击重新探测），不展示历史 |
| 阅读（知乎） | 直连 zhihu API + 自动 cookie；归一化、去重缓存、收藏、评论全部在扩展内完成 |

## 安装

1. 打开 `edge://extensions/` → 开启「开发人员模式」→「加载解压缩的扩展」→ 选 `extension/` 目录
2. 点工具栏图标打开右侧侧边栏（相当于新标签页仪表盘）；切到其他页面/标签**自动关闭**。新标签页无法自动弹出（浏览器手势限制，见「说明 / 限制」）。需要 `tabs` 权限读取标签 URL
3. 首次使用点顶栏「⚙」，填写非 Cookie 的账号标识：
   - **Cursor**：`team_id` / `user_id` / `user_email`（来自 cursor.com 账号设置）
   - **Logshed URL**（默认已填）
   - Cookie 无需填写——自动读取浏览器登录态（cursor.com 的 `WorkosCursorSessionToken`、zhihu.com 的 `z_c0`）
4. 服务器面板需要 Native 宿主（一次性，Windows 侧）：
   ```bash
   bash native_host/setup_native_host.sh
   ```

## 文件结构

```
extension/
├── manifest.json      # MV3 清单：sidePanel/storage/cookies + host_permissions
├── background.js      # 点击图标打开侧边栏 + Native Messaging 桥
├── sidepanel.html     # 单列布局面板
├── sidepanel.css      # 由 frontend/style.css 复制 + 单列覆盖块
├── options.html/js    # 设置页（cursor team/user/email、logshed URL）
├── chart.umd.min.js   # 本地 vendored Chart.js（避开扩展页 CSP）
├── cookies.js         # chrome.cookies 读取辅助
├── metrics.js         # Native Messaging 请求 Go 宿主采集 + 本地缓存
├── logshed.js         # 探测 + 6h 历史（chrome.storage.local）
├── cursor.js          # 直连 cursor.com（用法/排名）
├── feeds.js           # 知乎抓取/归一化/收藏/评论（移植 backend/feeds/）
└── script.js          # UI 编排
```

## 说明 / 限制

- 需 **Chrome / Edge 116+**（Side Panel API）。新标签页**自动打开**侧边栏不可行：`chrome.sidePanel.open()` 要求用户手势，而 `tabs` 生命周期事件（新建/切换/更新）不携带手势，会被浏览器拒绝。因此面板需手动点工具栏图标打开；**离开新标签页自动关闭**依赖 `chrome.sidePanel.close()`（**Edge 141+**，2026 年稳定版均已满足），低于 141 时自动关闭静默降级。
- **服务器磁盘**只在面板打开时采集，且缓存 **24h 内不重复查询**（点刷新按钮强制）；不做 7×24 后台探测。Logshed 在面板可见期间每 60s 探测一次。
- 扩展页 `fetch` **无法设置 Cookie / Origin / Referer 等 forbidden headers**，因此由 [background.js](background.js) 的 `declarativeNetRequest` 动态规则在请求发出前注入（cookie 每次面板打开时从 `chrome.cookies` 刷新），fetch 统一用 `credentials:"omit"` 避免重复。若 Cursor / 知乎仍 403，通常是浏览器里未登录对应站点（登录态 cookie 缺失）。
- 服务器指标经侧边栏页面直接 `chrome.runtime.connectNative` 拉起 Go 宿主（不再走 background 桥）。
- Native 宿主默认读 WSL 侧 `config.yaml`（`\\wsl.localhost\Ubuntu\home\lvwu\py\edge-panel\config.yaml`）。发行版名/路径不同时改 [native_host/config.go](../native_host/config.go) 的 `defaultConfigPath` 重新编译，或在请求里传 `config_path`。

## 后端回退

`backend/` + `frontend/` 仍保留可运行（`python run.py`），作为扩展跑通前的回退路径。
