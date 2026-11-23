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

const RELEASE_MATRIX_PAGE = "https://cygnus.telenav.com/release_matrix/releases/index";
const RELEASE_MATRIX_DEFAULT_VERSION = "26q3";
const RELEASE_MATRIX_DEFAULT_REGION = "hkm,isc,sea";
const RELEASE_MATRIX_DEFAULT_STAGES = "PBF,NGX,QA-NGX";

// 首次打开时的落位（之后以用户拖动的位置为准）
const DEFAULT_POS = {
  cursor: { x: 40, y: 40 },
  servers: { x: 40, y: 400 },
  matrix: { x: 520, y: 40 },
  bluetooth: { x: 600, y: 400 },
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
      // 按钮/链接/输入框（如 Matrix 卡头的 version 编辑）不参与拖动，否则点一下会被当成折叠
      if (e.target.closest("button, a, input, textarea")) return;
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
            if (updated) {
              updated.textContent = "已下载 → 双击 .bat 安装";
              updated.title = NATIVE_HOST_INSTALL_HINT;
            }
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
// 本月（账期）消耗：undefined=取数中，null=没取到，对象=已取到
let cursorMonth = undefined;

async function loadCursorCache() {
  const obj = await chrome.storage.local.get(CURSOR_CACHE_KEY);
  const c = obj[CURSOR_CACHE_KEY];
  if (!c || !c.usage || Date.now() - (c.ts || 0) > CURSOR_CACHE_TTL_MS) return null;
  return c;
}

async function saveCursorCache(usage, leaderboard, month) {
  await chrome.storage.local.set({
    [CURSOR_CACHE_KEY]: {
      ts: Date.now(),
      usage,
      leaderboard: leaderboard === undefined ? null : leaderboard,
      month: month ?? null,
    },
  });
}

function statChip(label, value, title) {
  const attr = title ? ` title="${escHtml(title)}"` : "";
  return `<span class="stat-chip"${attr}><span class="stat-label">${label}</span><span class="stat-cnt">${value}</span></span>`;
}

/** 本月消耗芯片（账期内合计）—— 始终排在最前面。 */
function monthChipHtml() {
  if (cursorMonth === undefined) return statChip("本月消耗", "…");
  if (!cursorMonth) return statChip("本月消耗", "—", "没取到账单周期（未登录 / 该账号没有账期接口）");
  const start = new Date(cursorMonth.startAt).toLocaleDateString("zh-CN");
  const end = new Date(cursorMonth.endAt).toLocaleDateString("zh-CN");
  return statChip(
    "本月消耗",
    `$${(cursorMonth.cents / 100).toFixed(2)}`,
    `${start} → ${end}（Cursor 账期，UTC 零点切）· ${cursorMonth.events} 次请求 · ${cursorMonth.tokens.toLocaleString()} tokens`
  );
}

function rankChipsHtml() {
  if (cursorLeaderboard === undefined) return statChip("7天排名", "…") + statChip("30天排名", "…");
  if (cursorLeaderboard === null) return statChip("7天排名", "—") + statChip("30天排名", "—");
  const fmt = (key) => {
    const r = cursorLeaderboard[key]?.rank;
    return r != null ? `#${r}` : "—";
  };
  return statChip("7天排名", fmt("rank_7d")) + statChip("30天排名", fmt("rank_30d"));
}

function renderCursorStatsPanel() {
  const statsEl = document.getElementById("cursor-stats");
  if (!statsEl) return;
  const head = monthChipHtml() + rankChipsHtml();
  if (!cursorStatsData) {
    statsEl.innerHTML = head;
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
  statsEl.innerHTML = `${head}
    <span class="stat-chip"><span class="stat-label">请求</span><span class="stat-cnt">${events.length}</span></span>
    <span class="stat-chip"><span class="stat-label">Tokens</span><span class="stat-cnt">${totalTokens.toLocaleString()}</span></span>
    <span class="stat-chip"><span class="stat-label">30天费用</span><span class="stat-cnt">$${(totalCents / 100).toFixed(2)}</span></span>
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

/** x 轴日标签（本地日），如 "11/2"。 */
function dayKey(ms) {
  return new Date(Number(ms)).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
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
    // 旧缓存没有 month 字段（升级前的 30 天缓存）→ 当作过期，重取一次，
    // 免得「本月消耗」在缓存有效期内一直显示「—」。
    if (cached && cached.usage && cached.month !== undefined) {
      usage = cached.usage;
      cursorMonth = cached.month;
      if (cached.leaderboard !== undefined) cursorLeaderboard = cached.leaderboard;
    } else {
      const lbPromise = fetchCursorLeaderboard();
      // 曲线/芯片仍按最近 30 天（面板默认口径）；另外单独取一次「本账期」合计，
      // 只喂最前面那个「本月消耗」芯片。两段都取不到就各自降级，互不影响。
      cursorMonth = undefined;
      renderCursorStatsPanel();
      const monthPromise = fetchCursorMonthUsage().catch((err) => {
        console.warn("[cursor-month] 取本月消耗失败:", err.message);
        return null;
      });
      usage = await fetchCursorUsageApi();
      cursorMonth = await monthPromise;
      await lbPromise;
      await saveCursorCache(usage, cursorLeaderboard, cursorMonth);
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
      const date = ts ? dayKey(ts) : "unknown";
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
    const values = labels.map((d) => byDate[d] ?? 0);
    const centsArr = labels.map((d) => byCents[d] ?? 0);
    if (rangeEl && labels.length) {
      rangeEl.textContent = `${labels[0]} – ${labels[labels.length - 1]}`;
      rangeEl.title = "最近 30 天（Cursor 用量事件）";
    }

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
    // 别让「本月消耗」永远停在「…」上
    if (cursorMonth === undefined) cursorMonth = null;
    renderCursorStatsPanel();
  } finally {
    btn?.classList.remove("spinning");
  }
}
document.getElementById("cursor-refresh").addEventListener("click", () => fetchCursorUsage(true));

/* ============================================================
   Release Matrix 状态（region-version-<环节…>）
   取数在 background（cygnus 的 cookie 与 X-CSRFToken 必须来自同一次
   chrome.cookies 读取，见 background.js 的 DNR 规则 5）；这里只渲染。
   version / region / 环节 都取设置页配置（逗号分隔）；version 在卡片头上
   直接点就能改，改完写回 sync 并自动刷新。
   ============================================================ */
const matrixConfig = {
  version: RELEASE_MATRIX_DEFAULT_VERSION,
  regions: ["hkm", "isc", "sea"],
  stages: ["PBF", "NGX", "QA-NGX"],
};

/** "a, b,,c" → ["a","b","c"]（去空、去重）；全空时用 fallback（逗号串）。 */
function commaList(raw, fallback) {
  const parts = String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const list = parts.length ? parts : String(fallback || "").split(",");
  return [...new Set(list)];
}

/** 站点自己地址栏里 region 是二次编码的（hkm%252Cisc%252Csea），照抄。 */
function matrixPageUrl(version) {
  const region = encodeURIComponent(encodeURIComponent(matrixConfig.regions.join(",")));
  return `${RELEASE_MATRIX_PAGE}?mo=t&region=${region}&version=${encodeURIComponent(version)}`;
}

const MATRIX_STATUS_LABELS = {
  released: ["已发布", "ok"],
  verified: ["已验证", "ok"],
  success: ["成功", "ok"],
  approved: ["已批准", "ok"],
  ready: ["待发布", "warn"],
  running: ["进行中", "accent"],
  "in-progress": ["进行中", "accent"],
  waiting: ["等待", "muted"],
  cancelled: ["已取消", "danger"],
  failed: ["失败", "danger"],
  error: ["失败", "danger"],
  deleted: ["已删除", "danger"],
};

/** 单个组件状态 → 彩色小标签（原始英文状态与 ATC/ETC 放 title）。 */
function matrixChip(st) {
  if (!st || !st.status) return '<span class="matrix-chip none">—</span>';
  const [label, tone] = MATRIX_STATUS_LABELS[st.status] || [st.status, "muted"];
  const tip = [st.status, st.atc ? `ATC ${st.atc}` : "", st.etc ? `ETC ${st.etc}` : ""]
    .filter(Boolean)
    .join(" · ");
  return `<span class="matrix-chip ${tone}" title="${escHtml(tip)}">${escHtml(label)}</span>`;
}

function matrixTime(iso) {
  const d = iso ? new Date(iso) : new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function setMatrixLinks(version) {
  const url = matrixPageUrl(version);
  for (const id of ["matrix-link", "matrix-open"]) {
    const el = document.getElementById(id);
    if (el) {
      el.href = url;
      el.title = url;
    }
  }
}

/** 表头跟着「环节」配置走：Region | Version | <环节…>。 */
function renderMatrixHead(stages) {
  const head = document.getElementById("matrix-head");
  if (!head) return;
  head.innerHTML = `<tr><th>Region</th><th>Version</th>${stages.map((s) => `<th>${escHtml(s)}</th>`).join("")}</tr>`;
}

function renderMatrix(payload) {
  const tbody = document.getElementById("matrix-rows");
  const table = document.getElementById("matrix-table");
  const note = document.getElementById("matrix-note");
  const rows = payload.rows || [];
  const stages =
    Array.isArray(payload.stages) && payload.stages.length ? payload.stages : matrixConfig.stages;

  renderMatrixHead(stages);

  // 同一 region+version 有多行（不同产品线）时，在 region 后补产品名区分
  const dup = {};
  for (const r of rows) dup[`${r.region}-${r.version}`] = (dup[`${r.region}-${r.version}`] || 0) + 1;

  tbody.innerHTML = rows
    .map((r) => {
      const productTag =
        dup[`${r.region}-${r.version}`] > 1 && r.product
          ? `<span class="matrix-product">${escHtml(r.product)}</span>`
          : "";
      const tip = [r.name, r.overall ? `整体 ${r.overall}` : "", r.builtAt ? `构建于 ${r.builtAt}` : ""]
        .filter(Boolean)
        .join(" · ");
      return `<tr title="${escHtml(tip)}">
        <td class="matrix-region">${escHtml(r.region || r.name)}${productTag}</td>
        <td class="matrix-version">${escHtml(r.version || "—")}</td>
        ${stages.map((s) => `<td>${matrixChip(r.statuses[s])}</td>`).join("")}
      </tr>`;
    })
    .join("");

  table.hidden = !rows.length;
  note.className = "matrix-note";
  note.hidden = rows.length > 0;
  if (!rows.length) note.textContent = `版本 ${payload.version} 在 ${payload.region} 下暂无 release`;

  const filtered = payload.filtered || rows.length;
  document.getElementById("matrix-updated").textContent =
    rows.length && filtered > rows.length
      ? `${rows.length}/${filtered} 条 · ${matrixTime(payload.at)} 更新`
      : `${rows.length} 条 · ${matrixTime(payload.at)} 更新`;

  document.getElementById("matrix-version").textContent = payload.version;
  setMatrixLinks(payload.version);
}

function renderMatrixError(err) {
  const msg = String((err && err.message) || err);
  document.getElementById("matrix-table").hidden = true;
  document.getElementById("matrix-rows").innerHTML = "";
  document.getElementById("matrix-updated").textContent = "";
  const note = document.getElementById("matrix-note");
  note.className = "matrix-note error";
  note.hidden = false;
  note.textContent = `⚠ ${msg}${/403|登录/.test(msg) ? "" : "，点 ↻ 重试"}`;
}

async function refreshMatrix(force) {
  const btn = document.getElementById("matrix-refresh");
  btn?.classList.add("spinning");
  try {
    const resp = await chrome.runtime.sendMessage({ type: "matrix-releases", force: force === true });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || "后台无响应");
    renderMatrix(resp);
  } catch (err) {
    console.error("[matrix] error:", err);
    renderMatrixError(err);
  } finally {
    btn?.classList.remove("spinning");
  }
}

/** 保存 version → 写 sync → 改卡头文字 → 自动刷新（跳过 5 分钟缓存）。 */
async function saveMatrixVersion(next) {
  matrixConfig.version = next;
  const btn = document.getElementById("matrix-version");
  if (btn) btn.textContent = next;
  setMatrixLinks(next);
  try {
    await chrome.storage.sync.set({ releaseMatrixVersion: next });
  } catch (err) {
    console.error("[matrix] version 保存失败:", err);
  }
  await refreshMatrix(true);
}

/** 点卡头上的 version → 就地变输入框：Enter 保存 / Esc 取消 / 失焦保存。 */
function openMatrixVersionEditor() {
  const btn = document.getElementById("matrix-version");
  if (!btn || document.getElementById("matrix-version-input")) return;

  const input = document.createElement("input");
  input.type = "text";
  input.id = "matrix-version-input";
  input.className = "matrix-version-input";
  input.value = matrixConfig.version;
  input.spellcheck = false;
  input.setAttribute("aria-label", "Release Matrix version");
  btn.hidden = true;
  btn.after(input);
  input.focus();
  input.select();

  let finished = false;
  const close = () => {
    input.remove();
    btn.hidden = false;
  };
  const cancel = () => {
    if (finished) return;
    finished = true;
    close();
    btn.focus();
  };
  const commit = () => {
    if (finished) return;
    finished = true;
    const next = input.value.trim();
    close();
    if (next && next !== matrixConfig.version) saveMatrixVersion(next);
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  });
  input.addEventListener("blur", commit);
}

async function initMatrixCard() {
  const stored = await chrome.storage.sync.get({
    releaseMatrixVersion: RELEASE_MATRIX_DEFAULT_VERSION,
    releaseMatrixRegion: RELEASE_MATRIX_DEFAULT_REGION,
    releaseMatrixStages: RELEASE_MATRIX_DEFAULT_STAGES,
  });
  matrixConfig.version = String(stored.releaseMatrixVersion || "").trim() || RELEASE_MATRIX_DEFAULT_VERSION;
  matrixConfig.regions = commaList(stored.releaseMatrixRegion, RELEASE_MATRIX_DEFAULT_REGION);
  matrixConfig.stages = commaList(stored.releaseMatrixStages, RELEASE_MATRIX_DEFAULT_STAGES);

  const meta = document.getElementById("matrix-version");
  if (meta) meta.textContent = matrixConfig.version;
  renderMatrixHead(matrixConfig.stages);
  setMatrixLinks(matrixConfig.version);
}

document.getElementById("matrix-refresh").addEventListener("click", () => refreshMatrix(true));
document.getElementById("matrix-version").addEventListener("click", openMatrixVersionEditor);

/* ============================================================
   蓝牙电量（Native Messaging → Go 宿主）
   扩展拿不到本机蓝牙，所以问宿主（native_host/bt_windows.go）：它跑在
   浏览器所在的 Windows 上，用 PowerShell 读「已连接设备 + 电量」。
   结果缓存 60s —— 每次开新标签页都跑一遍 PowerShell 太浪费。
   ============================================================ */
const BT_CACHE_KEY = "bluetoothCache";
const BT_TTL_MS = 60 * 1000;
const BT_POLL_MS = 2 * 60 * 1000;
const BT_LOW_PCT = 20; // 余量 ≤20% 标红，>20% 标绿
const BT_LOG_HINT = "宿主日志：%LOCALAPPDATA%\\edge-panel-host\\bluetooth.log（实际跑的脚本：同目录 bluetooth-scan.ps1）";

async function loadBluetoothCache() {
  try {
    const obj = await chrome.storage.local.get(BT_CACHE_KEY);
    const c = obj[BT_CACHE_KEY];
    if (!c || Date.now() - (c.ts || 0) > BT_TTL_MS) return null;
    return c;
  } catch (_) {
    return null;
  }
}

function btRowHtml(d) {
  // 注意 Number(null) === 0：宿主的 battery 是 *int，读不到时是 null，不能当 0 处理
  const raw = d && d.battery;
  const has = raw !== null && raw !== undefined && Number.isFinite(Number(raw));
  const pct = has ? Number(raw) : 0;
  const tone = has ? (pct <= BT_LOW_PCT ? " low" : " ok") : " none";
  const width = has ? Math.max(0, Math.min(100, pct)) : 0;
  const name = (d && d.name) || "未知设备";
  const tip = has ? `${name} · 剩余 ${Math.round(pct)}%` : `${name} · 电量未知`;
  return `<div class="bt-row" title="${escHtml(tip)}">
    <span class="bt-name">${escHtml(name)}</span>
    <span class="bt-bar"><span class="bt-fill${tone}" style="width:${width}%"></span></span>
    <span class="bt-pct${tone}">${has ? `${Math.round(pct)}%` : "—"}</span>
  </div>`;
}

function renderBluetooth(payload) {
  const list = document.getElementById("bluetooth-list");
  const updated = document.getElementById("bluetooth-updated");
  if (!list) return;
  const devices = Array.isArray(payload.devices) ? payload.devices : [];
  const diag = payload.diag || {};
  if (devices.length) {
    list.innerHTML = devices.map(btRowHtml).join("");
  } else {
    // 空面板必须能解释「为什么空」：扫了几个节点、几个有电量读数
    const bits = [];
    if (diag.btNodes != null) bits.push(`BTHENUM/BTHLE ${diag.btNodes}`);
    if (diag.scanned != null && diag.scanned > 0) bits.push(`已扫 ${diag.scanned}`);
    if (diag.withBattery != null) bits.push(`有电量读数 ${diag.withBattery}`);
    if (diag.classNodes != null) bits.push(`蓝牙类节点 ${diag.classNodes}`);
    if (diag.connKnown === false) bits.push("连接状态未知");
    const detail = bits.length ? `（${escHtml(bits.join(" · "))}）` : "";
    list.innerHTML = `<div class="loading">未发现正在连接的蓝牙设备${detail}</div>`;
    list.title = BT_LOG_HINT; // 鼠标悬停能看到日志位置
  }

  if (updated) {
    const time = matrixTime(payload.at || Date.now());
    // 连接状态拿不到时（WinRT 不可用）列出的是「有电量读数」的设备，标注一下
    const scope = payload.connectedOnly === false ? " · 连接状态未知" : "";
    // 宿主脚本有时间预算，超预算会带着已扫到的设备返回
    const partial = diag.timedOut ? " · 部分结果" : "";
    if (diag.timedOut) updated.title = "扫描被时间预算截断（只列了已扫到的）—— " + BT_LOG_HINT;
    if (diag.fallback === "conn-filter-empty") {
      // 有电量读数但没一个匹配上「已连接」—— 列表是兜底展示，提示一下
      updated.title = "连接状态没匹配上（PnP 名称/MAC 与 WinRT 不一致），先按有电量读数列出";
    }
    updated.textContent = `${devices.length ? `${devices.length} 台` : "无设备"} · ${time}${scope}${partial}`;
  }
}

/** 失败：宿主没装就给安装按钮（与服务器卡片同一套原生宿主安装流程）。 */
function renderBluetoothError(err) {
  const list = document.getElementById("bluetooth-list");
  const updated = document.getElementById("bluetooth-updated");
  if (!list) return;
  const msg = String((err && err.message) || err);
  const actions = [];
  // 宿主太旧（装的是 0.9.6 及更早的 exe）会回 "unsupported type: bluetooth" —— 也要给安装入口
  if (isNativeHostMissing(err) || /unsupported type/i.test(msg)) {
    actions.push({ act: "install-host", label: "下载并安装 Native 宿主" });
  }
  actions.push({ act: "retry", label: "重试" });

  list.innerHTML = `<div class="loading error-text">${escHtml(msg)}</div>
    <div class="metric-actions">${actions
      .map((a) => `<button type="button" class="metric-action" data-act="${a.act}">${a.label}</button>`)
      .join("")}</div>`;

  for (const b of list.querySelectorAll(".metric-action")) {
    b.addEventListener("click", () => {
      if (b.dataset.act === "retry") {
        fetchBluetooth(true);
        return;
      }
      b.textContent = "下载中…";
      b.disabled = true;
      installNativeHost()
        .then(() => {
          b.textContent = "✓ 已下载";
          if (updated) {
            updated.textContent = "已下载 → 双击 .bat 安装";
            updated.title = NATIVE_HOST_INSTALL_HINT;
          }
        })
        .catch((e) => {
          b.textContent = "下载失败";
          b.disabled = false;
          if (updated) updated.textContent = `下载失败: ${e.message}`;
        });
    });
  }
  if (updated) {
    updated.textContent = "获取失败";
    updated.title = BT_LOG_HINT;
  }
}

async function fetchBluetooth(force = false) {
  const btn = document.getElementById("bluetooth-refresh");
  btn?.classList.add("spinning");
  try {
    if (!force) {
      const cached = await loadBluetoothCache();
      if (cached) {
        renderBluetooth(cached);
        return;
      }
    }
    const resp = await chrome.runtime.sendMessage({ type: "bluetooth" });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || "后台无响应");
    // 先把 at 补成毫秒（宿主给的是 ISO 串，缓存里也统一存下来）
    const payload = { ...resp, ts: Date.now() };
    if (resp.diag) console.info("[bluetooth] host diag:", resp.diag); // 排查慢在哪一步
    await chrome.storage.local.set({ [BT_CACHE_KEY]: payload });
    renderBluetooth(payload);
  } catch (err) {
    console.error("[bluetooth] error:", err);
    renderBluetoothError(err);
  } finally {
    btn?.classList.remove("spinning");
  }
}

function initBluetoothCard() {
  fetchBluetooth(false);
  setInterval(() => fetchBluetooth(false), BT_POLL_MS); // 页面挂着时每 2 分钟对一次
}

document.getElementById("bluetooth-refresh").addEventListener("click", () => fetchBluetooth(true));

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
  authReady.then(() => refreshMatrix(false)); // 同上：cookie 刷新后再取 Matrix
  initMetrics();
  initBluetoothCard();

  // 跟随浏览器主题：亮/暗切换时重绘图表
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (lastChartData) renderCursorChart(lastChartData.labels, lastChartData.values, lastChartData.centsArr);
  });

  // Matrix 的 release 状态变化慢，页面挂着期间每 5 分钟对一次（background 有 5 分钟缓存）
  setInterval(() => refreshMatrix(false), 5 * 60 * 1000);

  // 页面挂着期间周期性刷新 DNR cookie，避免长时间挂着的会话 token 轮换后 403
  setInterval(() => {
    chrome.runtime.sendMessage({ type: "refresh-auth" }).catch(() => {});
  }, 5 * 60 * 1000);
})();
