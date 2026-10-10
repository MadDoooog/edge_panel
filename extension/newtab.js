/* ============================================================
   newtab.js — 新标签页悬浮仪表盘（替代原侧边栏面板）

   三张卡片：Cursor 费用 / 服务器磁盘 / Release Matrix 跳转。
   数据源与原面板一致：
   - cursor.js 直连 cursor.com（Cookie/Referer 由 background 的 DNR 注入）
   - metrics.js + background 经 Native Messaging 采集 SSH 磁盘（采集由
     background 持有，关闭本页也会继续）
   本文件只负责渲染、卡片拖动/折叠与位置持久化。
   ============================================================ */

const CARD_STATE_KEY = "newtabCards";
const METRICS_STALE_MS = 24 * 60 * 60 * 1000;
const COLLECT_STALL_MS = 2 * 60 * 1000;
const DU_TOP_N = 3;

const CURSOR_CACHE_KEY = "cursorCache";
const CURSOR_CACHE_TTL_MS = 10 * 60 * 1000;

const RELEASE_MATRIX_BASE_URL =
  "https://cygnus.telenav.com/release_matrix/releases/index?mo=t&region=hkm%252Cisc%252Csea&version=";
const RELEASE_MATRIX_DEFAULT_VERSION = "26q3";

// 首次打开时的落位（之后以用户拖动的位置为准）
const DEFAULT_POS = {
  cursor: { x: 40, y: 40 },
  servers: { x: 40, y: 400 },
  matrix: { x: 520, y: 40 },
};

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

document.getElementById("open-options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// 等 background 刷新 DNR 头注入规则（cookie/referer）后再发起直连请求
const authReady = chrome.runtime.sendMessage({ type: "refresh-auth" }).catch(() => {});

/* ============================================================
   卡片：拖动 / 点击折叠 / 位置持久化
   ============================================================ */
let cardState = {};

async function loadCardState() {
  const obj = await chrome.storage.local.get(CARD_STATE_KEY);
  return obj[CARD_STATE_KEY] || {};
}

function saveCardState() {
  chrome.storage.local.set({ [CARD_STATE_KEY]: cardState }).catch(() => {});
}

function clampAndPlace(el, x, y) {
  const w = el.offsetWidth || 300;
  const h = el.offsetHeight || 60;
  const nx = Math.max(4, Math.min(window.innerWidth - w - 4, x));
  const ny = Math.max(4, Math.min(window.innerHeight - Math.min(h, 60) - 4, y));
  el.style.left = `${Math.round(nx)}px`;
  el.style.top = `${Math.round(ny)}px`;
}

function applyCardState() {
  for (const key of Object.keys(DEFAULT_POS)) {
    const el = document.getElementById(`card-${key}`);
    if (!el) continue;
    const st = cardState[key] || {};
    const def = DEFAULT_POS[key];
    el.classList.toggle("collapsed", st.collapsed === true);
    clampAndPlace(el, Number.isFinite(st.x) ? st.x : def.x, Number.isFinite(st.y) ? st.y : def.y);
  }
}

function bindCardChrome() {
  for (const el of document.querySelectorAll(".card")) {
    const key = el.dataset.card;
    const head = el.querySelector(".card-head");
    let drag = null;

    head.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button, a")) return;
      const r = el.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId, moved: 0, sx: e.clientX, sy: e.clientY };
      el.classList.add("dragging");
      try {
        head.setPointerCapture(e.pointerId);
      } catch (_) {}
    });

    head.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag.moved = Math.max(drag.moved, Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy));
      clampAndPlace(el, e.clientX - drag.dx, e.clientY - drag.dy);
    });

    const end = (e) => {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      const moved = drag.moved;
      drag = null;
      el.classList.remove("dragging");
      const st = cardState[key] || {};
      st.x = parseInt(el.style.left, 10) || 0;
      st.y = parseInt(el.style.top, 10) || 0;
      // 没移动 = 单击标题栏 → 折叠/展开（与原面板行为一致）
      if (moved < 4) st.collapsed = !el.classList.contains("collapsed");
      cardState[key] = st;
      saveCardState();
      applyCardState();
    };
    head.addEventListener("pointerup", end);
    head.addEventListener("pointercancel", end);
  }

  window.addEventListener("resize", applyCardState);
}

/* ============================================================
   服务器磁盘（SSH，Native Messaging）
   ============================================================ */
function renderServer(srv) {
  const card = document.createElement("div");
  card.className = "server-card";

  if (srv.status !== "ok") {
    card.innerHTML = `
      <div class="server-main">
        <div class="server-name"><div class="status-dot error"></div><span>${escHtml(srv.name)}</span></div>
      </div>
      <div class="error-msg">&#9888; 采集失败</div>`;
    return card;
  }

  // 占用：优先根分区 /，否则取第一块真实块设备盘；色条 + 百分比
  const disks = (srv.disks || []).filter((d) => d.device?.startsWith("/dev/"));
  const occDisk = disks.find((d) => d.mountpoint === "/") || disks[0];
  const occPct = occDisk ? Math.round(occDisk.percent) : null;
  const pct = occPct == null ? 0 : Math.max(0, Math.min(100, occPct));
  const barCls = occPct != null && occPct >= 80 ? " danger" : "";

  // du top3：du_paths 各路径已按 du -sh | sort -rh 降序，扁平取前 3
  const duItems = [];
  for (const items of Object.values(srv.du_data || {})) {
    if (!items || !items.length) continue;
    for (const it of items) {
      duItems.push(it);
      if (duItems.length >= DU_TOP_N) break;
    }
    if (duItems.length >= DU_TOP_N) break;
  }
  const duHtml = duItems.length
    ? `<div class="server-du">${duItems
        .map(
          (it) =>
            `<div class="du-row" title="${escHtml(it.full_path || it.name)}"><span class="du-name">${escHtml(
              it.name
            )}</span><span class="du-size">${escHtml(it.size)}</span></div>`
        )
        .join("")}</div>`
    : "";

  card.innerHTML = `
    <div class="server-cols">
      <div class="server-main">
        <div class="server-name"><div class="status-dot ok"></div><span>${escHtml(srv.name)}</span></div>
        <div class="server-usage-bar"><div class="server-usage-fill${barCls}" style="width:${pct}%"></div></div>
        <div class="server-usage"><span>占用</span> <span class="server-usage-pct">${
          occPct == null ? "—" : `${occPct}%`
        }</span></div>
      </div>
      ${duHtml}
    </div>`;
  return card;
}

function renderMetrics(data) {
  const container = document.getElementById("servers-container");
  const updated = document.getElementById("servers-updated");
  if (!container) return;
  container.innerHTML = "";
  const servers = data.servers ?? [];
  if (!servers.length) container.innerHTML = '<div class="loading">暂无 SSH 目标</div>';
  else servers.forEach((srv) => container.appendChild(renderServer(srv)));
  if (updated) updated.textContent = `更新于 ${data.last_updated ?? "—"}`;
}

/* 采集进度：面板先展示最近一次缓存，进度由 background 流式上报并持久化 */
function renderProgressLine(p) {
  const updated = document.getElementById("servers-updated");
  if (!updated) return;
  const total = p.total || 0;
  const done = p.done || 0;
  const cur = p.current ? ` · 当前: ${escHtml(p.current)}` : "";
  const err = p.error ? ` · ${escHtml(p.error)}` : "";
  updated.textContent = `正在采集 ${done}/${total}${cur}${err}`;
  document.getElementById("servers-refresh")?.classList.add("spinning");
}

function renderMetricsErrorLine(cached, err) {
  const updated = document.getElementById("servers-updated");
  if (!updated) return;
  updated.textContent = cached ? `缓存 ${cached.last_updated ?? "—"} (${escHtml(err.message)})` : "采集失败";
  document.getElementById("servers-refresh")?.classList.remove("spinning");
}

/** 请求后台发起一次 SSH 采集（force=true 时重启正在进行的采集）。 */
function requestMetricsCollection(force = false) {
  chrome.runtime.sendMessage({ type: "start-collect", force }).catch(() => {});
  const updated = document.getElementById("servers-updated");
  if (updated) updated.textContent = "正在采集…";
  document.getElementById("servers-refresh")?.classList.add("spinning");
}

/** 后台广播的采集完成通知（成功或出错）。 */
async function handleMetricsDone(msg) {
  document.getElementById("servers-refresh")?.classList.remove("spinning");
  if (msg.error) {
    const cached = await loadMetricsCache();
    if (cached) {
      renderMetrics(cached);
      renderMetricsErrorLine(cached, new Error(msg.error));
    } else {
      renderMetricsError(new Error(msg.error));
    }
    return;
  }
  await saveMetricsCache(msg.data);
  renderMetrics(msg.data);
  const updated = document.getElementById("servers-updated");
  if (updated) updated.textContent = `更新于 ${msg.data.last_updated ?? "—"}`;
}

// 实时进度 / 完成通知（后台广播）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "metrics-progress") renderProgressLine(msg.progress);
  else if (msg && msg.type === "metrics-done") handleMetricsDone(msg);
});

/** 采集失败时的提示与操作按钮（宿主未安装 / 未配置 SSH 服务器等）。 */
function renderMetricsError(err) {
  const container = document.getElementById("servers-container");
  const updated = document.getElementById("servers-updated");
  if (!container) return;
  const msg = String(err && err.message ? err.message : err);
  const actions = [{ act: "open-options", label: "打开设置" }];
  if (isNativeHostMissing(err)) actions.unshift({ act: "install-host", label: "下载并安装 Native 宿主" });
  const btns = actions
    .map((a) => `<button type="button" class="metric-action" data-act="${a.act}">${a.label}</button>`)
    .join("");
  container.innerHTML = `<div class="loading" style="color:#f06b6b">${escHtml(
    msg
  )}</div><div class="metric-actions">${btns}</div>`;
  for (const b of container.querySelectorAll(".metric-action")) {
    b.addEventListener("click", () => {
      if (b.dataset.act === "open-options") {
        chrome.runtime.openOptionsPage();
        return;
      }
      if (b.dataset.act === "install-host") {
        b.textContent = "下载中…";
        b.disabled = true;
        installNativeHost()
          .then(() => {
            b.textContent = "✓ 已下载";
            if (updated) updated.textContent = "已下载到 下载/edge-panel-host/，请双击 install-edge-panel-host.bat";
          })
          .catch((e) => {
            b.textContent = "下载失败";
            b.disabled = false;
            if (updated) updated.textContent = "下载失败: " + escHtml(e.message);
          });
      }
    });
  }
  if (updated) updated.textContent = "采集失败";
}

/** 缓存是否已过期（距 last_updated 超过 24h）。无缓存视为过期。 */
function metricsStale(cached) {
  if (!cached || !cached.last_updated) return true;
  const t = Date.parse(cached.last_updated);
  if (Number.isNaN(t)) return true;
  return Date.now() - t >= METRICS_STALE_MS;
}

async function initMetrics() {
  const cached = await loadMetricsCache();
  if (cached) renderMetrics(cached); // 先展示缓存

  const progress = await loadMetricsProgress();
  if (progress && progress.running) {
    const t = Date.parse(progress.lastEventAt || progress.startedAt || "");
    if (!Number.isNaN(t) && Date.now() - t > COLLECT_STALL_MS) {
      requestMetricsCollection(false); // 采集疑似中断（浏览器/宿主异常退出），重新发起
    } else {
      renderProgressLine(progress);
    }
    return;
  }

  if (metricsStale(cached)) requestMetricsCollection(false); // 24h 内不重复 SSH 查询
}
document.getElementById("servers-refresh").addEventListener("click", () => requestMetricsCollection(true));

/* ============================================================
   Cursor 费用
   ============================================================ */
let cursorChartInst = null;
let cursorStatsData = null;
let cursorLeaderboard = undefined;

async function loadCursorCache() {
  const obj = await chrome.storage.local.get(CURSOR_CACHE_KEY);
  const c = obj[CURSOR_CACHE_KEY];
  if (!c || !c.usage || Date.now() - (c.ts || 0) > CURSOR_CACHE_TTL_MS) return null;
  return c;
}

async function saveCursorCache(usage, leaderboard) {
  await chrome.storage.local.set({
    [CURSOR_CACHE_KEY]: { ts: Date.now(), usage, leaderboard: leaderboard === undefined ? null : leaderboard },
  });
}

function rankChipsHtml() {
  const chip = (label, value) =>
    `<span class="stat-chip"><span class="stat-label">${label}</span><span class="stat-cnt">${value}</span></span>`;
  if (cursorLeaderboard === undefined) return chip("7天排名", "…") + chip("30天排名", "…");
  if (cursorLeaderboard === null) return chip("7天排名", "—") + chip("30天排名", "—");
  const fmt = (key) => {
    const r = cursorLeaderboard[key]?.rank;
    return r != null ? `#${r}` : "—";
  };
  return chip("7天排名", fmt("rank_7d")) + chip("30天排名", fmt("rank_30d"));
}

function renderCursorStatsPanel() {
  const statsEl = document.getElementById("cursor-stats");
  if (!statsEl) return;
  if (!cursorStatsData) {
    statsEl.innerHTML = rankChipsHtml();
    return;
  }
  const { events, totalTokens, totalCents, modelCounts } = cursorStatsData;
  const topModels = Object.entries(modelCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(
      ([m, c]) =>
        `<span class="stat-chip"><span class="stat-model">${escHtml(m)}</span><span class="stat-cnt">${c}</span></span>`
    )
    .join("");
  statsEl.innerHTML = `${rankChipsHtml()}
    <span class="stat-chip"><span class="stat-label">请求</span><span class="stat-cnt">${events.length}</span></span>
    <span class="stat-chip"><span class="stat-label">Tokens</span><span class="stat-cnt">${totalTokens.toLocaleString()}</span></span>
    <span class="stat-chip"><span class="stat-label">费用</span><span class="stat-cnt">$${(totalCents / 100).toFixed(2)}</span></span>
    ${topModels}`;
}

async function fetchCursorLeaderboard() {
  cursorLeaderboard = undefined;
  renderCursorStatsPanel();
  try {
    cursorLeaderboard = await fetchCursorLeaderboardApi();
  } catch (err) {
    console.error("[cursor-leaderboard] error:", err);
    cursorLeaderboard = null;
  }
  renderCursorStatsPanel();
}

let lastChartData = null; // 主题切换时重绘图表用

/** 图表配色取自 theme.css 的 CSS 变量，亮/暗主题下都协调。 */
function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name) || "").trim() || fallback;
  return {
    text: v("--text", "#202124"),
    muted: v("--text-muted", "#5f6368"),
    accent: v("--accent", "#1a73e8"),
    warn: v("--warn", "#b06000"),
    grid: v("--border", "#dadce0"),
  };
}

function withAlpha(color, alpha) {
  const m = /^#([\da-f]{6})$/i.exec(String(color).trim());
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function renderCursorChart(labels, values, centsArr) {
  const canvas = document.getElementById("cursor-chart");
  if (!canvas) return;
  const c = themeColors();
  const costUsd = centsArr.map((cents) => cents / 100);
  if (cursorChartInst) cursorChartInst.destroy();
  cursorChartInst = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          type: "bar",
          label: "Tokens",
          data: values,
          yAxisID: "y",
          backgroundColor: withAlpha(c.accent, 0.55),
          borderColor: withAlpha(c.accent, 0.95),
          borderWidth: 1,
          borderRadius: 3,
          order: 2,
        },
        {
          type: "line",
          label: "费用 ($)",
          data: costUsd,
          yAxisID: "y1",
          borderColor: c.warn,
          backgroundColor: withAlpha(c.warn, 0.12),
          borderWidth: 2,
          pointRadius: 3,
          pointHoverRadius: 5,
          pointBackgroundColor: c.warn,
          tension: 0.25,
          fill: false,
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: true,
          position: "bottom",
          labels: { color: c.muted, font: { size: 10 }, boxWidth: 10, padding: 6 },
        },
        tooltip: {
          callbacks: {
            title: (items) => items[0].label,
            label: (ctx) =>
              ctx.datasetIndex === 0
                ? ` Tokens: ${ctx.parsed.y.toLocaleString()}`
                : ` 费用: $${ctx.parsed.y.toFixed(4)}`,
          },
        },
      },
      scales: {
        x: { ticks: { color: c.muted, font: { size: 10 } }, grid: { color: withAlpha(c.grid, 0.5) } },
        y: {
          position: "left",
          ticks: {
            color: c.text,
            font: { size: 10 },
            callback: (v) => (v >= 1000 ? (v / 1000).toFixed(0) + "k" : v),
          },
          grid: { color: withAlpha(c.grid, 0.5) },
        },
        y1: {
          position: "right",
          ticks: { color: c.warn, font: { size: 10 }, callback: (v) => "$" + v.toFixed(2) },
          grid: { drawOnChartArea: false },
        },
      },
    },
  });
}

async function fetchCursorUsage(force = false) {
  const canvas = document.getElementById("cursor-chart");
  const emptyEl = document.getElementById("cursor-empty");
  const rangeEl = document.getElementById("cursor-range");
  const btn = document.getElementById("cursor-refresh");
  if (!canvas) return;

  btn?.classList.add("spinning");
  try {
    let usage;
    const cached = force ? null : await loadCursorCache();
    if (cached && cached.usage) {
      usage = cached.usage;
      if (cached.leaderboard !== undefined) cursorLeaderboard = cached.leaderboard;
    } else {
      const lbPromise = fetchCursorLeaderboard();
      usage = await fetchCursorUsageApi();
      await lbPromise;
      await saveCursorCache(usage, cursorLeaderboard);
    }

    const events = Array.isArray(usage)
      ? usage
      : usage.usageEventsDisplay ?? usage.events ?? usage.usageEvents ?? usage.data ?? [];

    if (!events.length) {
      emptyEl.hidden = false;
      canvas.hidden = true;
      cursorStatsData = null;
      renderCursorStatsPanel();
      return;
    }

    emptyEl.hidden = true;
    canvas.hidden = false;

    const byDate = {};
    const byCents = {};
    let totalTokens = 0;
    let totalCents = 0;
    const sorted = [...events].sort((a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0));

    for (const ev of sorted) {
      const ts = ev.timestamp ?? ev.createdAt ?? ev.created_at ?? ev.date;
      const date = ts
        ? new Date(Number(ts)).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })
        : "unknown";
      const tu = ev.tokenUsage ?? {};
      const tokens = Number(
        ev.totalTokens ?? ev.total_tokens ?? ev.tokens ?? ((tu.inputTokens ?? 0) + (tu.outputTokens ?? 0))
      );
      const cents = Number(ev.chargedCents ?? ev.charged_cents ?? tu.totalCents ?? 0);
      byDate[date] = (byDate[date] ?? 0) + tokens;
      byCents[date] = (byCents[date] ?? 0) + cents;
      totalTokens += tokens;
      totalCents += cents;
    }

    const labels = Object.keys(byDate);
    const values = Object.values(byDate);
    const centsArr = labels.map((d) => byCents[d] ?? 0);
    if (rangeEl && labels.length) rangeEl.textContent = `${labels[0]} – ${labels[labels.length - 1]}`;

    const modelCounts = {};
    for (const ev of events) {
      const m = ev.model ?? ev.modelName ?? ev.model_name ?? "unknown";
      modelCounts[m] = (modelCounts[m] ?? 0) + 1;
    }
    cursorStatsData = { events, totalTokens, totalCents, modelCounts };
    renderCursorStatsPanel();

    lastChartData = { labels, values, centsArr };
    renderCursorChart(labels, values, centsArr);
  } catch (err) {
    console.error("[cursor-usage] error:", err);
    emptyEl.textContent = /HTTP 403/.test(err.message)
      ? "HTTP 403 — 请确认浏览器已登录 cursor.com，然后点 ↻ 重试"
      : `加载失败: ${escHtml(err.message)}`;
    emptyEl.hidden = false;
    canvas.hidden = true;
  } finally {
    btn?.classList.remove("spinning");
  }
}
document.getElementById("cursor-refresh").addEventListener("click", () => fetchCursorUsage(true));

/* ============================================================
   Release Matrix 跳转（version 由设置页配置）
   ============================================================ */
async function initMatrixCard() {
  const stored = await chrome.storage.sync.get({ releaseMatrixVersion: RELEASE_MATRIX_DEFAULT_VERSION });
  const version =
    String(stored.releaseMatrixVersion || RELEASE_MATRIX_DEFAULT_VERSION).trim() || RELEASE_MATRIX_DEFAULT_VERSION;
  const url = RELEASE_MATRIX_BASE_URL + encodeURIComponent(version);
  for (const id of ["matrix-link", "matrix-open"]) {
    const el = document.getElementById(id);
    if (el) {
      el.href = url;
      el.title = url;
    }
  }
  const meta = document.getElementById("matrix-version");
  if (meta) meta.textContent = version;
}

/* ============================================================
   启动
   ============================================================ */
(async function init() {
  cardState = await loadCardState();
  bindCardChrome();
  applyCardState();
  // 折叠状态会改变高度，落位后再校正一次
  requestAnimationFrame(applyCardState);

  initMatrixCard();
  authReady.then(() => fetchCursorUsage()); // 打开时优先用缓存
  initMetrics();

  // 跟随浏览器主题：亮/暗切换时重绘图表
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (lastChartData) renderCursorChart(lastChartData.labels, lastChartData.values, lastChartData.centsArr);
  });

  // 页面挂着期间周期性刷新 DNR cookie，避免长时间挂着的会话 token 轮换后 403
  setInterval(() => {
    chrome.runtime.sendMessage({ type: "refresh-auth" }).catch(() => {});
  }, 5 * 60 * 1000);
})();
