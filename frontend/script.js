const API_URL = "http://127.0.0.1:8765/api/metrics";
const REFRESH_INTERVAL_MS = 60_000; // auto-refresh every 60 s

/* ============================================================
   Clock
   ============================================================ */
function updateClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  document.getElementById("clock").textContent = `${hh}:${mm}:${ss}`;

  const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  document.getElementById("date").textContent =
    `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日  ${weekdays[now.getDay()]}`;
}
setInterval(updateClock, 1000);
updateClock();

/* ============================================================
   Fuel Gauge (SVG semicircle)

   Uses the SVG pathLength="100" trick:
     stroke-dasharray="${pct} 100"  → fills exactly pct% of the arc.

   Arc path: M 15 105 A 85 85 0 0 1 185 105
     Centre (100, 105), radius 85, clockwise (sweep-flag=1).
     Draws the TOP semicircle from left → top → right.
   ============================================================ */
function buildGauge(pct, mountLabel) {
  const p = Math.min(Math.max(pct || 0, 0), 100);
  const danger   = p >= 70;
  const fillHex  = danger ? "#f85149" : "#3fb950";
  const glowRgba = danger ? "rgba(248,81,73,.7)" : "rgba(63,185,80,.5)";
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
      fill="none" stroke="#21262d" stroke-width="16" stroke-linecap="round" pathLength="100"/>
    <path d="M 15 105 A 85 85 0 0 1 185 105"
      fill="none" stroke="${fillHex}" stroke-width="16" stroke-linecap="round"
      pathLength="100" stroke-dasharray="${dashFill}" filter="url(#${id})"/>
    <line x1="100" y1="22" x2="100" y2="35" stroke="#d29922" stroke-width="2" opacity="0.5"
      transform="rotate(${-90 + 180 * 0.70} 100 105)"/>
    <text x="100" y="90" text-anchor="middle"
      fill="${fillHex}" font-size="30" font-weight="700"
      font-family="ui-monospace,'Cascadia Code',Consolas,monospace">${p.toFixed(0)}%</text>
  </svg>
  <div class="gauge-mount">${escHtml(mountLabel)}</div>
</div>`;
}

/* ============================================================
   du directory listing
   ============================================================ */
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

/* ============================================================
   Server card
   ============================================================ */
function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderServer(srv) {
  const card = document.createElement("div");
  card.className = "server-card";

  const statusCls = srv.status === "ok" ? "ok" : "error";
  // server name + collected_at on one compact line
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

  const disks = (srv.disks || []).filter(d => d.device?.startsWith("/dev/"));
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

/* ============================================================
   Search — single input, Google (Enter) + Bing buttons
   ============================================================ */
function doSearch(engine) {
  const q = document.getElementById("search-input").value.trim();
  if (!q) return;
  const urls = {
    google: "https://www.google.com/search?q=",
    bing:   "https://www.bing.com/search?q=",
  };
  window.open(urls[engine] + encodeURIComponent(q), "_blank");
}

document.getElementById("btn-google").addEventListener("click", () => doSearch("google"));
document.getElementById("btn-bing").addEventListener("click",   () => doSearch("bing"));
document.getElementById("search-input").addEventListener("keydown", e => {
  if (e.key === "Enter") doSearch("google");
});

async function fetchMetrics() {
  const container  = document.getElementById("servers-container");
  const lastUpdated = document.getElementById("last-updated");
  const btn        = document.getElementById("refresh-btn");

  btn.classList.add("spinning");

  try {
    const resp = await fetch(API_URL, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    container.innerHTML = "";
    const servers = data.servers ?? [];
    if (servers.length === 0) {
      container.innerHTML = '<div class="loading">暂无数据</div>';
    } else {
      servers.forEach(srv => container.appendChild(renderServer(srv)));
    }
    lastUpdated.textContent = `更新于 ${data.last_updated ?? "—"}`;
  } catch (err) {
    container.innerHTML = `
      <div class="loading" style="color:#f85149">
        无法连接到后端服务 (${escHtml(err.message)})<br>
        请确认 <code>python run.py</code> 已启动
      </div>`;
    lastUpdated.textContent = "连接失败";
  } finally {
    btn.classList.remove("spinning");
  }
}

document.getElementById("refresh-btn").addEventListener("click", fetchMetrics);
fetchMetrics();
setInterval(fetchMetrics, REFRESH_INTERVAL_MS);

/* ============================================================
   Cursor Usage Chart
   ============================================================ */
const CURSOR_API = "http://127.0.0.1:8765/api/cursor-usage";
let cursorChartInst = null;

async function fetchCursorUsage() {
  const canvas  = document.getElementById("cursor-chart");
  const emptyEl = document.getElementById("cursor-empty");
  const statsEl = document.getElementById("cursor-stats");
  const rangeEl = document.getElementById("cursor-range");
  const btn     = document.getElementById("cursor-refresh");
  if (!canvas) return;

  btn && btn.classList.add("spinning");

  try {
    const resp = await fetch(CURSOR_API, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();

    // The API returns { usageEventsDisplay: [...], totalUsageEventsCount: N }
    const events = Array.isArray(data) ? data
                 : (data.usageEventsDisplay ?? data.events ?? data.usageEvents ?? data.data ?? []);

    if (!events.length) {
      emptyEl.hidden = false;
      canvas.hidden  = true;
      return;
    }

    emptyEl.hidden = true;
    canvas.hidden  = false;

    // ── Aggregate by date ───────────────────────────────────
    const byDate  = {};  // date → tokens
    const byCents = {};  // date → chargedCents (¢)
    let totalTokens = 0;
    let totalCents  = 0;

    // Sort events chronologically so dates appear left→right
    const sorted = [...events].sort((a, b) =>
      Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0));

    for (const ev of sorted) {
      const ts = ev.timestamp ?? ev.createdAt ?? ev.created_at ?? ev.date;
      const date = ts
        ? new Date(Number(ts)).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })
        : "unknown";
      const tu     = ev.tokenUsage ?? {};
      const tokens = Number(
        ev.totalTokens ?? ev.total_tokens ?? ev.tokens
        ?? ((tu.inputTokens ?? 0) + (tu.outputTokens ?? 0))
      );
      const cents = Number(ev.chargedCents ?? ev.charged_cents ?? tu.totalCents ?? 0);
      byDate[date]  = (byDate[date]  ?? 0) + tokens;
      byCents[date] = (byCents[date] ?? 0) + cents;
      totalTokens += tokens;
      totalCents  += cents;
    }

    const labels     = Object.keys(byDate);
    const values     = Object.values(byDate);
    const centsArr   = labels.map(d => byCents[d] ?? 0);

    // date range label
    if (rangeEl && labels.length) {
      rangeEl.textContent = `${labels[0]} – ${labels[labels.length - 1]}`;
    }

    // hide empty hint, show canvas
    emptyEl.hidden = true;
    canvas.hidden  = false;

    // ── Stats bar ────────────────────────────────────────────
    const modelCounts = {};
    for (const ev of events) {
      const m = ev.model ?? ev.modelName ?? ev.model_name ?? "unknown";
      modelCounts[m] = (modelCounts[m] ?? 0) + 1;
    }
    const topModels = Object.entries(modelCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([m, c]) => `<span class="stat-chip"><span class="stat-model">${escHtml(m)}</span><span class="stat-cnt">${c}</span></span>`)
      .join("");

    const dollarTotal = (totalCents / 100).toFixed(2);
    statsEl.innerHTML = `
      <span class="stat-chip"><span class="stat-label">请求</span><span class="stat-cnt">${events.length}</span></span>
      <span class="stat-chip"><span class="stat-label">Tokens</span><span class="stat-cnt">${totalTokens.toLocaleString()}</span></span>
      <span class="stat-chip"><span class="stat-label">费用</span><span class="stat-cnt">$${dollarTotal}</span></span>
      ${topModels}`;

    // ── Chart ────────────────────────────────────────────────
    if (cursorChartInst) cursorChartInst.destroy();
    cursorChartInst = new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Tokens",
          data: values,
          backgroundColor: "rgba(88,166,255,0.65)",
          borderColor: "rgba(88,166,255,1)",
          borderWidth: 1,
          borderRadius: 3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: items => items[0].label,
              label: ctx => {
                const i = ctx.dataIndex;
                const tok = values[i];
                const usd = (centsArr[i] / 100).toFixed(4);
                return [
                  ` Tokens: ${tok.toLocaleString()}`,
                  ` 费用:   $${usd}`,
                ];
              },
            },
          },
        },
        scales: {
          x: {
            ticks: { color: "#8b949e", font: { size: 10 } },
            grid:  { color: "rgba(48,54,61,0.6)" },
          },
          y: {
            ticks: {
              color: "#8b949e", font: { size: 10 },
              callback: v => v >= 1000 ? (v / 1000).toFixed(0) + "k" : v,
            },
            grid: { color: "rgba(48,54,61,0.6)" },
          },
        },
      },
    });

  } catch (err) {
    console.error("[cursor-usage] error:", err);
    emptyEl.textContent = `加载失败: ${escHtml(err.message)}`;
    emptyEl.hidden = false;
    canvas.hidden  = true;
  } finally {
    btn && btn.classList.remove("spinning");
  }
}

document.getElementById("cursor-refresh")?.addEventListener("click", fetchCursorUsage);
fetchCursorUsage();

