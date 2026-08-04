// 点击工具栏图标 → 在右侧打开侧边栏
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("setPanelBehavior failed:", err));

/* ============================================================
   侧边栏自动关闭(新标签页仪表盘模式)
   规则: 活动标签不是浏览器新标签页 (edge://newtab / chrome://newtab)
   时自动关闭侧边栏;切回新标签页时保持打开。工具栏图标仍可手动打开。
   注: 新标签页「自动打开」被浏览器手势限制排除 —— chrome.sidePanel.open()
   必须由用户手势触发,而 tabs 生命周期事件不携带手势(实测在
   onCreated/onUpdated/onActivated 中同步调用 open() 仍报 "may only be
   called in response to a user gesture")。因此面板打开需在目标页上手动
   点工具栏图标,自动部分仅保留「离开即关闭」。
   注: chrome.sidePanel.close() 需 Chrome/Edge 141+,旧版本仅降级为
   不自动关闭(特性检测,不报错)。
   ============================================================ */
const NEW_TAB_URL_RE = /^(?:chrome|edge):\/\/newtab(\/.*)?$/i;
const isNewTabUrl = (url) => !!url && NEW_TAB_URL_RE.test(url);

function closePanel(windowId) {
  if (chrome.sidePanel.close) {
    chrome.sidePanel.close({ windowId }).catch(() => {});
  }
}

// 活动标签不是新标签页就关闭面板。about:blank 视为新标签页的过渡态
// (Ctrl+T 新建瞬间 URL 为 about:blank),不触发关闭,避免面板闪关。
function closeIfNotNewTab(tab, windowId) {
  if (!tab || !tab.url) return;
  if (tab.url === "about:blank") return;
  if (!isNewTabUrl(tab.url)) closePanel(windowId ?? tab.windowId);
}

// 标签页内导航 / 加载完成(如新标签页由 about:blank → edge://newtab)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.active) return; // 只处理当前活动标签,避免后台标签干扰
  if (changeInfo.status === "complete" || changeInfo.url) {
    closeIfNotNewTab(tab);
  }
});

// 切换活动标签
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  chrome.tabs
    .get(tabId)
    .then((tab) => closeIfNotNewTab(tab, windowId))
    .catch(() => {});
});

// 窗口获得焦点
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  chrome.tabs
    .query({ active: true, windowId })
    .then(([tab]) => closeIfNotNewTab(tab, windowId))
    .catch(() => {});
});

// 浏览器启动 / 扩展加载时按当前活动标签初始化
function syncActiveTab() {
  chrome.tabs
    .query({ active: true, lastFocusedWindow: true })
    .then(([tab]) => closeIfNotNewTab(tab))
    .catch(() => {});
}
chrome.runtime.onStartup.addListener(syncActiveTab);
chrome.runtime.onInstalled.addListener(syncActiveTab);

/* ============================================================
   DNR 头注入：扩展页 fetch 无法设置 Cookie/Origin/Referer 等
   forbidden headers，而 cursor.com / zhihu.com 会校验它们。
   方案：用 declarativeNetRequest 动态规则，在发出请求前注入
   cookie + origin + referer（cookie 每次面板打开时从浏览器
   chrome.cookies 读取刷新）。因此 fetch 需用 credentials:"omit"。
   ============================================================ */
const CURSOR_ORIGIN = "https://cursor.com";

async function readCookies(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    if (!cookies || !cookies.length) return "";
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch (err) {
    console.error("[dnr] readCookies failed:", err);
    return "";
  }
}

// 每次 refresh-auth / 启动都新鲜读 cookie,不做缓存。
// 之前的 60s TTL 缓存是 403 的根因:若某次读到 cursor cookie 为空而 zhihu
// 恰好有值,ts 会被置为 now → 空 cursor 被「续」60s → 期间每次 refresh-auth
// 都复用空 cookie → DNR 持续不注入 cookie → 403,且 cursorFetch 的重试在同窗口内
// 反复刷新仍拿到空值,表现为 403 卡死。chrome.cookies.getAll 很轻,面板打开时
// 读一次的开销可忽略,回归优化前的行为。
async function updateAuthRules() {
  const [cursorCookie, zhihuCookie] = await Promise.all([
    readCookies("https://cursor.com"),
    readCookies("https://www.zhihu.com"),
  ]);

  const rules = [];

  if (cursorCookie) {
    rules.push({
      id: 1, // cursor 团队排名
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "cookie", operation: "set", value: cursorCookie },
          { header: "origin", operation: "set", value: CURSOR_ORIGIN },
          { header: "referer", operation: "set", value: `${CURSOR_ORIGIN}/dashboard/analytics` },
        ],
      },
      condition: {
        urlFilter: "|https://cursor.com/api/v2/analytics/team/leaderboard",
        resourceTypes: ["xmlhttprequest"],
      },
    });
    rules.push({
      id: 2, // cursor 用量
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "cookie", operation: "set", value: cursorCookie },
          { header: "origin", operation: "set", value: CURSOR_ORIGIN },
          { header: "referer", operation: "set", value: `${CURSOR_ORIGIN}/cn/dashboard/usage` },
        ],
      },
      condition: {
        urlFilter: "|https://cursor.com/api/dashboard/get-filtered-usage-events",
        resourceTypes: ["xmlhttprequest"],
      },
    });
  }

  if (zhihuCookie) {
    rules.push({
      id: 3, // 知乎
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "cookie", operation: "set", value: zhihuCookie },
          { header: "referer", operation: "set", value: "https://www.zhihu.com/" },
        ],
      },
      condition: {
        urlFilter: "|https://www.zhihu.com/api/",
        resourceTypes: ["xmlhttprequest"],
      },
    });
  }

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1, 2, 3],
      addRules: rules,
    });
  } catch (err) {
    console.error("[dnr] updateDynamicRules failed:", err);
  }
}

// 启动即注入（动态规则持久化、幂等）；侧边栏每次打开时经 onMessage 刷新 cookie
updateAuthRules();
chrome.runtime.onInstalled.addListener(() => updateAuthRules());
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "refresh-auth") {
    updateAuthRules().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // 异步响应
  }
});
