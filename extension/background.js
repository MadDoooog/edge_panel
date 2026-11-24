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

// cygnus（Release Matrix）的取数接口 POST /release_matrix/releases/index 实测要求：
//   1) cookie（auth_token / mapilot-auth-token，HttpOnly 也能经 chrome.cookies 读到）
//   2) Referer —— Django 对 HTTPS 请求做 CSRF 校验时没 Referer 直接 403（实测）
//   3) X-CSRFToken —— 值可直接用 csrftoken cookie 的原文（Django 同时接受
//      32 位未掩码 secret 与 64 位掩码 token；前者省掉一次刮页面 HTML）
// 三者在 background 里一次性读取，避免 DNR 规则里的 cookie 与 header 用的 token
// 来自两次不同读取（csrf cookie 轮换时会 403）。
const KE_COOKIE_URL = "https://www.ke.com/"; // 贝壳 PC 站（安居客气泡的第三方信息源）
const CYGNUS_ORIGIN = "https://cygnus.telenav.com";
const CYGNUS_RELEASES_URL = `${CYGNUS_ORIGIN}/release_matrix/releases/index`;
const CYGNUS_REFERER = `${CYGNUS_ORIGIN}/release_matrix/releases/index?mo=t&region=hkm%2Cisc%2Csea&version=`;
// Release Matrix 的三个可配置参数（逗号分隔，存 chrome.storage.sync）：
//   releaseMatrixVersion / releaseMatrixRegion / releaseMatrixStages
// 默认值与 options.js / newtab.js 保持一致。
const MATRIX_DEFAULT_VERSION = "26q3";
const MATRIX_DEFAULT_REGION = "hkm,isc,sea";
const MATRIX_DEFAULT_STAGES = "PBF,NGX,QA-NGX";

/**
 * 读某个源站的 cookie。
 * 必须同时用 {url} 与 {domain} 两次查询再合并：`{url}` 只返回**路径也匹配**的
 * cookie，登录 token 若被站点设在某个子路径下（Path=/xxx）就读不到 —— 实测踩过
 * 「明明登录了却报缺 lianjia_token」，而实际上只是读漏了。
 * 同名冲突时以 {url} 那份为准（那才是本该发给这个 URL 的）。
 * 返回值附带名称清单（绝不含值），用于诊断。
 */
async function readCookies(url, domain) {
  try {
    const safe = (p) => p.catch((e) => {
      // {domain} 查询可能因 host 权限不足被拒 —— 绝不能因此把 url 那份也丢掉
      console.warn("[dnr] cookies query failed:", (e && e.message) || e);
      return [];
    });
    const [byUrl, byDomain] = await Promise.all([
      safe(chrome.cookies.getAll({ url })),
      domain ? safe(chrome.cookies.getAll({ domain })) : Promise.resolve([]),
    ]);
    const byName = new Map();
    for (const list of [byUrl || [], byDomain || []]) {
      for (const c of list) if (!byName.has(c.name)) byName.set(c.name, c);
    }
    const all = [...byName.values()];
    return {
      header: all.map((c) => `${c.name}=${c.value}`).join("; "),
      names: all.map((c) => c.name),
    };
  } catch (err) {
    console.error("[dnr] readCookies failed:", err);
    return { header: "", names: [] };
  }
}

// 每次 refresh-auth / 启动都新鲜读 cookie,不做缓存。
// 之前的 60s TTL 缓存是 403 的根因:若某次读到 cookie 为空(比如未登录),
// ts 会被置为 now → 空 cookie 被「续」60s → 期间每次 refresh-auth 都复用空值
// → DNR 持续不注入 cookie → 403,且 cursorFetch 的重试在同一窗口内反复刷新
// 仍拿到空值,表现为 403 卡死。chrome.cookies.getAll 很轻,读一次的开销可忽略。
// 返回这次读到的 cookie 串：matrix 取数要用同一份 csrftoken 当 X-CSRFToken。
async function updateAuthRules() {
  const [cursor, cygnus, ke] = await Promise.all([
    readCookies(CURSOR_ORIGIN, "cursor.com"),
    readCookies(CYGNUS_ORIGIN, "telenav.com"),
    readCookies(KE_COOKIE_URL, "ke.com"),
  ]);
  const cursorCookie = cursor.header;
  const cygnusCookie = cygnus.header;
  const keCookie = ke.header;

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
      id: 2, // cursor dashboard API（账期 + 用量事件）
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
        // 整个 /api/dashboard/ 命名空间都注入：get-monthly-billing-cycle（账期）
        // 与 get-filtered-usage-events（用量事件）都要这份 cookie，一条规则覆盖两者
        urlFilter: "|https://cursor.com/api/dashboard/",
        resourceTypes: ["xmlhttprequest"],
      },
    });
  }

  // cygnus（Release Matrix）取数：扩展页/后台 fetch 是跨站请求，
  // SameSite=Lax 的登录 cookie 不会被带上，而 Cookie 又是 forbidden header
  // —— 只能由 DNR 注入；Referer 同理（Django 的 HTTPS CSRF 校验需要）。
  // origin 必须一起注入：Chrome 对跨源 POST 会自动加
  // `Origin: chrome-extension://<id>`，而该站点只要 Origin 不等于
  // https://cygnus.telenav.com 就 403（实测：chrome-extension:// → 403、
  // Origin: null → 403、正确的站点 origin → 200、不带 Origin → 200）。
  if (cygnusCookie) {
    rules.push({
      id: 5, // release matrix 取数
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "cookie", operation: "set", value: cygnusCookie },
          { header: "origin", operation: "set", value: CYGNUS_ORIGIN },
          { header: "referer", operation: "set", value: CYGNUS_REFERER },
        ],
      },
      condition: {
        urlFilter: `|${CYGNUS_RELEASES_URL}`,
        resourceTypes: ["xmlhttprequest"],
      },
    });
  }

  // 贝壳 PC 站小区二手房页（安居客气泡的第三方信息源）：必须带登录 cookie，
  // 否则 302 到 clogin.ke.com 登录页（移动站则是 hip.ke.com/captcha 验证码页）。
  // 实测 Referer / Origin 都不是必需的，所以只注入 cookie。
  if (keCookie) {
    rules.push({
      id: 6, // 贝壳小区在售二手房
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "cookie", operation: "set", value: keCookie }],
      },
      condition: {
        // PC 站城市在主机名里（xa.ke.com），路径是 /ershoufang/c<id>/。
        // urlFilter 做不了主机名变量的匹配，只能用正则。
        regexFilter: "^https://[a-z]{2,12}\\.ke\\.com/ershoufang/c\\d+",
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
      removeRuleIds: [1, 2, 3, 4, 5, 6],
      addRules: rules,
    });
  } catch (err) {
    console.error("[dnr] updateDynamicRules failed:", err);
  }

  return { cursorCookie, cygnusCookie, keCookie, keCookieNames: ke.names };
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
   蓝牙电量（Native Messaging → Go 宿主）
   宿主跑在浏览器所在机器上，用 PowerShell 读 Windows 的蓝牙电量
   （见 native_host/bt_windows.go）；这里只负责「要一次结果」：
   每次新建一个连接、收一条消息就断开，缓存交给新标签页（60s）。
   ============================================================ */
const BLUETOOTH_TIMEOUT_MS = 45 * 1000; // 宿主内部 PowerShell 预算 25s + 启动开销

function fetchBluetoothDevices() {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (err) {
      reject(new Error(String((err && err.message) || err)));
      return;
    }

    let settled = false;
    let timer = null;
    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        port.disconnect();
      } catch (_) {}
      if (err) reject(err);
      else resolve(data);
    };

    timer = setTimeout(
      () => finish(new Error(`蓝牙查询超时（${BLUETOOTH_TIMEOUT_MS / 1000}s）—— 宿主可能被安全软件拦住了`)),
      BLUETOOTH_TIMEOUT_MS
    );

    port.onMessage.addListener((msg) => {
      if (msg && msg.error) finish(new Error(String(msg.error)));
      else finish(null, msg || {});
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError && chrome.runtime.lastError.message;
      finish(new Error(err || "native host 断开 —— 宿主可能没装或需要重装"));
    });

    try {
      port.postMessage({ type: "bluetooth" });
    } catch (err) {
      finish(new Error(String((err && err.message) || err)));
    }
  });
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
   Release Matrix 取数（cygnus）
   ------------------------------------------------------------
   面板要的是「region - version - PBF - NGX - QA-NGX」这五列，而站点是
   DataTables 的 serverSide 表格：POST 表单参数（columns/order/search/
   region/version）→ {data:[…]}，每行 = [name, nodes, overall, violations,
   product_lines, tags]。
   - region / version 行里没有单独字段，只能从行名
     `PRODUCT-REGION-VERSION-<14 位时间戳>` 拆（HOUYI-HKM-26M10W1-20260923004703）
   - 三个状态取 nodes[key].status，键名就是 PBF / NGX / QA-NGX
   请求体必须跟页面发的一致：实测少了 columns[…] / order[0] / search[value]
   服务端会「返回 0 行」而不是报错，所以这里照抄 DataTables 的序列化。
   放在 background 而不是新标签页：这样 DNR 注入的 cookie 与 X-CSRFToken
   来自同一次 chrome.cookies 读取（见 updateAuthRules 的注释）。
   ============================================================ */
const MATRIX_CACHE_KEY = "matrixReleases";
const MATRIX_TTL_MS = 5 * 60 * 1000; // release 状态变化慢，5 分钟足够
const MATRIX_PAGE_LENGTH = 10; // 与站点首页一致

/** "a, b,,c" → ["a","b","c"]（去空、去重）；全空时用 fallback（同样是逗号串）。 */
function commaList(raw, fallback) {
  const parts = String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const list = parts.length ? parts : String(fallback || "").split(",");
  return [...new Set(list)];
}

/** 站点表格的请求体（DataTables serverSide 的序列化，参数顺序无关）。 */
function buildMatrixBody({ region, version, start = 0, length = MATRIX_PAGE_LENGTH }) {
  const p = new URLSearchParams();
  p.set("draw", "1");
  for (let i = 0; i < 3; i++) {
    p.set(`columns[${i}][data]`, String(i));
    p.set(`columns[${i}][name]`, "");
    p.set(`columns[${i}][searchable]`, "true");
    p.set(`columns[${i}][orderable]`, i === 0 ? "false" : "true");
    p.set(`columns[${i}][search][value]`, "");
    p.set(`columns[${i}][search][regex]`, "false");
  }
  p.set("order[0][column]", "1"); // 与站点一致：按 Components 列倒序
  p.set("order[0][dir]", "desc");
  p.set("start", String(start));
  p.set("length", String(length));
  p.set("search[value]", "");
  p.set("search[regex]", "false");
  p.set("project", "");
  p.set("region", region);
  p.set("version", version);
  return p.toString();
}

/** 从 cookie 串里取一个 cookie 的值（没有则空串）。 */
function cookieValue(cookieStr, name) {
  for (const part of String(cookieStr || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

/** 行名 `PRODUCT-REGION-VERSION-<14 位时间戳>` → 四段；拆不出时原样返回 name。 */
function parseReleaseName(name) {
  const raw = String(name || "");
  const m = raw.match(/^(.*)-([A-Za-z]{2,})-(v?[0-9]{2}[A-Za-z][0-9A-Za-z._]*)-([0-9]{14})$/);
  if (!m) return { name: raw, product: "", region: "", version: "", builtAt: "" };
  return {
    name: raw,
    product: m[1],
    region: m[2].toUpperCase(),
    version: m[3].toUpperCase(),
    builtAt: m[4],
  };
}

/**
 * DataTables 响应 → 面板用的行（只保留要展示的字段）。
 * @param {string[]} stages 要展示的环节（站点 nodes 的键名，如 PBF / NGX / QA-NGX）；
 *   大小写不敏感匹配（用户写 qa-ngx 也能对上 QA-NGX）。
 */
function parseMatrixRows(json, stages) {
  const data = json && Array.isArray(json.data) ? json.data : [];
  const wanted = Array.isArray(stages) && stages.length ? stages : commaList("", MATRIX_DEFAULT_STAGES);
  return data.map((row) => {
    const name = String((row && row[0]) || "");
    const nodes = (row && row[1]) || {};
    const statuses = {};
    for (const key of wanted) {
      const realKey = nodes[key] ? key : Object.keys(nodes).find((k) => k.toLowerCase() === key.toLowerCase());
      const node = realKey ? nodes[realKey] : null;
      statuses[key] = node
        ? {
            status: String(node.status || ""),
            type: String(node.type || ""),
            atc: String(node.atc || ""),
            etc: String(node.etc || ""),
          }
        : null;
    }
    return {
      ...parseReleaseName(name),
      overall: String((row && row[2]) || ""),
      violations: Array.isArray(row && row[3]) ? row[3] : [0, ""],
      statuses,
    };
  });
}

async function readMatrixCache() {
  try {
    const obj = await chrome.storage.local.get(MATRIX_CACHE_KEY);
    return obj[MATRIX_CACHE_KEY] || null;
  } catch (_) {
    return null;
  }
}

/**
 * 取 Matrix release 列表。version / region / 环节 都取设置页配置（均逗号分隔）；
 * 缓存命中且三者都一致时直接返回，force=true 跳过缓存（↻ 语义）。
 */
async function fetchMatrixReleases(force) {
  const stored = await chrome.storage.sync.get({
    releaseMatrixVersion: MATRIX_DEFAULT_VERSION,
    releaseMatrixRegion: MATRIX_DEFAULT_REGION,
    releaseMatrixStages: MATRIX_DEFAULT_STAGES,
  });
  const version = String(stored.releaseMatrixVersion || "").trim() || MATRIX_DEFAULT_VERSION;
  const regions = commaList(stored.releaseMatrixRegion, MATRIX_DEFAULT_REGION);
  const stages = commaList(stored.releaseMatrixStages, MATRIX_DEFAULT_STAGES);
  const region = regions.join(",");

  const cached = force ? null : await readMatrixCache();
  const sameConfig =
    cached &&
    cached.version === version &&
    cached.region === region &&
    (cached.stages || []).join(",") === stages.join(",");
  if (sameConfig && Date.now() - (cached.ts || 0) < MATRIX_TTL_MS) {
    return { ok: true, cached: true, ...cached };
  }

  // 这一次读到的 cygnus cookie 同时用于 DNR 注入与 X-CSRFToken
  const { cygnusCookie } = await updateAuthRules();
  const csrf = cookieValue(cygnusCookie, "csrftoken");
  if (!cygnusCookie || !csrf) {
    throw new Error("没读到 cygnus.telenav.com 的登录 cookie —— 请先在浏览器登录该站点");
  }

  const resp = await fetch(CYGNUS_RELEASES_URL, {
    method: "POST",
    credentials: "omit", // cookie 由 DNR 规则 5 注入，避免 SameSite 丢 cookie / 重复
    cache: "no-store",
    headers: {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-CSRFToken": csrf,
      "X-Requested-With": "XMLHttpRequest",
    },
    body: buildMatrixBody({ region, version }),
  });

  if (resp.status === 403) throw new Error("HTTP 403 —— 请先在浏览器登录 cygnus.telenav.com，再点 ↻");
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  let json;
  try {
    json = await resp.json();
  } catch (_) {
    throw new Error("返回的不是 JSON（多半被重定向到登录页）—— 请登录 cygnus.telenav.com");
  }

  const rows = parseMatrixRows(json, stages);
  const payload = {
    ts: Date.now(),
    at: new Date().toISOString(),
    version,
    region,
    regions,
    stages,
    rows,
    filtered: Number(json.recordsFiltered) || rows.length,
    total: Number(json.recordsTotal) || rows.length,
  };
  try {
    await chrome.storage.local.set({ [MATRIX_CACHE_KEY]: payload });
  } catch (err) {
    console.error("[matrix] cache save failed:", err);
  }
  return { ok: true, ...payload };
}

/* ============================================================
   贝壳 PC 站（<city>.ke.com）二手房 —— 给安居客气泡当第三方信息源
   ------------------------------------------------------------
   为什么用 PC 站而不是移动站（m.ke.com）：
     移动站小区页经常直接 302 到 hip.ke.com/captcha（验证码）；PC 站没登录时
     跳 clogin.ke.com 登录页，风控压力小得多。
   两段取数：
     1) 联想 GET /api/headerSearchForPlatC?channel=ershoufang
              &cityId=<6 位城市 adcode>&query=<小区名>
        —— cityId 必填，缺了返回空；count 即在售套数，url 即小区在售列表页。
        结果里混着地铁站/商圈，只认 sugTypeName.text === "小区" 或 /ershoufang/c<id>/。
     2) 列表页 GET <city>.ke.com/ershoufang/c<id>/
        —— 需要登录 cookie（DNR 规则 6 注入）。页面是服务端渲染的
        ul.sellListContent > li。service worker 没有 DOMParser，所以这里只取 HTML，
        交给内容脚本解析，解析结果再经 beike-cache-put 回写缓存。
   风控：按 城市|小区名 缓存 6h；连续失败 2 次熔断 3 分钟，避免拿用户账号撞验证码。
   ============================================================ */
const BEIKE_TTL_MS = 6 * 60 * 60 * 1000;
const BEIKE_CACHE_MAX = 60; // 缓存条目上限
const BEIKE_MAX_FAILS = 2; // 连续失败几次后暂停自动取数
const BEIKE_COOLDOWN_MS = 3 * 60 * 1000; // 暂停多久后自动再试一次
const BEIKE_CITY_RE = /^[a-z]{2,12}$/;

// 城市子域 → 联想接口要的 cityId（城市级 adcode）。
// 安居客地图页主机首段就是城市拼音（xa.fang.anjuke.com → xa）；认不出兜底西安。
const BEIKE_CITY_IDS = {
  xa: "610100",
  bj: "110000",
  sh: "310000",
  tj: "120000",
  cq: "500000",
  gz: "440100",
  sz: "440300",
  cd: "510100",
  hz: "330100",
  nj: "320100",
  wh: "420100",
  cs: "430100",
  zz: "410100",
  jn: "370100",
  qd: "370200",
  dl: "210200",
  sy: "210100",
  xm: "350200",
  fz: "350100",
  hf: "340100",
  nc: "360100",
  hrb: "230100",
  cc: "220100",
  sjz: "130100",
  ty: "140100",
  hhht: "150100",
  lz: "620100",
  su: "320500",
  wx: "320200",
  nb: "330200",
  dg: "441900",
  fs: "440600",
  zh: "440400",
  huizhou: "441300",
  quanzhou: "350500",
};

let beikeFails = 0; // 连续失败计数（service worker 生命周期内）
let beikeLastError = ""; // 上次真实失败原因（熔断时要把原因一起说出来）
let beikeBlockedUntil = 0; // 冷却截止时间：到点自动恢复

/** 带硬超时的 fetch —— 贝壳偶发拖住连接时，必须给出结论而不是永远 pending。 */
async function fetchWithTimeout(url, opts, ms, what) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (err) {
    if (err && err.name === "AbortError") throw new Error(`${what}超时（${Math.round(ms / 1000)}s 无响应）`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function beikeOrigin(city) {
  return `https://${city}.ke.com`;
}

function beikeCityId(city) {
  return BEIKE_CITY_IDS[String(city || "").toLowerCase()] || BEIKE_CITY_IDS.xa;
}

/** 联想接口 URL（city 为城市拼音子域，如 xa；cityId 为 6 位城市 adcode）。 */
function beikeSugUrl(city, cityId, name) {
  const qs = new URLSearchParams({ channel: "ershoufang", cityId, query: name });
  return `${beikeOrigin(city)}/api/headerSearchForPlatC?${qs.toString()}`;
}

/**
 * 联想响应 → 最佳小区。
 * result 里会混进地铁站/商圈/写字楼，只认 sugTypeName.text === "小区"
 * 或 url 是 /ershoufang/c<数字>/ 的条目。
 */
function parseBeikeSug(json, query, origin) {
  const data = (json || {}).data;
  const list = Array.isArray(data) ? [] : (data && data.result) || [];
  if (!Array.isArray(list) || !list.length) return null;

  const squash = (s) => String(s || "").replace(/\s+/g, "");
  const q = squash(query);
  const community = list.filter((it) => {
    const type = String((it.sugTypeName && it.sugTypeName.text) || "");
    return type === "小区" || /\/ershoufang\/c\d+/.test(String(it.url || ""));
  });
  if (!community.length) return null;

  const hit = community.find((it) => squash(it.text) === q) || community[0];
  if (!hit || !hit.id) return null;
  const rel = String(hit.url || "").replace(/\?.*$/, "");
  return {
    id: String(hit.id),
    name: String(hit.text || ""),
    region: String(hit.region || "").trim().replace(/\s+/g, " "),
    count: Number(hit.count) || 0,
    exact: squash(hit.text) === q,
    url: rel ? new URL(rel, origin).toString() : `${origin}/ershoufang/c${hit.id}/`,
  };
}

async function readBeikeCache() {
  try {
    const obj = await chrome.storage.local.get(BEIKE_CACHE_KEY);
    return obj[BEIKE_CACHE_KEY] || {};
  } catch (_) {
    return {};
  }
}

async function writeBeikeCache(map) {
  try {
    const keys = Object.keys(map)
      .sort((a, b) => (map[b].ts || 0) - (map[a].ts || 0))
      .slice(0, BEIKE_CACHE_MAX);
    const trimmed = {};
    for (const k of keys) trimmed[k] = map[k];
    await chrome.storage.local.set({ [BEIKE_CACHE_KEY]: trimmed });
  } catch (err) {
    console.error("[beike] cache save failed:", err);
  }
}

/** 内容脚本解析完 PC 页后回写缓存（background 里没有 DOMParser）。 */
async function cacheBeikePayload(name, city, payload) {
  const q = String(name || "").trim();
  if (!q || !payload || !Array.isArray(payload.listings)) return { ok: false };
  const c = BEIKE_CITY_RE.test(String(city || "")) ? String(city) : "xa";
  const cache = await readBeikeCache();
  cache[`${c}|${q}`] = { ts: Date.now(), payload };
  await writeBeikeCache(cache);
  return { ok: true, key: `${c}|${q}` };
}

/**
 * 小区名 → 贝壳 PC 小区在售页。
 * 命中缓存返回 { ok:true, cached:true, ...payload }；
 * 否则返回 { ok:true, hit, html, city, cityId }（HTML 交给内容脚本解析）。
 * 未匹配到小区返回 { ok:true, miss:true }（不是错误）；登录/风控问题抛错。
 */
async function fetchBeikeCommunity(name, city, force) {
  const q = String(name || "").trim();
  if (!q) throw new Error("楼盘名为空");
  const c = BEIKE_CITY_RE.test(String(city || "")) ? String(city) : "xa";
  const key = `${c}|${q}`;

  const cache = await readBeikeCache();
  if (!force && cache[key] && Date.now() - (cache[key].ts || 0) < BEIKE_TTL_MS) {
    return { ok: true, cached: true, ...cache[key].payload };
  }
  if (!force && Date.now() < beikeBlockedUntil) {
    const left = Math.ceil((beikeBlockedUntil - Date.now()) / 1000);
    throw new Error(`已暂停自动取数（上次失败：${beikeLastError || "未知"}）—— ${left}s 后自动恢复，也可点「查贝壳」立即重试`);
  }

  try {
    return await beikeAttempt({ name: q, city: c, cityId: beikeCityId(c) });
  } catch (err) {
    beikeFails++;
    beikeLastError = String((err && err.message) || err);
    if (beikeFails >= BEIKE_MAX_FAILS) beikeBlockedUntil = Date.now() + BEIKE_COOLDOWN_MS;
    throw err;
  }
}

/** 真正干活的两次请求（失败记账在调用方，避免熔断自身也被计数）。 */
async function beikeAttempt(ctx) {
  const { name, city, cityId } = ctx;
  const origin = beikeOrigin(city);

  // ① 联想：小区名 → 贝壳小区（无需登录）
  const sugResp = await fetchWithTimeout(
    beikeSugUrl(city, cityId, name),
    { credentials: "omit", cache: "no-store" },
    10000,
    "贝壳联想接口"
  );
  if (!sugResp.ok) throw new Error(`贝壳联想接口 HTTP ${sugResp.status}`);
  const hit = parseBeikeSug(await sugResp.json(), name, origin);
  if (!hit) return { ok: true, miss: true, name, city, cityId, at: new Date().toISOString() };

  // ② 小区在售列表页：登录 cookie 由 DNR 规则 6 注入（与这次读取同源）。
  // 读不到 cookie 也照样发：没注入时站点会跳登录页，由响应给出更准确的提示。
  const { keCookie } = await updateAuthRules();
  if (!keCookie) console.warn("[beike] chrome.cookies 读不到 ke.com cookie，直接尝试请求");
  const pageResp = await fetchWithTimeout(
    hit.url,
    { credentials: "omit", cache: "no-store" },
    15000,
    "贝壳小区页"
  );
  const finalUrl = pageResp.url || "";
  if (/clogin\.ke\.com|\/login/i.test(finalUrl)) {
    throw new Error(`需要登录贝壳：请先在浏览器里打开并登录 ${city}.ke.com，再点「查贝壳」`);
  }
  if (/hip\.ke\.com|captcha/i.test(finalUrl)) {
    throw new Error(`被贝壳风控拦截（验证码页）—— 请在浏览器里打开一次 ${city}.ke.com 通过验证`);
  }
  if (!pageResp.ok) throw new Error(`贝壳小区页 HTTP ${pageResp.status}`);
  const html = await pageResp.text();
  if (!html || html.length < 500) throw new Error("贝壳小区页返回内容过短（可能被拦截）");

  return { ok: true, hit, html, city, cityId, at: new Date().toISOString() };
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
  if (msg && msg.type === "matrix-releases") {
    fetchMatrixReleases(msg.force === true)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // 异步响应
  }
  if (msg && msg.type === "bluetooth") {
    fetchBluetoothDevices()
      .then((data) => sendResponse({ ok: true, ...data }))
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

  // 贝壳二手房（安居客气泡里的第三方信息源）。force=true = 用户手点「查贝壳」。
  if (msg.type === "beike-community") {
    // 失败计数在 fetchBeikeCommunity 内部按「真实尝试」记，这里只回传状态
    fetchBeikeCommunity(msg.name, msg.city, msg.force === true)
      .then(sendResponse)
      .catch((e) =>
        sendResponse({
          ok: false,
          error: String((e && e.message) || e),
          fails: beikeFails,
          lastError: beikeLastError,
          blockedUntil: beikeBlockedUntil,
        })
      );
    return true; // 异步响应
  }

  // 内容脚本解析完 PC 小区页后回写缓存（service worker 没有 DOMParser）。
  if (msg.type === "beike-cache-put") {
    cacheBeikePayload(msg.name, msg.city, msg.payload)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
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
