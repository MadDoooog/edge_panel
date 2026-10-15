// 点击工具栏图标 → 打开设置页（侧边栏已移除，仪表盘改为新标签页悬浮卡片）
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

/* ============================================================
   DNR 头注入：扩展页 fetch 无法设置 Cookie/Origin/Referer 等
   forbidden headers，而 cursor.com 会校验它们。
   方案：用 declarativeNetRequest 动态规则，在发出请求前注入
   cookie + origin + referer（cookie 每次新标签页打开/刷新时从浏览器
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
// 之前的 60s TTL 缓存是 403 的根因:若某次读到 cookie 为空(比如未登录),
// ts 会被置为 now → 空 cookie 被「续」60s → 期间每次 refresh-auth 都复用空值
// → DNR 持续不注入 cookie → 403,且 cursorFetch 的重试在同一窗口内反复刷新
// 仍拿到空值,表现为 403 卡死。chrome.cookies.getAll 很轻,读一次的开销可忽略。
async function updateAuthRules() {
  const cursorCookie = await readCookies("https://cursor.com");

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

  // 新浪行情强制校验 Referer（缺了返回 403），而扩展 fetch 无法设置该请求头。
  // 与 cookie 无关，因此无条件注入。
  rules.push({
    id: 4,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "referer", operation: "set", value: "https://finance.sina.com.cn" }],
    },
    condition: {
      urlFilter: "|https://hq.sinajs.cn/",
      resourceTypes: ["xmlhttprequest"],
    },
  });

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      // id 3 = 已删除的知乎规则，一并清掉，避免旧安装残留
      removeRuleIds: [1, 2, 3, 4],
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
   chrome.storage.local（metricsProgress），新标签页重新打开时先展示
   「正在采集到 xx」，完成后展示「更新于 xx」；页面打开期间经
   chrome.runtime.sendMessage 广播实时进度。
   ============================================================ */
const METRICS_CACHE_KEY = "metrics";
const METRICS_PROGRESS_KEY = "metricsProgress";
const NATIVE_HOST_NAME = "com.edge_panel.host";

let collectRunId = 0; // 每次采集自增；被强制重启的旧连接回调据此忽略
let collectPort = null;
let collectActive = false;

function metricsBroadcast(type, payload) {
  // 页面上没有接收端时广播失败可忽略（进度已持久化，重开时读取）
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

/* ============================================================
   行情取价代理（腾讯 + 新浪双源互验）
   必须放在 background：content script 的 fetch 受「页面源」CORS 约束，
   扩展的 host_permissions 对它不生效，而行情接口不返回 CORS 头 ——
   因此持仓浮层统一经此代理取价（后台请求才享受 host_permissions，
   新浪的 Referer 由上面的 DNR 规则 4 注入）。
   ============================================================ */
const FINANCE_CACHE_KEY = "financeQuotes";
const QUOTE_TTL_OPEN_MS = 60 * 1000; // 可能开市：1 分钟
const QUOTE_TTL_CLOSED_MS = 30 * 60 * 1000; // 休市（含周末/盘后）：30 分钟
const QUOTE_DOUBT_PCT = 0.5; // 两源价差超过 0.5% 标记为存疑

/** 归一化代码：允许 "510300" / "sh510300"，缺市场时按首位数字推断。 */
function normalizeQuoteCode(raw) {
  const m = String(raw || "").trim().toLowerCase().match(/^(?:(sh|sz))?(\d{6})$/);
  if (!m) return null;
  const prefix = m[1] || (/^[569]/.test(m[2]) ? "sh" : "sz");
  return prefix + m[2];
}

/** 行情接口返回 GBK（沪深行情惯例），必须显式解码。 */
function decodeGbk(buffer) {
  return new TextDecoder("gbk").decode(buffer);
}

async function fetchQuoteText(url) {
  const resp = await fetch(url, { credentials: "omit", cache: "no-store" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return decodeGbk(await resp.arrayBuffer());
}

/** 解析腾讯行情：v_sh510300="1~名称~代码~现价~昨收~今开~…~yyyymmddhhmmss~…" */
function parseTencentQuotes(text) {
  const out = {};
  for (const line of String(text).split(";")) {
    const m = line.match(/v_((?:sh|sz)\d{6})="([^"]*)"/);
    if (!m) continue;
    const f = m[2].split("~");
    const price = Number(f[3]);
    if (!Number.isFinite(price) || price <= 0) continue;
    const stamp = f.find((x) => /^\d{14}$/.test(x)) || "";
    out[m[1]] = {
      name: f[1] || "",
      price,
      prevClose: Number(f[4]) || null,
      time: stamp
        ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)} ${stamp.slice(8, 10)}:${stamp.slice(10, 12)}`
        : "",
    };
  }
  return out;
}

/** 解析新浪行情：hq_str_sh510300="名称,今开,昨收,现价,最高,最低,…,,日期,时间,…" */
function parseSinaQuotes(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const m = line.match(/hq_str_((?:sh|sz)\d{6})="([^"]*)"/);
    if (!m) continue;
    const f = m[2].split(",");
    const price = Number(f[3]);
    if (!Number.isFinite(price) || price <= 0) continue;
    out[m[1]] = {
      name: f[0] || "",
      price,
      prevClose: Number(f[2]) || null,
      time: `${f[30] || ""} ${(f[31] || "").slice(0, 5)}`.trim(),
    };
  }
  return out;
}

/** 是否处于可能开市时段（沪深：工作日 09:10–15:20，按本机时区近似）。 */
function marketMaybeOpen() {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= 9 * 60 + 10 && mins <= 15 * 60 + 20;
}

async function readQuoteCache() {
  try {
    const obj = await chrome.storage.local.get(FINANCE_CACHE_KEY);
    return obj[FINANCE_CACHE_KEY] || null;
  } catch (_) {
    return null;
  }
}

/**
 * 取一批代码的现价。缓存命中且覆盖全部代码时直接返回；
 * force=true 跳过缓存（新标签页/浮层的 ↻ 语义）。
 */
async function fetchFinanceQuotes(codes, force) {
  const wanted = [...new Set((Array.isArray(codes) ? codes : []).map(normalizeQuoteCode).filter(Boolean))];
  if (!wanted.length) return { ok: true, at: null, quotes: {}, errors: [] };

  const cached = force ? null : await readQuoteCache();
  if (cached && cached.quotes) {
    const ttl = marketMaybeOpen() ? QUOTE_TTL_OPEN_MS : QUOTE_TTL_CLOSED_MS;
    const complete = wanted.every((c) => cached.quotes[c]);
    if (complete && Date.now() - (cached.ts || 0) < ttl) {
      return { ok: true, at: cached.at, quotes: cached.quotes, errors: [], cached: true };
    }
  }

  const errors = [];
  const quotes = {};
  const list = wanted.join(",");

  const [tencent, sina] = await Promise.all([
    fetchQuoteText(`https://qt.gtimg.cn/q=${list}`)
      .then(parseTencentQuotes)
      .catch((e) => {
        errors.push({ source: "tencent", message: String((e && e.message) || e) });
        return {};
      }),
    fetchQuoteText(`https://hq.sinajs.cn/list=${list}`)
      .then(parseSinaQuotes)
      .catch((e) => {
        errors.push({ source: "sina", message: String((e && e.message) || e) });
        return {};
      }),
  ]);

  for (const code of wanted) {
    const t = tencent[code];
    const s = sina[code];
    if (!t && !s) continue;
    const primary = t || s;
    const doubt =
      t && s && Math.abs(t.price - s.price) / Math.max(t.price, s.price) > QUOTE_DOUBT_PCT / 100;
    quotes[code] = {
      name: primary.name,
      price: primary.price,
      prevClose: primary.prevClose,
      time: primary.time,
      doubtful: Boolean(doubt),
      sources: [t ? "tencent" : null, s ? "sina" : null].filter(Boolean),
      altPrice: doubt ? (t ? s.price : t.price) : null,
    };
  }

  for (const code of wanted) if (!quotes[code]) errors.push({ code, message: "行情源无此代码或已停牌" });

  const at = new Date().toISOString();
  const payload = { at, quotes };
  if (Object.keys(quotes).length) {
    try {
      await chrome.storage.local.set({ [FINANCE_CACHE_KEY]: { ts: Date.now(), ...payload } });
    } catch (err) {
      console.error("[finance] cache save failed:", err);
    }
  }
  return { ok: true, at, quotes, errors };
}

/* ============================================================
   安居客地图找房：观察页面自己发的 mapNewlist 请求 → 取数 → 推给浮层
   ------------------------------------------------------------
   为什么不直接在 content script 里 fetch：
     api.fang.anjuke.com 不返回任何 Access-Control-* 头，而 content script
     的 fetch 受「页面源」CORS 约束（扩展 host_permissions 对它不生效），
     所以取数必须由 background 代做。
   为什么用 webRequest 而不是往页面世界注入 hook：
     MV3 的 webRequest 只能观察、不能拦截 —— 而我们要的恰好只是那条请求的
     URL（带 bbox/zoom/筛选条件）。这样零页面上下文代码、不依赖页面用的
     jQuery 内部实现，也不用把 minimum_chrome_version 抬到 world:"MAIN"
     所要求的 111。
   接口无需 cookie / Referer（实测）；把 callback 参数去掉即返回纯 JSON；
   page_size 服务端硬上限 100。
   ============================================================ */
const AJK_MAPLIST_URL = "https://api.fang.anjuke.com/web/loupan/mapNewlist/";
const AJK_MAPLIST_FILTER = "*://api.fang.anjuke.com/web/loupan/mapNewlist/*";
const AJK_SESSION_KEY = "anjukeMapCache"; // 只留最近一个 tab，SW 被回收后仍能应答
const AJK_DEBOUNCE_MS = 400; // 拖动地图会连发，必须合并
const AJK_PASS = [
  "city_id", "zoom", "swlng", "swlat", "nelng", "nelat", "order", "order_type",
  "region_id", "sub_region_id", "house_type", "property_type", "price_id",
  "bunget_id", "status_sale", "price_title", "keywords",
];

const ajkByTab = new Map(); // tabId -> { key, params, rows, at }
const ajkTimers = new Map(); // tabId -> timeoutId

function ajkLog(...a) {
  console.log("[ajk-bg]", ...a);
}
function ajkWarn(...a) {
  console.warn("[ajk-bg]", ...a);
}

/** 从页面自己的请求 URL 里抄出取数参数（缺 bbox 的请求直接忽略）。 */
function ajkPickParams(url) {
  let q;
  try {
    q = new URL(url).searchParams;
  } catch (_) {
    return null;
  }
  if (!q.get("swlng")) return null;
  const p = {};
  for (const k of AJK_PASS) {
    const v = q.get(k);
    if (v != null) p[k] = v;
  }
  p.page = "1";
  p.page_size = "100";
  return p;
}

function ajkBboxKey(p) {
  return [
    p.swlng, p.swlat, p.nelng, p.nelat, p.zoom, p.city_id, p.region_id,
    p.house_type, p.property_type, p.price_id, p.bunget_id, p.status_sale,
  ].join("|");
}

async function ajkFetchRows(params) {
  const url = AJK_MAPLIST_URL + "?" + new URLSearchParams(params).toString();
  const resp = await fetch(url, { credentials: "omit", cache: "no-store" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const text = await resp.text();
  const j = JSON.parse(text); // 不带 callback → 纯 JSON
  return (j && j.result && j.result.rows) || [];
}

async function ajkPersist() {
  try {
    if (!chrome.storage.session) return;
    const last = [...ajkByTab.entries()].pop();
    if (!last) return;
    await chrome.storage.session.set({ [AJK_SESSION_KEY]: Object.assign({ tabId: last[0] }, last[1]) });
  } catch (_) {}
}

async function ajkReadPersisted(tabId) {
  try {
    if (!chrome.storage.session || tabId == null) return null;
    const obj = await chrome.storage.session.get(AJK_SESSION_KEY);
    const v = obj[AJK_SESSION_KEY];
    if (v && v.tabId === tabId) return v;
  } catch (_) {}
  return null;
}

async function ajkRun(tabId, params) {
  const key = ajkBboxKey(params);
  const prev = ajkByTab.get(tabId);
  if (prev && prev.key === key) {
    ajkLog("bbox 未变，跳过取数");
    return;
  }
  const t0 = Date.now();
  try {
    const rows = await ajkFetchRows(params);
    const rec = { key, params, rows, at: Date.now() };
    ajkByTab.set(tabId, rec);
    ajkPersist();
    ajkLog(
      `取数完成：${rows.length} 行 / ${Date.now() - t0}ms`,
      `zoom=${params.zoom}`,
      `bbox=${params.swlng},${params.swlat} → ${params.nelng},${params.nelat}`
    );
    // 页面上没有接收端时（浮层未注入）静默失败
    chrome.tabs.sendMessage(tabId, { type: "ajk-rows", rows, params }).catch(() => {});
  } catch (e) {
    ajkWarn("取数失败：", (e && e.message) || e);
  }
}

if (chrome.webRequest && chrome.webRequest.onBeforeRequest) {
  chrome.webRequest.onBeforeRequest.addListener(
    (d) => {
      if (d.tabId == null || d.tabId < 0) return;
      const params = ajkPickParams(d.url);
      if (!params) return;
      ajkLog(
        "观察到 mapNewlist 请求",
        `tab=${d.tabId}`,
        `type=${d.type}`,
        `zoom=${params.zoom}`,
        `bbox=${params.swlng},${params.swlat} → ${params.nelng},${params.nelat}`
      );
      clearTimeout(ajkTimers.get(d.tabId));
      ajkTimers.set(
        d.tabId,
        setTimeout(() => {
          ajkTimers.delete(d.tabId);
          ajkRun(d.tabId, params);
        }, AJK_DEBOUNCE_MS)
      );
    },
    { urls: [AJK_MAPLIST_FILTER] },
    []
  );
  ajkLog("webRequest 观察器已挂载");
} else {
  ajkWarn("chrome.webRequest 不可用 —— 检查 manifest.json 是否声明了 webRequest 权限");
}

chrome.tabs.onRemoved.addListener((tabId) => {
  ajkByTab.delete(tabId);
  clearTimeout(ajkTimers.get(tabId));
  ajkTimers.delete(tabId);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "refresh-auth") {
    updateAuthRules().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // 异步响应
  }
  if (msg && msg.type === "start-collect") {
    sendResponse(startMetricsCollection(msg.force === true));
    return false; // 同步响应
  }
  if (msg && msg.type === "finance-quotes") {
    fetchFinanceQuotes(msg.codes, msg.force === true)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // 异步响应
  }
  if (msg && msg.type === "open-options") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
});

/* 安居客浮层的两个消息（单独一个监听器，不动上面的既有分支）。
   注意 chrome.runtime.onMessage 允许多个监听器并存：
   上面那个对自己不认识的 type 会返回 undefined（不是 true），不占用响应通道。 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // 浮层初始化时问一句「后台有没有已缓存的参数/数据」
  if (msg.type === "ajk-rows") {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    const rec = tabId != null ? ajkByTab.get(tabId) : null;
    if (rec) {
      sendResponse({ ok: true, rows: rec.rows, params: rec.params, at: rec.at });
      return false;
    }
    ajkReadPersisted(tabId).then((v) => {
      if (v) {
        ajkByTab.set(tabId, v);
        ajkLog(`从 storage.session 恢复缓存：${(v.rows || []).length} 行`);
        sendResponse({ ok: true, rows: v.rows, params: v.params, at: v.at, restored: true });
      } else {
        sendResponse({ ok: true, rows: [], params: null });
      }
    });
    return true; // 异步响应
  }

  // 户型接口代理（浮层同源 fetch 失败时的兜底）。
  // 该接口要 x-requested-with: XMLHttpRequest —— 它不是 forbidden header，
  // content script 和 background 都能设；这里把浮层传来的 headers 原样带上。
  if (msg.type === "ajk-fetch-json") {
    (async () => {
      try {
        const resp = await fetch(msg.url, {
          credentials: "include",
          cache: "no-store",
          headers: msg.headers || {},
        });
        const text = await resp.text();
        sendResponse({ ok: resp.ok, status: resp.status, text });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true; // 异步响应
  }

  // 详情页 HTML 代理（浮层同源 fetch 失败时的兜底）。
  // 这里用 credentials:"include"：安居客的反爬可能看会话 cookie，
  // 且本扩展没有为这个域名注入任何 DNR 规则，不存在 cookie 重复问题。
  if (msg.type === "ajk-fetch-text") {
    (async () => {
      try {
        const resp = await fetch(msg.url, { credentials: "include", cache: "no-store" });
        const text = await resp.text();
        sendResponse({ ok: resp.ok, status: resp.status, text });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true; // 异步响应
  }
});
