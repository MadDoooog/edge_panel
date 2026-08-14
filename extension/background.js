// 点击工具栏图标 → 打开/关闭右侧侧边栏。openPanelOnActionClick 让图标成为
// 手动开关：面板关闭时点击打开，打开时再点关闭。不做任何自动开/关。
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("setPanelBehavior failed:", err));

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

/* ============================================================
   SSH 采集（Native Messaging → Go 宿主）
   采集由 service worker 持有，流式接收宿主上报的进度 —— 这样即使
   侧边栏关闭，采集仍在后台继续（宿主每 10s 心跳保活 SW）。进度写入
   chrome.storage.local（metricsProgress），面板重新打开时先展示
   「正在采集到 xx」，完成后展示「更新于 xx」；面板打开期间经
   chrome.runtime.sendMessage 广播实时进度。
   ============================================================ */
const METRICS_CACHE_KEY = "metrics";
const METRICS_PROGRESS_KEY = "metricsProgress";
const NATIVE_HOST_NAME = "com.edge_panel.host";

let collectRunId = 0; // 每次采集自增；被强制重启的旧连接回调据此忽略
let collectPort = null;
let collectActive = false;

function metricsBroadcast(type, payload) {
  // 面板未打开时无接收端，广播失败可忽略（进度已持久化，重开时读取）
  chrome.runtime.sendMessage({ type, ...payload }).catch(() => {});
}

async function metricsPersistProgress(p) {
  try {
    await chrome.storage.local.set({ [METRICS_PROGRESS_KEY]: p });
  } catch (err) {
    console.error("[metrics] persist progress failed:", err);
  }
}

async function metricsReadSshConfig() {
  const obj = await chrome.storage.sync.get({ sshConfig: null });
  return obj.sshConfig || null;
}

/** 采集结束（成功或出错）的收尾：落缓存/进度并广播。 */
async function finishMetricsCollection(runId, { data, error }) {
  if (runId !== collectRunId) return; // 已被新采集取代
  collectActive = false;
  const finishedAt = new Date().toISOString();
  if (error) {
    await metricsPersistProgress({ running: false, status: "error", error, finishedAt, lastEventAt: finishedAt });
    metricsBroadcast("metrics-done", { error });
    return;
  }
  await metricsPersistProgress({ running: false, status: "ok", finishedAt, lastEventAt: finishedAt });
  try {
    await chrome.storage.local.set({ [METRICS_CACHE_KEY]: data });
  } catch (err) {
    console.error("[metrics] save cache failed:", err);
  }
  metricsBroadcast("metrics-done", { data });
}

// 发起一次 SSH 采集。force=true 时中断正在进行的采集并重新开始（手动刷新语义）。
function startMetricsCollection(force = false) {
  if (collectActive) {
    if (!force) return { ok: true, alreadyRunning: true };
    try {
      collectPort && collectPort.disconnect(); // 宿主进程随之退出
    } catch (_) {}
    collectPort = null;
  }
  const runId = ++collectRunId;
  collectActive = true;

  (async () => {
    let port = null;
    try {
      const config = await metricsReadSshConfig();
      const targets = (config && Array.isArray(config.targets) ? config.targets : []).filter((t) => t && t.host);
      if (!targets.length) throw new Error("未配置 SSH 服务器");

      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
      collectPort = port;
      const startedAt = new Date().toISOString();
      const startP = { running: true, startedAt, done: 0, total: targets.length, status: "collecting", lastEventAt: startedAt };
      await metricsPersistProgress(startP);
      metricsBroadcast("metrics-progress", { progress: startP });

      port.onMessage.addListener((msg) => {
        if (runId !== collectRunId) return; // 旧连接被强制重启，忽略
        if (msg && msg.type === "progress") {
          const p = {
            ...startP,
            done: msg.done ?? 0,
            total: msg.total ?? targets.length,
            current: msg.current,
            status: msg.status,
            phase: msg.phase,
            error: msg.error,
            lastEventAt: new Date().toISOString(),
          };
          metricsPersistProgress(p);
          metricsBroadcast("metrics-progress", { progress: p });
          return;
        }
        // 最终结果：无 type:"progress" 标记
        finishMetricsCollection(runId, msg && msg.error ? { error: msg.error } : { data: msg });
        try {
          port.disconnect();
        } catch (_) {}
      });

      port.onDisconnect.addListener(() => {
        if (runId !== collectRunId) return;
        if (collectPort === port) collectPort = null;
        if (!collectActive) return; // 主动断开（收到最终结果后）已处理
        const errMsg = (chrome.runtime.lastError && chrome.runtime.lastError.message) || "native host disconnected";
        finishMetricsCollection(runId, { error: errMsg });
      });

      port.postMessage({ type: "collect", config });
    } catch (err) {
      if (runId !== collectRunId) return;
      finishMetricsCollection(runId, { error: String((err && err.message) || err) });
      if (port) {
        try {
          port.disconnect();
        } catch (_) {}
      }
    }
  })();

  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "refresh-auth") {
    updateAuthRules().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // 异步响应
  }
  if (msg && msg.type === "start-collect") {
    sendResponse(startMetricsCollection(msg.force === true));
    return false; // 同步响应
  }
});
