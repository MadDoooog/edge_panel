/* ============================================================
   edge-panel 侧边栏 UI 编排
   渲染逻辑移植自 frontend/script.js；数据源换成扩展模块：
   - metrics.js（Native Messaging → Go 宿主）
   - logshed.js（直连探测 + 本地历史）
   - cursor.js（直连 cursor.com + 自动 cookie）
   - feeds.js（直连知乎 + 本地缓存）
   ============================================================ */
const REFRESH_INTERVAL_MS = 60_000; // 面板可见期间 60s 自动刷新

/* ============================================================
   顶部工具按钮：设置
   ============================================================ */
document.getElementById("open-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// 等待 background 刷新 DNR 头注入规则（cookie/referer/origin）后再发起直连请求
const authReady = chrome.runtime.sendMessage({ type: "refresh-auth" }).catch(() => {});

/* ============================================================
   服务器磁盘仪表盘（SSH，Native Messaging）
   ============================================================ */
function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildGauge(pct, mountLabel) {
  const p = Math.min(Math.max(pct || 0, 0), 100);
  const danger = p >= 80;
  const fillHex = danger ? "#f06b6b" : "#3dd68c";
  const glowRgba = danger ? "rgba(240,107,107,.55)" : "rgba(61,214,140,.45)";
  const dashFill = p === 0 ? "0.1 100" : `${p} 100`;
  const id = "g" + escHtml(mountLabel).replace(/\W/g, "");

  return `
<div class="gauge-item" title="${escHtml(mountLabel)} ${p.toFixed(1)}%">
  <svg viewBox="0 0 200 115" class="gauge-svg">
    <defs>
      <filter id="${id}" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="3" result="blur"/>
        <feFlood flood-color="${glowRgba}" result="color"/>
        <feComposite in="color" in2="blur" operator="in" result="glow"/>
        <feMerge><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <path d="M 15 105 A 85 85 0 0 1 185 105"
      fill="none" stroke="#1a232d" stroke-width="16" stroke-linecap="round" pathLength="100"/>
    <path d="M 15 105 A 85 85 0 0 1 185 105"
      fill="none" stroke="${fillHex}" stroke-width="16" stroke-linecap="round"
      pathLength="100" stroke-dasharray="${dashFill}" filter="url(#${id})"/>
    <line x1="100" y1="22" x2="100" y2="35" stroke="#e8b84a" stroke-width="2" opacity="0.55"
      transform="rotate(${-90 + 180 * 0.8} 100 105)"/>
    <text x="100" y="90" text-anchor="middle"
      fill="${fillHex}" font-size="30" font-weight="700"
      font-family="ui-monospace,'Cascadia Code',Consolas,monospace">${p.toFixed(0)}%</text>
  </svg>
  <div class="gauge-mount">${escHtml(mountLabel)}</div>
</div>`;
}

const DU_TOP_N = 3;

function renderDuChips(duData) {
  if (!duData || Object.keys(duData).length === 0) return "";
  let rows = "";
  for (const [path, items] of Object.entries(duData)) {
    if (!items || items.length === 0) continue;
    const label = path.split("/").pop() || path;
    rows += `<div class="du-path-label" title="${escHtml(path)}">${escHtml(label)}</div>`;
    for (const item of items.slice(0, DU_TOP_N)) {
      rows += `<div class="du-chip-name" title="${escHtml(item.full_path)}">${escHtml(item.name)}</div>
               <div class="du-chip-size">${escHtml(item.size)}</div>`;
    }
  }
  return rows ? `<div class="du-chips">${rows}</div>` : "";
}

function renderServer(srv) {
  const card = document.createElement("div");
  card.className = "server-card";

  const statusCls = srv.status === "ok" ? "ok" : "error";
  const dateStr = (srv.collected_at ?? "").replace("T", " ");
  let html = `
    <div class="server-name">
      <div class="status-dot ${statusCls}"></div>
      <span>${escHtml(srv.name)}</span>
      <span class="collected-at">${escHtml(dateStr)}</span>
    </div>`;

  if (srv.status !== "ok") {
    html += `<div class="error-msg">&#9888; 采集失败</div>`;
    card.innerHTML = html;
    return card;
  }

  const disks = (srv.disks || []).filter((d) => d.device?.startsWith("/dev/"));
  const duHtml = srv.du_data ? renderDuChips(srv.du_data) : "";

  if (disks.length > 0 || duHtml) {
    html += `<div class="card-body">`;
    if (disks.length > 0) {
      html += `<div class="gauge-grid">`;
      for (const disk of disks) {
        html += buildGauge(disk.percent, disk.mountpoint);
      }
      html += `</div>`;
    }
    html += duHtml;
    html += `</div>`;
  }

  card.innerHTML = html;
  return card;
}

function renderMetrics(data) {
  const container = document.getElementById("servers-container");
  const lastUpdated = document.getElementById("last-updated");
  if (!container) return;
  container.innerHTML = "";
  const servers = data.servers ?? [];
  if (!servers.length) {
    container.innerHTML = '<div class="loading">暂无 SSH 目标</div>';
  } else {
    servers.forEach((srv) => container.appendChild(renderServer(srv)));
  }
  if (lastUpdated) lastUpdated.textContent = `更新于 ${data.last_updated ?? "—"}`;
}

async function fetchMetrics() {
  const btn = document.getElementById("refresh-btn");
  btn?.classList.add("spinning");
  try {
    const data = await collectMetrics();
    await saveMetricsCache(data);
    renderMetrics(data);
  } catch (err) {
    const cached = await loadMetricsCache();
    if (cached) {
      renderMetrics(cached);
      const lu = document.getElementById("last-updated");
      if (lu) lu.textContent = `缓存 ${cached.last_updated ?? "—"} (${escHtml(err.message)})`;
    } else {
      const container = document.getElementById("servers-container");
      if (container) {
        container.innerHTML = `<div class="loading" style="color:#f85149">无法采集 (${escHtml(
          err.message
        )})<br>请确认已运行 <code>bash native_host/setup_native_host.sh</code></div>`;
      }
      const lu = document.getElementById("last-updated");
      if (lu) lu.textContent = "采集失败";
    }
  } finally {
    btn?.classList.remove("spinning");
  }
}

async function initMetrics() {
  const cached = await loadMetricsCache();
  if (cached) renderMetrics(cached); // 先展示缓存，后台刷新掩盖 SSH 延迟
  await fetchMetrics();
}
document.getElementById("refresh-btn").addEventListener("click", fetchMetrics);
authReady.then(() => initMetrics());
setInterval(fetchMetrics, REFRESH_INTERVAL_MS);

/* ============================================================
   Logshed 状态（单按钮红绿显示，不展示历史）
   ============================================================ */
function renderLogshed(data) {
  const btn = document.getElementById("logshed-btn");
  if (!btn) return;
  const current = data.current;
  if (!current || current.ok == null) {
    btn.textContent = "Logshed：探测中…";
    btn.className = "logshed-btn";
    btn.title = "点击重新探测";
  } else if (current.ok) {
    btn.textContent = "Logshed：运行正常";
    btn.className = "logshed-btn ok";
    btn.title = "点击重新探测";
  } else {
    btn.textContent = "Logshed：服务异常";
    btn.className = "logshed-btn error";
    btn.title = current.error ? `最近错误：${current.error}（点击重新探测）` : "点击重新探测";
  }
}

async function refreshLogshed() {
  const data = await loadLogshedData();
  renderLogshed(data); // 先渲染上一次结果
  const updated = await probeLogshed();
  renderLogshed(updated);
}
refreshLogshed();
setInterval(refreshLogshed, REFRESH_INTERVAL_MS);
document.getElementById("logshed-btn")?.addEventListener("click", refreshLogshed);

/* ============================================================
   Cursor 用量图表
   ============================================================ */
let cursorChartInst = null;
let cursorStatsData = null;
let cursorLeaderboard = undefined;

function rankChipsHtml() {
  const chip = (label, value) =>
    `<span class="stat-chip"><span class="stat-label">${label}</span><span class="stat-cnt">${value}</span></span>`;
  if (cursorLeaderboard === undefined) {
    return chip("7天排名", "…") + chip("30天排名", "…");
  }
  if (cursorLeaderboard === null) {
    return chip("7天排名", "—") + chip("30天排名", "—");
  }
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

  const dollarTotal = (totalCents / 100).toFixed(2);
  statsEl.innerHTML = `${rankChipsHtml()}
    <span class="stat-chip"><span class="stat-label">请求</span><span class="stat-cnt">${events.length}</span></span>
    <span class="stat-chip"><span class="stat-label">Tokens</span><span class="stat-cnt">${totalTokens.toLocaleString()}</span></span>
    <span class="stat-chip"><span class="stat-label">费用</span><span class="stat-cnt">$${dollarTotal}</span></span>
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

async function fetchCursorUsage() {
  const canvas = document.getElementById("cursor-chart");
  const emptyEl = document.getElementById("cursor-empty");
  const rangeEl = document.getElementById("cursor-range");
  const btn = document.getElementById("cursor-refresh");
  if (!canvas) return;

  btn?.classList.add("spinning");
  fetchCursorLeaderboard();

  try {
    const data = await fetchCursorUsageApi();

    const events = Array.isArray(data)
      ? data
      : data.usageEventsDisplay ?? data.events ?? data.usageEvents ?? data.data ?? [];

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
        ev.totalTokens ??
          ev.total_tokens ??
          ev.tokens ??
          ((tu.inputTokens ?? 0) + (tu.outputTokens ?? 0))
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

    if (rangeEl && labels.length) {
      rangeEl.textContent = `${labels[0]} – ${labels[labels.length - 1]}`;
    }

    const modelCounts = {};
    for (const ev of events) {
      const m = ev.model ?? ev.modelName ?? ev.model_name ?? "unknown";
      modelCounts[m] = (modelCounts[m] ?? 0) + 1;
    }
    cursorStatsData = { events, totalTokens, totalCents, modelCounts };
    renderCursorStatsPanel();

    const costUsd = centsArr.map((c) => c / 100);

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
            backgroundColor: "rgba(78,232,197,0.55)",
            borderColor: "rgba(78,232,197,0.9)",
            borderWidth: 1,
            borderRadius: 3,
            order: 2,
          },
          {
            type: "line",
            label: "费用 ($)",
            data: costUsd,
            yAxisID: "y1",
            borderColor: "rgba(232,184,74,1)",
            backgroundColor: "rgba(232,184,74,0.12)",
            borderWidth: 2,
            pointRadius: 3,
            pointHoverRadius: 5,
            pointBackgroundColor: "rgba(232,184,74,1)",
            tension: 0.25,
            fill: false,
            order: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            display: true,
            position: "bottom",
            labels: { color: "#7a8f9e", font: { size: 10 }, boxWidth: 12, padding: 8 },
          },
          tooltip: {
            callbacks: {
              title: (items) => items[0].label,
              label: (ctx) => {
                if (ctx.datasetIndex === 0) {
                  return ` Tokens: ${ctx.parsed.y.toLocaleString()}`;
                }
                return ` 费用: $${ctx.parsed.y.toFixed(4)}`;
              },
            },
          },
        },
        scales: {
          x: {
            ticks: { color: "#7a8f9e", font: { size: 10 } },
            grid: { color: "rgba(110,150,180,0.1)" },
          },
          y: {
            position: "left",
            ticks: {
              color: "#4ee8c5",
              font: { size: 10 },
              callback: (v) => (v >= 1000 ? (v / 1000).toFixed(0) + "k" : v),
            },
            grid: { color: "rgba(110,150,180,0.1)" },
          },
          y1: {
            position: "right",
            ticks: {
              color: "#e8b84a",
              font: { size: 10 },
              callback: (v) => "$" + v.toFixed(2),
            },
            grid: { drawOnChartArea: false },
          },
        },
      },
    });
  } catch (err) {
    console.error("[cursor-usage] error:", err);
    emptyEl.textContent = `加载失败: ${escHtml(err.message)}`;
    emptyEl.hidden = false;
    canvas.hidden = true;
  } finally {
    btn?.classList.remove("spinning");
  }
}

document.getElementById("cursor-refresh").addEventListener("click", fetchCursorUsage);
authReady.then(() => fetchCursorUsage());

/* ============================================================
   阅读流（知乎）
   ============================================================ */
const FEED_PAGE_SIZE = 15;

let feedItems = [];
let feedFilter = "all";
let feedHasMore = true;
let feedLoading = false;
let feedTotal = 0;
let feedCommentsItem = null;
let feedCommentsOffset = 0;
const feedExpandedIds = new Set();
const feedFullTextCache = new Map();
let feedScrollObserver = null;
let feedPanelVisible = false;
let feedInitialized = false;

function setFeedPanelVisible(visible) {
  const panel = document.getElementById("feed-panel");
  const btn = document.getElementById("feed-toggle-btn");
  if (!panel || !btn) return;

  feedPanelVisible = visible;
  panel.hidden = !visible;
  btn.classList.toggle("active", visible);
  btn.setAttribute("aria-pressed", visible ? "true" : "false");

  if (visible && !feedInitialized) {
    feedInitialized = true;
    fetchFeeds();
  }
  if (!visible && feedCommentsItem) closeFeedComments();
}

function formatFeedTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function platformLabel(platform) {
  return { zhihu: "知乎" }[platform] || platform;
}

function displayText(item) {
  return feedFullTextCache.get(item.id) || item.text || "";
}

function needsExpandButton(text) {
  const clean = String(text || "").trim();
  return clean.length > 100 || clean.split("\n").length > 3;
}

function shouldFetchFeedDetail(item) {
  const text = String(item.text || "").trim();
  if (!text) return true;
  if (text.length < 120) return true;
  return /…$|\.\.\.$/.test(text);
}

function platformMark(platform) {
  return { zhihu: "知" }[platform] || platform.slice(0, 1).toUpperCase();
}

function renderFeedCard(item) {
  const expanded = feedExpandedIds.has(item.id);
  const text = displayText(item);
  const showExpand = needsExpandButton(text);
  return `
    <article class="feed-card${item.bookmarked ? " bookmarked" : ""}" data-id="${escHtml(item.id)}">
      <div class="feed-card-title-row">
        <span class="feed-platform-mark feed-platform-mark-${escHtml(item.platform)}" title="${escHtml(platformLabel(item.platform))}">${escHtml(platformMark(item.platform))}</span>
        <h3 class="feed-card-title">${escHtml(item.title || "（无标题）")}</h3>
        <div class="feed-card-title-meta">
          <span class="feed-card-author">${escHtml(item.author || "匿名")}</span>
          <button type="button" class="feed-bookmark-star${item.bookmarked ? " active" : ""}" data-id="${escHtml(item.id)}" title="收藏">★</button>
        </div>
      </div>
      <div class="feed-card-body-wrap">
        <div class="feed-card-body ${expanded ? "expanded" : "collapsed"}" data-body-id="${escHtml(item.id)}">${escHtml(text || "（暂无正文）")}</div>
        ${showExpand ? `<button type="button" class="feed-expand-float" data-id="${escHtml(item.id)}">${expanded ? "收起" : "展开"}</button>` : ""}
      </div>
      <div class="feed-card-footer">
        <span class="feed-card-time">${escHtml(formatFeedTime(item.published_at))}</span>
        <div class="feed-card-actions">
          <button type="button" class="feed-comments-open" data-id="${escHtml(item.id)}">${Number(item.comment_count || 0)} 条评论</button>
          <a href="${escHtml(item.url || "#")}" target="_blank" rel="noopener" class="feed-open-link">原平台 ↗</a>
        </div>
      </div>
    </article>`;
}

function updateFeedCard(itemId) {
  const item = feedItems.find((i) => i.id === itemId);
  const card = document.querySelector(`.feed-card[data-id="${CSS.escape(itemId)}"]`);
  if (!item || !card) return;

  card.classList.toggle("bookmarked", !!item.bookmarked);
  const star = card.querySelector(".feed-bookmark-star");
  if (star) star.classList.toggle("active", !!item.bookmarked);

  const expanded = feedExpandedIds.has(itemId);
  const body = card.querySelector(".feed-card-body");
  if (body) {
    body.classList.toggle("expanded", expanded);
    body.classList.toggle("collapsed", !expanded);
    body.textContent = displayText(item) || "（暂无正文）";
  }
  const expandBtn = card.querySelector(".feed-expand-float");
  if (expandBtn) expandBtn.textContent = expanded ? "收起" : "展开";
}

function renderFeedCards() {
  const container = document.getElementById("feed-list");
  const sentinel = document.getElementById("feed-sentinel");
  if (!container) return;

  if (!feedItems.length) {
    container.innerHTML = '<div class="loading">暂无内容</div>';
    if (sentinel) sentinel.hidden = true;
    return;
  }

  container.innerHTML = feedItems.map(renderFeedCard).join("");
  if (sentinel) sentinel.hidden = !feedHasMore;
  bindFeedListEvents();
}

function bindFeedListEvents() {
  const container = document.getElementById("feed-list");
  if (!container || container.dataset.bound === "1") return;
  container.dataset.bound = "1";

  container.addEventListener("click", async (e) => {
    const bookmarkBtn = e.target.closest(".feed-bookmark-star");
    if (bookmarkBtn) {
      e.preventDefault();
      try {
        await toggleFeedBookmark(bookmarkBtn.dataset.id);
      } catch (err) {
        console.error(err);
      }
      return;
    }

    const expandBtn = e.target.closest(".feed-expand-float");
    if (expandBtn) {
      e.preventDefault();
      await toggleFeedExpand(expandBtn.dataset.id);
      return;
    }

    const commentsBtn = e.target.closest(".feed-comments-open");
    if (commentsBtn) {
      e.preventDefault();
      await openFeedComments(commentsBtn.dataset.id);
    }
  });
}

async function toggleFeedExpand(itemId) {
  const item = feedItems.find((i) => i.id === itemId);
  if (!item) return;

  const expanding = !feedExpandedIds.has(itemId);
  if (expanding) feedExpandedIds.add(itemId);
  else feedExpandedIds.delete(itemId);
  updateFeedCard(itemId);

  if (!expanding || feedFullTextCache.has(itemId) || !shouldFetchFeedDetail(item)) return;

  try {
    const detail = await Feeds.getItemDetail(itemId);
    const fullText = detail.text || item.text || "";
    feedFullTextCache.set(itemId, fullText);
    item.text = fullText;
    if (feedExpandedIds.has(itemId)) updateFeedCard(itemId);
  } catch (err) {
    console.error("[feeds] expand detail failed:", err);
  }
}

function updateFeedStatus(platforms) {
  const el = document.getElementById("feed-status");
  if (!el) return;
  const zh = platforms?.zhihu;
  if (!zh) {
    el.textContent = "未配置";
    el.className = "feed-status";
    return;
  }
  if (zh.status === "ok") {
    el.textContent = `知乎 ${zh.item_count ?? 0} 条`;
    el.className = "feed-status ok";
  } else if (zh.status === "error") {
    el.textContent = "会话失效";
    el.className = "feed-status error";
    el.title = zh.error || "";
  } else {
    el.textContent = "等待抓取";
    el.className = "feed-status";
  }
}

function feedListParams(offset, limit) {
  return {
    platform: feedFilter === "zhihu" ? "zhihu" : undefined,
    bookmarkedOnly: feedFilter === "bookmarked",
    offset,
    limit,
  };
}

async function fetchFeedPage({ reset = false } = {}) {
  if (feedLoading) return;
  feedLoading = true;
  const container = document.getElementById("feed-list");
  try {
    if (reset) {
      feedItems = [];
      feedHasMore = true;
      feedTotal = 0;
      feedExpandedIds.clear();
      feedFullTextCache.clear();
    }

    const offset = reset ? 0 : feedItems.length;
    const data = await Feeds.getFeeds(feedListParams(offset, FEED_PAGE_SIZE));
    const batch = data.items ?? [];

    if (reset) feedItems = batch;
    else feedItems.push(...batch);

    feedTotal = data.total ?? feedItems.length;
    feedHasMore = Boolean(data.has_more);

    if (!batch.length && feedHasMore && !reset) {
      await Feeds.runLoadMore({});
      const retry = await Feeds.getFeeds(feedListParams(feedItems.length, FEED_PAGE_SIZE));
      feedItems.push(...(retry.items ?? []));
      feedTotal = retry.total ?? feedItems.length;
      feedHasMore = Boolean(retry.has_more);
    }

    renderFeedCards();
  } catch (err) {
    if (container && reset) {
      container.innerHTML = `<div class="loading" style="color:#f85149">阅读流加载失败 (${escHtml(
        err.message
      )})</div>`;
    }
    updateFeedStatus(null);
  } finally {
    feedLoading = false;
  }
}

async function fetchFeeds() {
  const btn = document.getElementById("feed-refresh");
  const container = document.getElementById("feed-list");
  btn?.classList.add("spinning");
  try {
    if (feedFilter !== "bookmarked") {
      if (container) container.innerHTML = '<div class="loading">正在从知乎获取…</div>';
      await Feeds.runFetch({});
    }
    const status = await Feeds.getStatus();
    await fetchFeedPage({ reset: true });
    updateFeedStatus(status.platforms);
  } catch (err) {
    console.error("[feeds] load failed:", err);
    if (container) {
      container.innerHTML = `<div class="loading" style="color:#f85149">阅读流加载失败 (${escHtml(
        err.message
      )})</div>`;
    }
    updateFeedStatus(null);
  } finally {
    btn?.classList.remove("spinning");
  }
}

async function loadMoreFeeds() {
  if (!feedHasMore || feedLoading) return;
  const sentinel = document.getElementById("feed-sentinel");
  if (sentinel) {
    sentinel.insertAdjacentHTML("beforebegin", '<div class="feed-loading-more">加载中…</div>');
  }
  await fetchFeedPage({ reset: false });
  document.querySelector(".feed-loading-more")?.remove();
}

function setupFeedInfiniteScroll() {
  const sentinel = document.getElementById("feed-sentinel");
  if (!sentinel || feedScrollObserver) return;
  feedScrollObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMoreFeeds();
    },
    { root: null, rootMargin: "200px", threshold: 0 }
  );
  feedScrollObserver.observe(sentinel);
}

async function toggleFeedBookmark(itemId, itemOverride = null) {
  const item = itemOverride || feedItems.find((i) => i.id === itemId) || feedCommentsItem;
  if (!item) return;
  const bookmarked = item.bookmarked;
  const newState = await Feeds.toggleBookmark(itemId, item);
  item.bookmarked = newState;
  if (feedCommentsItem?.id === itemId) syncFeedCommentsBookmark();
  if (feedFilter === "bookmarked" && bookmarked) {
    feedItems = feedItems.filter((i) => i.id !== itemId);
    renderFeedCards();
    return;
  }
  const listItem = feedItems.find((i) => i.id === itemId);
  if (listItem) listItem.bookmarked = item.bookmarked;
  updateFeedCard(itemId);
}

function syncFeedCommentsBookmark() {
  const btn = document.getElementById("feed-comments-bookmark");
  if (!btn || !feedCommentsItem) return;
  btn.textContent = feedCommentsItem.bookmarked ? "★ 已收藏" : "☆ 收藏";
  btn.classList.toggle("active", !!feedCommentsItem.bookmarked);
}

const FEED_CHILD_PREVIEW_COUNT = 2;

function renderCommentChildrenSection(c) {
  const embedded = Array.isArray(c.children) ? c.children : [];
  const total = Number(c.child_count || embedded.length || 0);
  if (total <= 0) return "";

  const preview = embedded.slice(0, FEED_CHILD_PREVIEW_COUNT);
  const shown = preview.length;
  const remaining = Math.max(0, total - shown);

  let html = `<div class="feed-comment-children" id="children-${escHtml(c.id)}" data-shown="${shown}" data-total="${total}">`;
  html += preview.map((ch) => renderCommentRow(ch, { child: true })).join("");
  if (remaining > 0) {
    const label = shown === 0 ? `查看 ${total} 条回复` : `查看剩余 ${remaining} 条回复`;
    html += `<button type="button" class="feed-load-children" data-comment-id="${escHtml(c.id)}" data-offset="${shown}">${label}</button>`;
  }
  html += "</div>";
  return html;
}

function renderCommentRow(c, { child = false } = {}) {
  const avatar = c.avatar_url
    ? `<img class="feed-comment-avatar" src="${escHtml(c.avatar_url)}" alt="" />`
    : `<div class="feed-comment-avatar"></div>`;
  const replyTag = c.reply_to_author
    ? `<span class="feed-comment-reply-tag">回复 ${escHtml(c.reply_to_author)}</span> `
    : "";
  const childSection = !child ? renderCommentChildrenSection(c) : "";
  return `
    <div class="feed-comment${child ? " feed-comment-child" : ""}" data-comment-id="${escHtml(c.id)}">
      <div class="feed-comment-head">
        ${avatar}
        <div class="feed-comment-meta">
          <div class="feed-comment-author">${escHtml(c.author || "匿名")}</div>
          <div class="feed-comment-submeta">${replyTag}${escHtml(formatFeedTime(c.published_at))} · ${Number(c.like_count || 0)} 赞</div>
        </div>
      </div>
      <div class="feed-comment-text">${escHtml(c.text || "")}</div>
      ${childSection}
    </div>`;
}

function bindCommentChildButtons(root) {
  if (!root) return;
  root.querySelectorAll(".feed-load-children").forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => loadMoreCommentChildren(btn.dataset.commentId, btn));
  });
}

async function loadMoreCommentChildren(commentId, btn) {
  const box = document.getElementById(`children-${commentId}`);
  if (!box || !btn) return;

  const offset = parseInt(btn.dataset.offset || box.dataset.shown || "0", 10);
  const total = parseInt(box.dataset.total || "0", 10);
  const batchLimit =
    offset === 0 && total > FEED_CHILD_PREVIEW_COUNT ? FEED_CHILD_PREVIEW_COUNT : 20;
  btn.disabled = true;
  btn.textContent = "加载中…";

  try {
    const data = await Feeds.getCommentChildren(commentId, offset, batchLimit);
    const children = data.comments ?? [];
    btn.remove();
    if (!children.length) {
      box.insertAdjacentHTML("beforeend", '<div class="loading">暂无更多回复</div>');
      return;
    }

    box.insertAdjacentHTML(
      "beforeend",
      children.map((c) => renderCommentRow(c, { child: true })).join("")
    );
    const shown = offset + children.length;
    box.dataset.shown = String(shown);
    const remaining = Math.max(0, total - shown);
    if (remaining > 0) {
      box.insertAdjacentHTML(
        "beforeend",
        `<button type="button" class="feed-load-children" data-comment-id="${escHtml(commentId)}" data-offset="${shown}">查看剩余 ${remaining} 条回复</button>`
      );
      bindCommentChildButtons(box.closest("#feed-comments-list"));
    }
  } catch (err) {
    console.error("[feeds] child comments failed:", err);
    btn.disabled = false;
    btn.textContent = "加载失败，点击重试";
  }
}

async function openFeedComments(itemId) {
  const modal = document.getElementById("feed-comments-modal");
  if (!modal) return;
  const item = feedItems.find((i) => i.id === itemId);
  if (!item) return;
  feedCommentsItem = item;
  feedCommentsOffset = 0;

  document.getElementById("feed-comments-platform").textContent = platformLabel(item.platform);
  document.getElementById("feed-comments-title").textContent = item.title || "（无标题）";
  document.getElementById("feed-comments-link").href = item.url || "#";
  document.getElementById("feed-comments-list").innerHTML = '<div class="loading">加载评论中…</div>';
  document.getElementById("feed-comments-more").hidden = true;
  syncFeedCommentsBookmark();
  modal.hidden = false;
  document.body.classList.add("feed-modal-open");
  await loadMoreFeedComments(true);
}

function closeFeedComments() {
  const modal = document.getElementById("feed-comments-modal");
  if (modal) modal.hidden = true;
  document.body.classList.remove("feed-modal-open");
  feedCommentsItem = null;
}

async function loadMoreFeedComments(reset = false) {
  if (!feedCommentsItem) return;
  if (reset) feedCommentsOffset = 0;
  const listEl = document.getElementById("feed-comments-list");
  const moreBtn = document.getElementById("feed-comments-more");
  try {
    const data = await Feeds.getItemComments(feedCommentsItem.id, feedCommentsOffset, 20);
    const comments = data.comments ?? [];
    if (reset) listEl.innerHTML = "";
    if (!comments.length && feedCommentsOffset === 0) {
      listEl.innerHTML = '<div class="loading">暂无评论</div>';
      moreBtn.hidden = true;
      return;
    }
    listEl.insertAdjacentHTML("beforeend", comments.map((c) => renderCommentRow(c)).join(""));
    bindCommentChildButtons(listEl);
    feedCommentsOffset += comments.length;
    moreBtn.hidden = comments.length < 20;
  } catch (err) {
    console.error("[feeds] comments failed:", err);
    if (reset) listEl.innerHTML = '<div class="loading">评论加载失败</div>';
  }
}

document.getElementById("feed-tabs")?.addEventListener("click", (e) => {
  const tab = e.target.closest(".feed-tab");
  if (!tab) return;
  document.querySelectorAll(".feed-tab").forEach((el) => el.classList.remove("active"));
  tab.classList.add("active");
  feedFilter = tab.dataset.filter || "all";
  const list = document.getElementById("feed-list");
  if (list) list.dataset.bound = "";
  fetchFeeds();
});

document.getElementById("feed-refresh")?.addEventListener("click", fetchFeeds);
document.getElementById("feed-comments-close")?.addEventListener("click", closeFeedComments);
document.querySelector(".feed-comments-backdrop")?.addEventListener("click", closeFeedComments);
document.getElementById("feed-comments-bookmark")?.addEventListener("click", async () => {
  if (!feedCommentsItem) return;
  try {
    await toggleFeedBookmark(feedCommentsItem.id, feedCommentsItem);
  } catch (err) {
    console.error(err);
  }
});
document.getElementById("feed-comments-more")?.addEventListener("click", () =>
  loadMoreFeedComments(false)
);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeFeedComments();
});

document.getElementById("feed-toggle-btn")?.addEventListener("click", () => {
  setFeedPanelVisible(!feedPanelVisible);
});

setupFeedInfiniteScroll();
