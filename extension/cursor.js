/* ============================================================
   cursor.js — Cursor 用量/排名直连（替代后端代理）
   - host_permissions 使扩展页免 CORS
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
 * 非 403 或重试仍失败则照常抛错。
 */
async function cursorFetch(url, options) {
  const doFetch = () => fetch(url, options);
  const resp = await doFetch();
  if (resp.status === 403) {
    await chrome.runtime.sendMessage({ type: "refresh-auth" }).catch(() => {});
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

/** 用量事件原始响应（结构与后端代理返回一致，供 script.js 聚合）。 */
async function fetchCursorUsageApi() {
  const settings = await getCursorSettings();
  if (!settings.cursorTeamId) throw new Error("未检测到 Cursor team_id — 请先在浏览器登录 cursor.com，或到扩展设置填写");
  if (!settings.cursorUserId) throw new Error("未检测到 Cursor user_id — 请到扩展设置（⚙）填写");

  const days = 30; // 图表显示最近 30 天
  const { startMs, endMs } = cursorDateRangeMs(days);
  const payload = {
    teamId: settings.cursorTeamId,
    startDate: startMs,
    endDate: endMs,
    userId: settings.cursorUserId,
    page: 1,
    pageSize: 1000, // 30 天事件量可能超 500,调大单页上限
  };

  const resp = await cursorFetch("https://cursor.com/api/dashboard/get-filtered-usage-events", {
    method: "POST",
    credentials: "omit",
    headers: { accept: "*/*", "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await resp.json();
}
