/* ============================================================
   logshed.js — Logshed 可达性探测 + 6h 时间线
   面板打开/点刷新时探测；历史存 chrome.storage.local。
   ============================================================ */
const LOGSHED_STORAGE_KEY = "logshedHistory";
const LOGSHED_HOURS = 6;
const LOGSHED_MINUTES = LOGSHED_HOURS * 60; // 360 个分钟桶
const LOGSHED_MAX_FAILURES = 20;
const LOGSHED_DEFAULT_URL = "http://logshed-search-eu.prod.mypna.com/";
const LOGSHED_NAME = "Logshed Search EU";

async function getLogshedUrl() {
  const s = await chrome.storage.sync.get({ logshedUrl: LOGSHED_DEFAULT_URL });
  return (s.logshedUrl || LOGSHED_DEFAULT_URL).trim() || LOGSHED_DEFAULT_URL;
}

async function loadLogshedData() {
  const obj = await chrome.storage.local.get(LOGSHED_STORAGE_KEY);
  return (
    obj[LOGSHED_STORAGE_KEY] || {
      name: LOGSHED_NAME,
      url: LOGSHED_DEFAULT_URL,
      current: null,
      recent_failures: [],
      timeline: [],
    }
  );
}

async function saveLogshedData(data) {
  await chrome.storage.local.set({ [LOGSHED_STORAGE_KEY]: data });
}

/**
 * 探测一次 Logshed 并写入历史。成功规则：200 <= code < 500。
 * 返回更新后的历史数据。
 */
async function probeLogshed() {
  const url = await getLogshedUrl();
  const start = Date.now();
  let ok = false;
  let statusCode = null;
  let error = null;
  try {
    const resp = await fetch(url, { cache: "no-store", redirect: "follow" });
    statusCode = resp.status;
    ok = statusCode >= 200 && statusCode < 500;
  } catch (err) {
    error = String((err && err.message) || err);
  }
  const elapsedMs = Date.now() - start;
  const now = new Date();

  const data = await loadLogshedData();
  data.name = data.name || LOGSHED_NAME;
  data.url = url;
  data.last_probe_at = now.toISOString();
  data.current = { ok, status_code: statusCode, elapsed_ms: elapsedMs, error };

  if (!ok) {
    data.recent_failures = data.recent_failures || [];
    data.recent_failures.unshift({ at: now.toISOString(), error: error || `HTTP ${statusCode}` });
    data.recent_failures = data.recent_failures.slice(0, LOGSHED_MAX_FAILURES);
  }

  // timeline：每分钟一条，保留最近 6h，去重同一分钟内的旧条目
  const minuteKey = Math.floor(now.getTime() / 60000) * 60000;
  const cutoff = now.getTime() - (LOGSHED_MINUTES - 1) * 60000;
  data.timeline = (data.timeline || []).filter((it) => {
    const ts = new Date(it.at).getTime();
    return ts >= cutoff && Math.floor(ts / 60000) * 60000 !== minuteKey;
  });
  data.timeline.push({ at: now.toISOString(), ok });
  data.timeline.sort((a, b) => new Date(a.at) - new Date(b.at));
  data.timeline = data.timeline.slice(-LOGSHED_MINUTES);

  await saveLogshedData(data);
  return data;
}

/** 把 timeline 聚合为 6h 分钟桶（对齐后端 logshed_storage.compute_timeline_6h）。 */
function computeTimeline6h(data) {
  const end = new Date();
  end.setSeconds(0, 0);
  const endTs = end.getTime();
  const startTs = endTs - (LOGSHED_MINUTES - 1) * 60000;

  const map = {};
  for (const it of data.timeline || []) {
    const ts = Math.floor(new Date(it.at).getTime() / 60000) * 60000;
    if (ts >= startTs && ts <= endTs) map[ts] = !!it.ok;
  }

  const buckets = [];
  let totalOk = 0;
  let totalFail = 0;
  for (let i = 0; i < LOGSHED_MINUTES; i++) {
    const t = startTs + i * 60000;
    let ok = 0;
    let fail = 0;
    if (t in map) {
      ok = map[t] ? 1 : 0;
      fail = 1 - ok;
    }
    totalOk += ok;
    totalFail += fail;
    const d = new Date(t);
    buckets.push({
      start: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
      ok,
      fail,
      total: ok + fail,
    });
  }

  const total = totalOk + totalFail;
  const uptimePct = total ? Math.round((totalOk / total) * 10000) / 100 : null;
  return {
    granularity: "minute",
    hours: LOGSHED_HOURS,
    uptime_pct: uptimePct,
    total_ok: totalOk,
    total_fail: totalFail,
    total_probes: total,
    buckets,
  };
}
