/* ============================================================
   cursor.js — Cursor 用量/排名直连（替代后端代理）   - host_permissions 使扩展页免 CORS
   - Cookie / Origin / Referer 由 background 的 DNR 动态规则注入
     （见 background.js updateAuthRules），因此这里用
     credentials:"omit"，只设 Accept / Content-Type。
   ============================================================ */

// 文档生命周期内缓存（面板每次打开重载自然失效），
// 避免 leaderboard / usage 各读一次 sync storage + cookie。
let cursorSettingsCache = null;

async function getCursorSettings() {
  if (cursorSettingsCache) return cursorSettingsCache;

  const s = await chrome.storage.sync.get({
    cursorTeamId: "",
    cursorUserId: "",
    cursorUserEmail: "",
  });

  // 设置里没填时，尝试从浏览器 cookie 自动推导（减少手动配置）：
  //   team_id   ← cookie `team_id`
  //   user_id   ← cookie `workos_id`（形如 user_XXXX，取数字部分）
  const cookieMap = {};
  const header = await getCookieHeader("https://cursor.com");
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) cookieMap[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }

  cursorSettingsCache = {
    cursorTeamId: s.cursorTeamId || cookieMap.team_id || "",
    cursorUserId: s.cursorUserId || (cookieMap.workos_id || "").replace(/^user_/, "") || "",
    cursorUserEmail: s.cursorUserEmail,
  };
  return cursorSettingsCache;
}

/**
 * 带 403 自愈的 fetch：403 时向 background 重新触发 refresh-auth
 * （DNR cookie 重注入，sendResponse 在规则更新完成后才返回），随后重试一次。
 * - cache:"no-store" 避免命中缓存的 403。
 * - 重试前稍等，让 DNR 规则更新真正落到请求层（updateDynamicRules 的
 *   Promise resolve 与请求头注入之间存在微小竞态）。
 * 非 403 或重试仍失败则照常抛错。
 */
async function cursorFetch(url, options) {
  const doFetch = () => fetch(url, { ...options, cache: "no-store" });
  const resp = await doFetch();
  if (resp.status === 403) {
    await chrome.runtime.sendMessage({ type: "refresh-auth" }).catch(() => {});
    await new Promise((r) => setTimeout(r, 250));
    const retry = await doFetch();
    if (!retry.ok) throw new Error(`HTTP ${retry.status}`);
    return retry;
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** 本地自然日范围（后端 leaderboard 使用） */
function cursorDateRangeDays(days) {
  const now = new Date();
  const endD = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startD = new Date(endD.getFullYear(), endD.getMonth(), endD.getDate() - (days - 1));
  const fmt = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return { startDate: fmt(startD), endDate: fmt(endD) };
}

/** UTC 日边界毫秒范围（含当天：结束取「明天 00:00 UTC」）。 */
function cursorDateRangeMs(days) {
  const now = new Date();
  // 结束边界不用「今天 23:59 UTC」而用「明天 00:00 UTC」：
  // cursor usage 接口把 endDate 向下取整到日、并当作排除边界，
  // 若传今天 23:59 会被取整成今天 00:00 → 当天事件整体被排除 → 图表只到昨天。
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0)
  );
  const start = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - days, 0, 0, 0, 0)
  );
  return { startMs: String(start.getTime()), endMs: String(end.getTime()) };
}

async function cursorFetchLeaderboardPeriod(days, settings) {
  const { startDate, endDate } = cursorDateRangeDays(days);
  const params = new URLSearchParams({
    startDate,
    endDate,
    pageSize: "10",
    teamId: settings.cursorTeamId,
    user: settings.cursorUserEmail,
    leaderboardSortBy: "composer_lines",
  });
  const url = `https://cursor.com/api/v2/analytics/team/leaderboard?${params}`;
  const resp = await cursorFetch(url, {
    credentials: "omit",
    headers: { accept: "application/json" },
  });
  const payload = await resp.json();
  const board = payload.composer_leaderboard || {};
  const entries = board.data || [];
  const me = entries.find((e) => e.email === settings.cursorUserEmail);
  if (!me) throw new Error(`user not found in leaderboard: ${settings.cursorUserEmail}`);
  return {
    days,
    start_date: startDate,
    end_date: endDate,
    rank: me.rank,
    total_users: board.total_users,
    composer_lines_accepted: me.total_composer_lines_accepted,
    diff_accepts: me.total_diff_accepts,
  };
}

/** 团队 composer-lines 排名（7d + 30d）。 */
async function fetchCursorLeaderboardApi() {
  const settings = await getCursorSettings();
  if (!settings.cursorTeamId) throw new Error("未检测到 Cursor team_id — 请先在浏览器登录 cursor.com，或到扩展设置填写");
  if (!settings.cursorUserEmail)
    throw new Error("未填写 Cursor user_email — 请到扩展设置（⚙）填写（排名需要）");
  const [rank7d, rank30d] = await Promise.all([
    cursorFetchLeaderboardPeriod(7, settings),
    cursorFetchLeaderboardPeriod(30, settings),
  ]);
  return { rank_7d: rank7d, rank_30d: rank30d };
}

/**
 * 当前账单周期的起止毫秒（Cursor 以 UTC 零点切账期，通常是一个自然月）。
 * dashboard 打开 usage 页时自己就会调这个接口，所以面板直接问它，
 * 不必猜「本月」是哪天到哪天（订阅日不同、账期起点也不同）。
 * 返回 { startAt, endAt, startMs, endMs }；endAt 是排他边界（下个账期起点）。
 */
async function fetchCursorBillingCycleApi() {
  const settings = await getCursorSettings();
  if (!settings.cursorTeamId) throw new Error("未检测到 Cursor team_id — 请先在浏览器登录 cursor.com，或到扩展设置填写");

  // 设置里的 team_id 是字符串；dashboard 自己发的 body 里是数字，跟随它。
  const teamId = /^\d+$/.test(settings.cursorTeamId) ? Number(settings.cursorTeamId) : settings.cursorTeamId;
  const resp = await cursorFetch("https://cursor.com/api/dashboard/get-monthly-billing-cycle", {
    method: "POST",
    credentials: "omit",
    headers: { accept: "*/*", "content-type": "application/json" },
    body: JSON.stringify({ teamId }),
  });
  const payload = await resp.json();
  const startAt = Number(payload?.startDateEpochMillis);
  const endAt = Number(payload?.endDateEpochMillis);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) {
    throw new Error("账单周期响应异常（缺 startDateEpochMillis / endDateEpochMillis）");
  }
  return { startAt, endAt, startMs: String(startAt), endMs: String(endAt) };
}

const CURSOR_USAGE_PAGE_SIZE = 1000; // 单页上限；账期事件量可能超 1000，必须翻页
const CURSOR_USAGE_MAX_PAGES = 10; // 兜底：最多 1 万条事件

/**
 * 用量事件（区间内全部事件，已按 totalUsageEventsCount 翻页补齐）。
 * @param {{startMs:string,endMs:string}|null} range 不传则用最近 30 天（面板默认口径）
 * @returns 与接口原响应同形（usageEventsDisplay + totalUsageEventsCount），
 *          外加 startDate/endDate，便于 UI 显示这次取的是哪一段。
 */
async function fetchCursorUsageApi(range) {
  const settings = await getCursorSettings();
  if (!settings.cursorTeamId) throw new Error("未检测到 Cursor team_id — 请先在浏览器登录 cursor.com，或到扩展设置填写");
  if (!settings.cursorUserId) throw new Error("未检测到 Cursor user_id — 请到扩展设置（⚙）填写");

  const { startMs, endMs } = range || cursorDateRangeMs(30);
  const events = [];
  let total = 0;

  for (let page = 1; page <= CURSOR_USAGE_MAX_PAGES; page++) {
    const payload = {
      teamId: settings.cursorTeamId,
      startDate: startMs,
      endDate: endMs,
      userId: settings.cursorUserId,
      page,
      pageSize: CURSOR_USAGE_PAGE_SIZE,
    };
    const resp = await cursorFetch("https://cursor.com/api/dashboard/get-filtered-usage-events", {
      method: "POST",
      credentials: "omit",
      headers: { accept: "*/*", "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await resp.json();
    // 接口出错时返回 {"error":{"message":"Error"}}（常见于 user_id 不是 dashboard 里的数字 id）
    if (json && json.error && !json.usageEventsDisplay) {
      throw new Error(`usage 接口报错（检查 user_id 是否为 dashboard 里的数字 id）: ${json.error.message || "Error"}`);
    }
    const chunk = Array.isArray(json)
      ? json
      : (json.usageEventsDisplay ?? json.events ?? json.usageEvents ?? json.data ?? []);
    total = Number(json?.totalUsageEventsCount ?? 0) || total;
    events.push(...chunk);
    if (!chunk.length) break;
    if (total && events.length >= total) break;
    if (chunk.length < CURSOR_USAGE_PAGE_SIZE) break; // 短页 = 没有下一页
  }

  // 翻页边界可能重叠（服务端按时间倒序/游标不稳定），按事件 id 去重
  const seen = new Set();
  const unique = events.filter((ev) => {
    const key = ev.usageEventId ?? `${ev.timestamp}|${ev.conversationId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    usageEventsDisplay: unique,
    totalUsageEventsCount: total || unique.length,
    startDate: startMs,
    endDate: endMs,
  };
}

/**
 * 本账期合计（只给「本月消耗」芯片用）。
 * 单独一次 get-filtered-usage-events（范围 = get-monthly-billing-cycle 返回的账期），
 * 与 30 天曲线同一接口、同一字段（chargedCents），两个数字口径一致；
 * 账期接口取不到会抛错，由调用方降级成「—」，不影响 30 天曲线。
 */
async function fetchCursorMonthUsage() {
  const cycle = await fetchCursorBillingCycleApi();
  const usage = await fetchCursorUsageApi(cycle);
  const events = Array.isArray(usage) ? usage : (usage.usageEventsDisplay ?? []);
  let cents = 0;
  let tokens = 0;
  for (const ev of events) {
    const tu = ev.tokenUsage ?? {};
    cents += Number(ev.chargedCents ?? ev.charged_cents ?? tu.totalCents ?? 0);
    tokens += Number(
      ev.totalTokens ?? ev.total_tokens ?? ev.tokens ?? ((tu.inputTokens ?? 0) + (tu.outputTokens ?? 0))
    );
  }
  return { cents, tokens, events: events.length, startAt: cycle.startAt, endAt: cycle.endAt };
}
