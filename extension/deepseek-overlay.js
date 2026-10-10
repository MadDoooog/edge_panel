/* ============================================================
   deepseek-overlay.js — chat.deepseek.com 会话页持仓浮层（content script）

   形态：
   - 默认收成一颗「持仓」悬浮球（左侧小圆点表示状态：绿=在带内 / 橙=出带 / 红=行情失败）
   - 点球展开卡片：持仓明细、合计、四类占比、出带信号
   - 卡片里两个动作：「复制快照」（写剪贴板，必成功路径）与
     「填入输入框」（尽力而为：把快照插进 DeepSeek 的输入框，失败则退回剪贴板）
   - 外观跟随 DeepSeek 自己的浅色/深色主题（不是浏览器主题）

   设计约束（改这个文件前先读）：
   - 挂载判定只看 location（/a/:agentId/s/:sessionId），不依赖页面 DOM 选择器。
   - 取价必须经 background：content script 的 fetch 受页面源 CORS 约束，
     扩展 host_permissions 对它不生效，行情接口也不返回 CORS 头。
   - Shadow DOM + adoptedStyleSheets：隔离页面样式，并绕开页面 CSP 对内联 <style> 的限制。
   - 只读边界：不读对话内容、不自动发送。唯一写页面的动作是用户点「填入输入框」。
   ============================================================ */
(function () {
  "use strict";

  const CONFIG_KEY = "financeConfig";
  const UI_KEY = "financeOverlayUi";
  const SESSION_IN_PATH = /^\/a\/[^/]+\/s\/([^/?#]+)/;
  const CLASS_KEYS = ["stock", "bond", "gold", "cash"];
  const CLASS_LABEL = { stock: "股", bond: "债", gold: "金", cash: "现金" };
  const SNAPSHOT_MARK = "持仓快照";
  const NAV_POLL_MS = 800;
  const REFRESH_MS = 60 * 1000;
  const THEME_POLL_MS = 2000;

  const DEFAULT_CONFIG = {
    sessionIds: [],
    holdings: [],
    investableCash: 0,
    emergencyFund: 0,
    targetPct: 25,
    bandLowPct: 15,
    bandHighPct: 35,
    commissionRateBp: 0.9,
    commissionMin: 5,
    showUnmatchedChip: true,
  };

  /** 会话页 URL → sessionId（非会话页返回 null）。 */
  function currentSessionId() {
    const m = location.pathname.match(SESSION_IN_PATH);
    return m ? decodeURIComponent(m[1]) : null;
  }

  /** 会话 id 归一化：允许直接粘整条 URL（从中抽 /s/<id>），也容忍裸 id 与中英文引号。 */
  function extractSessionId(raw) {
    const s = String(raw || "")
      .trim()
      .replace(/^[\s"'`\u201c\u201d\u2018\u2019\u300c\u300d]+|[\s"'`\u201c\u201d\u2018\u2019\u300c\u300d]+$/g, "");
    const m = s.match(/\/s\/([^/?#\s]+)/);
    if (m) return m[1];
    return s.replace(/[/?#].*$/, "");
  }

  function normalizeConfig(raw) {
    const cfg = Object.assign({}, DEFAULT_CONFIG, raw && typeof raw === "object" ? raw : {});
    cfg.sessionIds = (Array.isArray(cfg.sessionIds) ? cfg.sessionIds : []).map(extractSessionId).filter(Boolean);
    cfg.holdings = (Array.isArray(cfg.holdings) ? cfg.holdings : []).filter((h) => h && h.code);
    return cfg;
  }

  /** 归一化代码：允许 "510300" / "sh510300"，缺市场时按首位数字推断。 */
  function normalizeQuoteCode(raw) {
    const m = String(raw || "").trim().toLowerCase().match(/^(?:(sh|sz))?(\d{6})$/);
    if (!m) return null;
    const prefix = m[1] || (/^[569]/.test(m[2]) ? "sh" : "sz");
    return prefix + m[2];
  }

  const escHtml = (s) =>
    String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  function fmtNum(n, digits) {
    const d = digits == null ? 2 : digits;
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function fmtSigned(n, digits) {
    if (!Number.isFinite(n)) return "—";
    const sign = n > 0 ? "+" : n < 0 ? "-" : "";
    return sign + fmtNum(Math.abs(n), digits == null ? 2 : digits);
  }

  function fmtPct(n, digits) {
    const d = digits == null ? 1 : digits;
    if (!Number.isFinite(n)) return "—";
    return `${n > 0 ? "+" : ""}${n.toFixed(d)}%`;
  }

  /** 下一个补弱窗口（6/10、12/10）距今天数，仅作参考显示。 */
  function daysToNextWindow() {
    const now = new Date();
    const year = now.getFullYear();
    const today = new Date(year, now.getMonth(), now.getDate()).getTime();
    const candidates = [new Date(year, 5, 10), new Date(year, 11, 10), new Date(year + 1, 5, 10)].filter(
      (d) => d.getTime() >= today
    );
    if (!candidates.length) return null;
    const next = candidates[0];
    return { days: Math.round((next - today) / 86400000), date: next };
  }

  /* ── 状态 ─────────────────────────────────────────────── */

  let config = normalizeConfig(null);
  let quotes = null;
  let quoteAt = null;
  let quoteErrors = [];
  let quoteFailed = false;
  let loading = false;
  let ui = { collapsed: true, x: null, y: 84 };
  let host = null;
  let card = null;
  let refreshTimer = null;
  let themeTimer = null;
  let mountToast = "";
  let manualCopy = ""; // 剪贴板不可用时摊在卡片里让用户手动复制的文本
  let setupChip = false;
  let pageTheme = "light";

  /* ── 主题：跟随 DeepSeek 自身的浅色/深色 ──────────────── */

  function sampleLuminance(el) {
    try {
      const bg = getComputedStyle(el).backgroundColor || "";
      const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(bg);
      if (!m) return null;
      if (m[4] != null && Number(m[4]) === 0) return null; // 透明，继续往上找
      const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    } catch (_) {
      return null;
    }
  }

  /**
   * 判断页面当前主题：优先采样实际渲染色（DeepSeek 有浅色/深色开关），
   * 采样不到时退回系统 prefer-color-scheme。
   */
  function detectPageTheme() {
    for (const el of [document.body, document.documentElement]) {
      const lum = el ? sampleLuminance(el) : null;
      if (lum != null) return lum < 0.5 ? "dark" : "light";
    }
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function applyTheme() {
    if (!host) return;
    const next = detectPageTheme();
    if (next === pageTheme && host.classList.contains(`theme-${next}`)) return;
    pageTheme = next;
    host.classList.remove("theme-light", "theme-dark");
    host.classList.add(`theme-${next}`);
  }

  /* ── 取价（经 background 代理） ────────────────────────── */

  async function refreshQuotes(force) {
    const codes = [...new Set(config.holdings.map((h) => normalizeQuoteCode(h.code)).filter(Boolean))];
    if (!codes.length) {
      quotes = {};
      quoteFailed = false;
      quoteErrors = [];
      render();
      return;
    }
    loading = true;
    render();
    try {
      const resp = await chrome.runtime.sendMessage({ type: "finance-quotes", codes, force: force === true });
      if (!resp || resp.ok !== true) throw new Error((resp && resp.error) || "background 无响应");
      quotes = resp.quotes || {};
      quoteAt = resp.at || null;
      quoteErrors = resp.errors || [];
      quoteFailed = false;
    } catch (err) {
      quoteFailed = true;
      quoteErrors = [{ message: String((err && err.message) || err) }];
    }
    loading = false;
    render();
  }

  /* ── 计算（纯算术，不含任何建议） ──────────────────────── */

  function buildModel() {
    const cfg = config;
    const rows = cfg.holdings.map((h) => {
      const code = normalizeQuoteCode(h.code) || String(h.code || "");
      const q = quotes ? quotes[code] : null;
      const shares = Number(h.shares) || 0;
      const cost = Number(h.cost) || 0;
      const price = q && Number.isFinite(q.price) ? q.price : null;
      const valuing = price == null ? cost : price; // 缺价时按成本估值，并在 UI 标注
      const mv = shares * valuing;
      const costValue = shares * cost;
      const pl = mv - costValue;
      return {
        code,
        name: h.name || (q && q.name) || "",
        cls: CLASS_KEYS.indexOf(h.cls) >= 0 ? h.cls : "stock",
        asof: h.asof || "",
        shares,
        cost,
        price,
        priceOk: price != null,
        mv,
        costValue,
        pl,
        plPct: costValue > 0 ? (pl / costValue) * 100 : null,
        time: q ? q.time || "" : "",
        doubtful: Boolean(q && q.doubtful),
        altPrice: q ? q.altPrice : null,
      };
    });

    const acct = { stock: 0, bond: 0, gold: 0, cash: 0 };
    for (const r of rows) acct[r.cls] += r.mv;
    const acctTotal = rows.reduce((s, r) => s + r.mv, 0);
    const costTotal = rows.reduce((s, r) => s + r.costValue, 0);

    const cashExtra = Number(cfg.investableCash) || 0;
    const emergency = Number(cfg.emergencyFund) || 0;
    const scopes = [
      { key: "acct", label: "仅证券账户", extra: 0 },
      { key: "investable", label: "证券+可投资现金", extra: cashExtra },
      { key: "all", label: "证券+全部账外现金", extra: cashExtra + emergency },
    ].map((s) => {
      const total = acctTotal + s.extra;
      const pct = {};
      for (const k of CLASS_KEYS) pct[k] = total > 0 ? ((acct[k] + (k === "cash" ? s.extra : 0)) / total) * 100 : 0;
      return { key: s.key, label: s.label, extra: s.extra, total, pct };
    });

    // 默认口径：证券 + 可投资现金腿
    const primary = scopes[1];
    const signals = CLASS_KEYS.map((k) => {
      const pct = primary.pct[k];
      const want = (primary.total * (Number(cfg.targetPct) || 0)) / 100;
      const cur = acct[k] + (k === "cash" ? primary.extra : 0);
      return { cls: k, pct, low: pct < cfg.bandLowPct, high: pct > cfg.bandHighPct, delta: want - cur };
    }).filter((s) => s.low || s.high);

    const quoteTimes = rows.map((r) => r.time).filter(Boolean).sort();
    const quantityAsOf = rows.map((r) => r.asof).filter(Boolean).sort()[0] || "";
    return {
      rows,
      acct,
      scopes,
      primary,
      signals,
      acctTotal,
      costTotal,
      pl: acctTotal - costTotal,
      missing: rows.filter((r) => !r.priceOk),
      doubtful: rows.filter((r) => r.doubtful),
      quoteTime: quoteTimes.length ? quoteTimes[quoteTimes.length - 1] : "",
      quantityAsOf,
    };
  }

  /* ── 快照文本（复制 / 填入共用） ──────────────────────── */

  function buildSnapshot() {
    const m = buildModel();
    const cfg = config;
    const lines = [];
    const srcNote = quoteFailed
      ? "行情获取失败，以下按成本估值"
      : `行情 ${m.quoteTime || "—"}（腾讯+新浪双源${m.doubtful.length ? "不一致，见下" : "一致"}）`;
    const qtyNote = m.quantityAsOf
      ? `份额/成本录入于 ${m.quantityAsOf}，未经券商核对`
      : "份额/成本为手工录入，未经券商核对";
    // 首行是「标题」：DeepSeek 把长文本转附件时用它派生文件名（会删掉 : 等禁用字符），
    // 所以这里只放日期 + 内容，不放带冒号的时间。
    const stamp =
      (m.quoteTime || "").slice(0, 10) ||
      m.quantityAsOf ||
      new Date().toISOString().slice(0, 10);
    lines.push(`${SNAPSHOT_MARK} ${stamp}`.trim());
    lines.push(`${srcNote} · ${qtyNote}`);
    if (quoteFailed) lines.push(`⚠ 取价失败：${quoteErrors.map((e) => e.message).join("；")}`);
    for (const r of m.missing) lines.push(`⚠ ${r.code} 现价缺失（该行按成本计入）`);
    for (const r of m.doubtful)
      lines.push(`⚠ ${r.code} 两源价差>0.5%：腾讯/新浪 ${fmtNum(r.price, 3)} vs ${fmtNum(r.altPrice, 3)}`);
    lines.push("");
    lines.push("| 代码 | 名称 | 类别 | 份额 | 成本 | 现价 | 市值 | 浮动盈亏 | 幅度 |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    for (const r of m.rows) {
      lines.push(
        `| ${r.code} | ${r.name || "—"} | ${CLASS_LABEL[r.cls]} | ${fmtNum(r.shares, 0)} | ${fmtNum(r.cost, 3)} | ` +
          `${r.priceOk ? fmtNum(r.price, 3) : "缺失"} | ${fmtNum(r.mv)} | ${fmtSigned(r.pl)} | ${
            r.plPct == null ? "—" : fmtPct(r.plPct)
          } |`
      );
    }
    lines.push(
      `| 合计 | | | | | | ${fmtNum(m.acctTotal)} | ${fmtSigned(m.pl)} | ${
        m.costTotal > 0 ? fmtPct((m.pl / m.costTotal) * 100) : "—"
      } |`
    );
    lines.push("");
    const p = m.primary;
    lines.push(
      `占比（口径② ${p.label} ${fmtNum(p.extra, 0)}，合计 ${fmtNum(p.total)}）：` +
        CLASS_KEYS.map((k) => `${CLASS_LABEL[k]} ${p.pct[k].toFixed(1)}%`).join(" / ") +
        `；目标 ${cfg.targetPct}%，带 ${cfg.bandLowPct}%~${cfg.bandHighPct}%`
    );
    if (m.signals.length) {
      for (const s of m.signals) {
        const dir = s.low ? "低于" : "高于";
        lines.push(
          `出带信号：${CLASS_LABEL[s.cls]} ${s.pct.toFixed(1)}% ${s.low ? "<" : ">"} ${
            s.low ? cfg.bandLowPct : cfg.bandHighPct
          }%（${dir} ${cfg.targetPct}% 目标 ${fmtSigned(Math.abs(s.delta))} 元）`
        );
      }
    } else {
      lines.push(`出带信号：无（四类均在 ${cfg.bandLowPct}%~${cfg.bandHighPct}% 带内）`);
    }
    for (const s of m.scopes.filter((x) => x.key !== "investable")) {
      lines.push(`参考口径（${s.label}）：` + CLASS_KEYS.map((k) => `${CLASS_LABEL[k]} ${s.pct[k].toFixed(1)}%`).join(" / "));
    }
    lines.push(`账外现金：应急金/不可动 ${fmtNum(cfg.emergencyFund, 0)}，可投资 ${fmtNum(cfg.investableCash, 0)}`);
    const breakEven = (Number(cfg.commissionMin) || 0) / ((Number(cfg.commissionRateBp) || 0) / 10000);
    if (Number.isFinite(breakEven) && breakEven > 0) {
      lines.push(`成本提示：佣金 万${cfg.commissionRateBp}、最低 ${cfg.commissionMin} 元 → 单笔低于 ${fmtNum(breakEven)} 元时不划算`);
    }
    const win = daysToNextWindow();
    if (win) lines.push(`纪律窗口：距 ${win.date.getMonth() + 1} 月补弱窗口 ${win.days} 天（仅参考）`);
    lines.push("本快照只含事实与算术，不含任何买卖建议。");
    return lines.join("\n");
  }

  /* ── 写入剪贴板 / 填入输入框 ─────────────────────────── */

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      /* 落到 execCommand 兜底 */
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:-1000px;opacity:0;";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  /** 找 DeepSeek 输入框：可见 textarea 优先，其次 contenteditable/role=textbox。 */
  function findComposer() {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 16) return false;
      if (r.bottom < 0 || r.top > window.innerHeight) return false;
      const st = getComputedStyle(el);
      return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
    };
    const areas = [...document.querySelectorAll("textarea")].filter(visible);
    if (areas.length) {
      areas.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
      return areas[0];
    }
    const editables = [...document.querySelectorAll('[contenteditable="true"], [role="textbox"]')].filter(visible);
    return editables[0] || null;
  }

  /**
   * 把文本插进输入框（追加到末尾，不动用户已输入的内容）。
   * 首选 execCommand("insertText")：等于真键盘输入，React 受控组件才会收到变化。
   */
  function insertTextInto(el, text) {
    const before = el.tagName === "TEXTAREA" ? el.value : el.textContent || "";
    const payload = (before ? "\n" : "") + text;
    try {
      el.focus();
      if (el.tagName === "TEXTAREA") el.setSelectionRange(el.value.length, el.value.length);
      else {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      if (!document.execCommand("insertText", false, payload)) {
        if (el.tagName !== "TEXTAREA") return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        setter.call(el, before + payload);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } catch (_) {
      return false;
    }
    const after = el.tagName === "TEXTAREA" ? el.value : el.textContent || "";
    return after.includes(SNAPSHOT_MARK);
  }

  function fillComposer(text) {
    const el = findComposer();
    return el ? insertTextInto(el, text) : false;
  }

  /** 附件文件名：DeepSeek 用「首行清洗后 ≤50 字」派生，这里保持一致。 */
  function derivedFileName(text) {
    const first = String(text).split(/\r?\n/)[0] || SNAPSHOT_MARK;
    const name = first.replace(/[\\/:*?"<>|\x00-\x1f]/g, "").replace(/\s+/g, " ").trim();
    return `${(name || SNAPSHOT_MARK).slice(0, 50)}.txt`;
  }

  /** 轮询等待断言成立（附件上传是异步的，chip 不会立刻出现）。 */
  function waitFor(fn, timeoutMs, stepMs) {
    const timeout = timeoutMs == null ? 2000 : timeoutMs;
    const step = stepMs == null ? 150 : stepMs;
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        let ok = false;
        try {
          ok = fn();
        } catch (_) {}
        if (ok) return resolve(true);
        if (Date.now() - started >= timeout) return resolve(false);
        setTimeout(tick, step);
      };
      tick();
    });
  }

  /** 附件 chip 是否已渲染到页面上（用文件名前缀判定）。 */
  function attachmentVisible(name) {
    const probe = String(name).replace(/\.txt$/i, "").slice(0, 16);
    if (!probe) return false;
    const host = document.body || document.documentElement;
    return Boolean(host && (host.innerText || host.textContent || "").includes(probe));
  }

  /**
   * 模拟一次真实粘贴。DeepSeek 的 onPaste 逻辑是：
   *   纯文本按 Ctrl+V → 若「文本长度 > pasteTextToFileLimit 且还能再加附件」→
   *   preventDefault 并把它转成 .txt 附件上传（用户观察到的那种行为）。
   * 它只在真的要转附件时才 preventDefault，所以 dispatchEvent 返回 false
   * 就是「它接管了」的可靠信号；返回 true 表示它按普通文本处理（合成事件
   * 不会真的插入，需要我们自己插）。
   */
  function dispatchPaste(el, text) {
    try {
      if (typeof DataTransfer !== "function" || typeof ClipboardEvent !== "function") return null;
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      return el.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })
      );
    } catch (_) {
      return null; // 环境不支持构造带 clipboardData 的事件
    }
  }

  /** 兜底通道：把 File 直接塞进页面的 file input，走它自己的上传流程。 */
  function uploadViaFileInput(text) {
    const inputs = [...document.querySelectorAll('input[type="file"]')];
    if (!inputs.length) return false;
    let dt;
    try {
      dt = new DataTransfer();
      dt.items.add(new File([text], derivedFileName(text), { type: "text/plain;charset=utf-8" }));
    } catch (_) {
      return false;
    }
    for (const input of inputs) {
      try {
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      } catch (_) {
        /* 试下一个 input */
      }
    }
    return false;
  }

  /**
   * 把快照送进对话输入框。
   * 返回："file"（已上传为附件）/ "file-pending"（已触发但没等到 chip）/
   *       "inline"（作为文本填入）/ "no-composer" / "failed"
   */
  async function deliverToComposer(text, opts) {
    const forceAttachment = Boolean(opts && opts.forceAttachment);
    const el = findComposer();
    if (!el) return "no-composer";
    const name = derivedFileName(text);

    const dispatched = dispatchPaste(el, text);
    if (dispatched === false) {
      const ok = await waitFor(() => attachmentVisible(name));
      return ok ? "file" : "file-pending";
    }

    if (forceAttachment && uploadViaFileInput(text)) {
      if (await waitFor(() => attachmentVisible(name))) return "file";
    }
    return insertTextInto(el, text) ? "inline" : "failed";
  }

  /* ── 渲染 ─────────────────────────────────────────────── */

  const CSS_TEXT = `
    /* 亮/暗两套令牌，跟 DeepSeek 自己的主题走（host 上挂 theme-light / theme-dark） */
    :host {
      --ep-bg: #ffffff;
      --ep-bg-soft: #f7f8fa;
      --ep-border: #e5e7eb;
      --ep-text: #1a1a1a;
      --ep-muted: #8b8b8b;
      --ep-accent: #4d6bfe;
      --ep-accent-weak: rgba(77, 107, 254, 0.08);
      --ep-up: #e5484d;
      --ep-down: #30a46c;
      --ep-warn: #f0b849;
      --ep-shadow: 0 4px 18px rgba(0, 0, 0, 0.14);
      --ep-font: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      --ep-mono: ui-monospace, "SF Mono", Consolas, "Roboto Mono", monospace;

      position: fixed !important;
      z-index: 2147483000 !important;
      top: var(--ep-top, 84px);
      left: var(--ep-left, auto);
      right: var(--ep-right, 16px);
      display: block; width: auto; height: auto; max-width: none; max-height: none;
      margin: 0; padding: 0; transform: none; opacity: 1; visibility: visible;
    }
    :host(.theme-dark) {
      --ep-bg: #2b2b2b;
      --ep-bg-soft: #333333;
      --ep-border: #404040;
      --ep-text: #e6e6e6;
      --ep-muted: #9b9b9b;
      --ep-accent: #6b83ff;
      --ep-accent-weak: rgba(107, 131, 255, 0.16);
      --ep-up: #ff7b72;
      --ep-down: #4ade80;
      --ep-shadow: 0 4px 18px rgba(0, 0, 0, 0.5);
    }

    button { all: unset; font: inherit; cursor: pointer; }

    /* ── 悬浮球（默认形态）：可拖可点，右侧独立复制按钮 ── */
    .ball-wrap { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 6px; }
    .ball {
      display: inline-flex; align-items: center;
      background: var(--ep-bg);
      border: 1px solid var(--ep-border);
      border-radius: 999px;
      box-shadow: var(--ep-shadow);
      overflow: hidden;
    }
    /* 拖动与「点击=转附件」都挂在 .ball-main 上（它是 span，不会被拖动逻辑的
       button 过滤挡掉 —— 之前挂在整颗球上时，球体就是 button，导致拖不动） */
    .ball-main {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 9px 6px 11px;
      font: 13px/1.4 var(--ep-font);
      color: var(--ep-text);
      cursor: pointer;
      user-select: none;
    }
    .ball-main:hover { background: var(--ep-bg-soft); }
    .ball-main:focus-visible { outline: 2px solid var(--ep-accent); outline-offset: -2px; }
    .ball-seg {
      padding: 6px 9px;
      font-size: 13px; line-height: 1.4;
      color: var(--ep-muted);
      border-left: 1px solid var(--ep-border);
    }
    .ball-seg:hover { color: var(--ep-text); background: var(--ep-bg-soft); }
    .ball-toast {
      padding: 4px 9px;
      font: 11.5px/1.4 var(--ep-font);
      color: var(--ep-text);
      background: var(--ep-bg);
      border: 1px solid var(--ep-border);
      border-radius: 8px;
      box-shadow: var(--ep-shadow);
    }
    .ball .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ep-muted); }
    .ball .dot.ok { background: var(--ep-down); }
    .ball .dot.warn { background: var(--ep-warn); }
    .ball .dot.err { background: var(--ep-up); }

    /* ── 展开卡片 ── */
    .card {
      width: 306px; box-sizing: border-box;
      font: 12.5px/1.55 var(--ep-font);
      color: var(--ep-text);
      background: var(--ep-bg);
      border: 1px solid var(--ep-border);
      border-radius: 12px;
      box-shadow: var(--ep-shadow);
      overflow: hidden;
      user-select: none;
    }
    .head {
      display: flex; align-items: center; gap: 6px;
      padding: 7px 8px 7px 10px;
      border-bottom: 1px solid var(--ep-border);
      cursor: move;
    }
    .head .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ep-muted); flex: 0 0 auto; }
    .head .dot.ok { background: var(--ep-down); }
    .head .dot.warn { background: var(--ep-warn); }
    .head .dot.err { background: var(--ep-up); }
    .head .title { font-weight: 600; font-size: 13px; }
    .head .stamp { margin-left: auto; font: 11px/1.4 var(--ep-mono); color: var(--ep-muted); white-space: nowrap; }
    .head button { padding: 2px 5px; border-radius: 5px; color: var(--ep-muted); font-size: 12px; }
    .head button:hover { color: var(--ep-text); background: var(--ep-bg-soft); }

    .body { padding: 6px 10px 10px; }
    .warn {
      margin: 4px 0; padding: 5px 7px; border-radius: 6px; font-size: 11px; line-height: 1.45;
      color: var(--ep-warn); background: rgba(240, 184, 73, 0.12);
    }
    .warn.bad { color: var(--ep-up); background: rgba(229, 72, 77, 0.12); }

    .row { padding: 5px 0; border-bottom: 1px solid var(--ep-border); }
    .row:last-of-type { border-bottom: none; }
    .row-top { display: flex; align-items: baseline; gap: 6px; }
    .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .code { font: 10.5px/1.4 var(--ep-mono); color: var(--ep-muted); }
    .pl { font: 12px/1.4 var(--ep-mono); font-weight: 600; }
    .up { color: var(--ep-up); }
    .down { color: var(--ep-down); }
    .row-sub {
      display: flex; justify-content: space-between; gap: 8px; margin-top: 1px;
      font: 10.5px/1.45 var(--ep-mono); color: var(--ep-muted);
    }
    .stale { opacity: 0.6; }

    .totals {
      display: flex; align-items: baseline; gap: 6px;
      margin-top: 7px; padding-top: 7px; border-top: 1px solid var(--ep-border);
    }
    .totals .lbl { color: var(--ep-muted); }
    .totals .val { margin-left: auto; font: 12.5px/1.4 var(--ep-mono); font-weight: 600; }
    .pcts { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px 8px; }
    .pct { font: 11px/1.5 var(--ep-mono); color: var(--ep-muted); }
    .pct b { color: var(--ep-text); }

    .sig {
      margin-top: 7px; padding: 6px 7px; border-radius: 6px;
      font-size: 11px; line-height: 1.5;
      color: var(--ep-warn); background: rgba(240, 184, 73, 0.12);
    }
    .sig.ok { color: var(--ep-down); background: rgba(48, 163, 108, 0.12); }

    .actions { display: flex; gap: 6px; margin-top: 9px; }
    .actions button {
      flex: 1; text-align: center; padding: 6px 0;
      font-size: 12px; font-weight: 500;
      border-radius: 7px;
      color: var(--ep-accent); background: var(--ep-accent-weak);
      border: 1px solid transparent;
      transition: filter 0.15s;
    }
    .actions button:hover { filter: brightness(0.96); }
    .actions button.primary { color: #fff; background: var(--ep-accent); }
    .actions button:disabled { opacity: 0.5; cursor: default; }
    @media (prefers-color-scheme: dark) { .actions button.primary { color: #fff; } }

    .toast { margin-top: 7px; font-size: 11px; text-align: center; color: var(--ep-down); }
    .toast.bad { color: var(--ep-warn); }
    textarea.manual {
      display: block; width: 100%; box-sizing: border-box; height: 96px;
      margin-top: 8px; padding: 6px;
      font: 11px/1.45 var(--ep-mono);
      color: var(--ep-text); background: var(--ep-bg-soft);
      border: 1px solid var(--ep-border); border-radius: 6px;
      resize: vertical; user-select: text;
    }
    .foot { margin-top: 7px; font-size: 10.5px; color: var(--ep-muted); line-height: 1.45; }

    /* ── 未匹配/未配置角标 ── */
    .chip button {
      display: block; padding: 5px 11px;
      font: 12px/1.5 var(--ep-font);
      color: var(--ep-accent);
      background: var(--ep-bg);
      border: 1px solid var(--ep-border);
      border-radius: 999px;
      box-shadow: var(--ep-shadow);
      white-space: nowrap;
    }
  `;

  function applyPosition() {
    if (!host) return;
    host.style.setProperty("--ep-top", `${Number(ui.y) || 84}px`);
    if (ui.x == null) {
      host.style.setProperty("--ep-right", "16px");
      host.style.removeProperty("--ep-left");
    } else {
      host.style.setProperty("--ep-left", `${Number(ui.x)}px`);
      host.style.setProperty("--ep-right", "auto");
    }
  }

  function ensureMounted() {
    if (host) return;
    host = document.createElement("div");
    host.id = "edge-panel-finance-overlay";
    host.classList.add(`theme-${pageTheme}`);
    applyPosition();

    const root = host.attachShadow({ mode: "open" });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS_TEXT);
      root.adoptedStyleSheets = [sheet];
    } catch (_) {
      const style = document.createElement("style");
      style.textContent = CSS_TEXT;
      root.appendChild(style);
    }
    card = document.createElement("div");
    root.appendChild(card);
    document.body.appendChild(host);
    render();
    applyTheme();
  }

  function unmount() {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    card = null;
  }

  /** 当前会话页是否匹配设置里指定的会话。 */
  function shouldMount() {
    const id = currentSessionId();
    if (!id) return false;
    return config.sessionIds.indexOf(id) >= 0;
  }

  /** 拖动：空白处拖走；未拖动的单击由 onClick 决定（球=展开）。 */
  function bindDrag(el, onClick) {
    let drag = null;
    el.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button, a, textarea")) return;
      const rect = host.getBoundingClientRect();
      drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, id: e.pointerId, sx: e.clientX, sy: e.clientY };
      try {
        el.setPointerCapture(e.pointerId);
      } catch (_) {}
    });
    el.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const w = host.offsetWidth || 300;
      const x = Math.max(4, Math.min(window.innerWidth - w - 4, e.clientX - drag.dx));
      const y = Math.max(4, Math.min(window.innerHeight - 40, e.clientY - drag.dy));
      host.style.setProperty("--ep-left", `${Math.round(x)}px`);
      host.style.setProperty("--ep-right", "auto");
      host.style.setProperty("--ep-top", `${Math.round(y)}px`);
    });
    const end = (e) => {
      if (!drag || (e && e.pointerId != null && e.pointerId !== drag.id)) return;
      // 用位移距离（而不是事件次数）区分「点击」与「拖动」——鼠标抖动不会误判成拖动
      const dist = Math.hypot((e && e.clientX != null ? e.clientX : drag.sx) - drag.sx,
                             (e && e.clientY != null ? e.clientY : drag.sy) - drag.sy);
      drag = null;
      const rect = host.getBoundingClientRect();
      ui.x = Math.round(rect.left);
      ui.y = Math.round(rect.top);
      chrome.storage.local.set({ [UI_KEY]: ui }).catch(() => {});
      if (dist < 4 && onClick) onClick();
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  /** 球的圆点/卡片头部的圆点：状态一眼可见。 */
  function statusDotClass(m) {
    if (quoteFailed) return "err";
    if (m && m.signals.length) return "warn";
    return "ok";
  }

  function setExpanded(expanded) {
    ui.collapsed = !expanded;
    manualCopy = "";
    chrome.storage.local.set({ [UI_KEY]: ui }).catch(() => {});
    render();
  }

  function renderBall() {
    const m = buildModel();
    const dot = statusDotClass(m);
    const title = quoteFailed
      ? "行情失败"
      : m.signals.length
      ? `${m.signals.map((s) => CLASS_LABEL[s.cls]).join("/")} 出带`
      : "四类在带内";
    card.innerHTML = `<div class="ball-wrap">
      <div class="ball">
        <span class="ball-main" role="button" tabindex="0"
              title="${escHtml(title)} · 点击：作为 .txt 附件发到输入框（没成功会自动展开卡片）· 拖动可移动">
          <span class="dot ${dot}"></span><span>持仓</span>
        </span>
        <button class="ball-seg" data-act="copy" title="复制快照到剪贴板">⧉</button>
        <button class="ball-seg" data-act="expand" title="展开查看持仓明细">⌄</button>
      </div>
      ${mountToast ? `<div class="ball-toast">${escHtml(mountToast)}</div>` : ""}
    </div>`;
    bindActions();
    const main = card.querySelector(".ball-main");
    bindDrag(main, () => doBallAttach());
    main.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        doBallAttach();
      }
    });
  }

  function renderCard() {
    if (!config.holdings.length) {
      card.innerHTML = `
        <div class="head"><span class="title">持仓</span><span class="stamp">未配置</span>
          <button data-act="collapse" title="收起">⌄</button>
          <button data-act="options" title="打开设置">⚙</button></div>
        <div class="body"><div class="warn">还没有持仓。打开设置填写代码/份额/成本后，这里会显示现价、浮盈与四类占比。</div></div>`;
      bindActions();
      return;
    }

    const m = buildModel();
    const p = m.primary;
    const dot = statusDotClass(m);
    const stamp = loading ? "读取中…" : quoteFailed ? "行情失败" : m.quoteTime || "—";
    const warnHtml = [];
    if (quoteFailed) {
      warnHtml.push(`<div class="warn bad">取价失败，以下按成本估值：${escHtml(quoteErrors.map((e) => e.message).join("；"))}</div>`);
    } else if (m.missing.length) {
      warnHtml.push(`<div class="warn">${m.missing.map((r) => escHtml(r.code)).join("、")} 现价缺失，该行按成本计入</div>`);
    }
    if (m.doubtful.length) {
      warnHtml.push(
        `<div class="warn">两源价差>0.5%：${m.doubtful
          .map((r) => `${escHtml(r.code)} ${fmtNum(r.price, 3)}/${fmtNum(r.altPrice, 3)}`)
          .join("、")}</div>`
      );
    }
    const sigHtml = m.signals.length
      ? `<div class="sig">${m.signals
          .map(
            (s) =>
              `${CLASS_LABEL[s.cls]} ${s.pct.toFixed(1)}% ${s.low ? "&lt;" : "&gt;"} ${
                s.low ? config.bandLowPct : config.bandHighPct
              }% · 距目标 ${fmtSigned(Math.abs(s.delta))}`
          )
          .join("<br>")}</div>`
      : `<div class="sig ok">四类均在 ${config.bandLowPct}%~${config.bandHighPct}% 带内</div>`;
    const qtyNote = m.quantityAsOf ? `份额录入 ${m.quantityAsOf}，未与券商核对` : "份额为手工录入，未与券商核对";

    card.innerHTML = `
      <div class="head">
        <span class="dot ${dot}"></span>
        <span class="title">持仓</span>
        <span class="stamp">${escHtml(stamp)}</span>
        <button data-act="refresh" title="刷新行情">↻</button>
        <button data-act="collapse" title="收起为悬浮球">⌄</button>
        <button data-act="options" title="打开设置">⚙</button>
      </div>
      <div class="body">
        ${warnHtml.join("")}
        ${m.rows
          .map((r) => {
            const plCls = r.pl > 0 ? "up" : r.pl < 0 ? "down" : "";
            const priceTxt = r.priceOk ? fmtNum(r.price, 3) : "价缺";
            return `<div class="row${r.priceOk ? "" : " stale"}">
              <div class="row-top">
                <span class="nm">${escHtml(r.name || r.code)}</span>
                <span class="code">${escHtml(r.code)}</span>
                <span class="pl ${plCls}">${fmtSigned(r.pl)}</span>
              </div>
              <div class="row-sub"><span>${fmtNum(r.shares, 0)}份 · ${fmtNum(r.cost, 3)}→${priceTxt} · 市值 ${fmtNum(
              r.mv
            )}</span><span>${r.plPct == null ? "" : fmtPct(r.plPct)}</span></div>
            </div>`;
          })
          .join("")}
        <div class="totals"><span class="lbl">合计</span><span>${fmtNum(m.acctTotal)}</span>
          <span class="val ${m.pl > 0 ? "up" : m.pl < 0 ? "down" : ""}">${fmtSigned(m.pl)}${
      m.costTotal > 0 ? ` (${fmtPct((m.pl / m.costTotal) * 100)})` : ""
    }</span></div>
        <div class="pcts">${CLASS_KEYS.map(
          (k) => `<span class="pct">${CLASS_LABEL[k]} <b>${p.pct[k].toFixed(1)}%</b></span>`
        ).join("")}<span class="pct">口径：证券+可投资</span></div>
        ${sigHtml}
        <div class="actions">
          <button class="primary" data-act="copy" title="复制 Markdown 快照到剪贴板">复制</button>
          <button data-act="fill" title="模拟真实粘贴：内容长时会按 DeepSeek 的规则自动转成 .txt 附件">填入</button>
          <button data-act="attach" title="直接作为 .txt 附件上传（走 DeepSeek 的文件通道）">转附件</button>
        </div>
        ${manualCopy ? '<textarea class="manual" readonly spellcheck="false"></textarea>' : ""}
        ${mountToast ? `<div class="toast${/失败|没找到/.test(mountToast) ? " bad" : ""}">${escHtml(mountToast)}</div>` : ""}
        <div class="foot">${escHtml(qtyNote)}</div>
      </div>`;
    const head = card.querySelector(".head");
    bindActions();
    bindDrag(head, null);
    const manual = card.querySelector(".manual");
    if (manual) {
      manual.value = manualCopy;
      manual.focus();
      manual.select();
    }
  }

  function renderChip() {
    const id = currentSessionId() || "";
    const configured = config.sessionIds.length > 0;
    const label = configured
      ? `本会话未匹配 · ${escHtml(id.slice(0, 8))}… · 点此改设置`
      : "持仓浮层未配置 · 点此设置 ⚙";
    const tip = configured
      ? `已配置 ${config.sessionIds.length} 个会话 id，均与当前 URL 中的 ${id} 不一致`
      : "打开设置，填写 DeepSeek 会话 id（可直接粘整条 URL）";
    card.innerHTML = `<div class="chip"><button data-act="options" title="${escHtml(tip)}">${label}</button></div>`;
    bindActions();
  }

  function render() {
    if (!card || !host) return;
    applyTheme();
    if (setupChip) renderChip();
    else if (ui.collapsed) renderBall();
    else renderCard();
  }

  function bindActions() {
    if (!card) return;
    for (const btn of card.querySelectorAll("button[data-act]")) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === "expand") setExpanded(true);
        else if (act === "collapse") setExpanded(false);
        else if (act === "refresh") {
          manualCopy = "";
          refreshQuotes(true);
        } else if (act === "options") chrome.runtime.sendMessage({ type: "open-options" }).catch(() => {});
        else if (act === "copy") doCopy();
        else if (act === "fill") doFill();
        else if (act === "attach") doAttach();
      });
    }
  }

  function flashToast(text, keep) {
    mountToast = text;
    render();
    if (keep || manualCopy) return; // 有手动复制框时不要自动清掉提示
    setTimeout(() => {
      mountToast = "";
      render();
    }, 3500);
  }

  async function doCopy() {
    const text = buildSnapshot();
    if (await copyText(text)) {
      manualCopy = "";
      flashToast("已复制到剪贴板");
      return;
    }
    // 剪贴板不可用：展开卡片并把文本摊出来，让用户手动复制
    manualCopy = text;
    ui.collapsed = false;
    chrome.storage.local.set({ [UI_KEY]: ui }).catch(() => {});
    flashToast("复制失败，请手动复制下面的文本", true);
  }

  /** 送不进输入框时的统一兜底：复制到剪贴板；连剪贴板都不行就把文本摊出来。 */
  async function fallbackToClipboard(reason) {
    const text = buildSnapshot();
    if (await copyText(text)) {
      flashToast(`${reason}，已复制 → 请手动粘贴`);
      return;
    }
    manualCopy = text;
    ui.collapsed = false;
    chrome.storage.local.set({ [UI_KEY]: ui }).catch(() => {});
    flashToast(`${reason}，请手动复制下面的文本`);
  }

  const DELIVER_TOAST = {
    file: "已按 DeepSeek 规则转为 .txt 附件",
    "file-pending": "已提交附件上传，稍等看输入框上方",
    inline: "已填入输入框，确认后发送",
  };

  /** 「填入」：模拟真实粘贴 —— 内容长时会被 DeepSeek 自己转成 .txt 附件。 */
  async function doFill() {
    const res = await deliverToComposer(buildSnapshot(), { forceAttachment: false });
    if (DELIVER_TOAST[res]) flashToast(DELIVER_TOAST[res]);
    else if (res === "failed") await fallbackToClipboard("填入失败");
    else await fallbackToClipboard("没找到输入框");
  }

  /** 「转附件」：先走粘贴规则，它没接管就用 file input 兜底走文件通道。 */
  async function doAttach() {
    const res = await deliverToComposer(buildSnapshot(), { forceAttachment: true });
    if (res === "file") flashToast("已作为 .txt 附件上传");
    else if (res === "file-pending") flashToast("已提交附件上传，稍等看输入框上方");
    else if (res === "inline") flashToast("附件通道不可用，已改为填入输入框");
    else if (res === "failed") await fallbackToClipboard("附件与填入都失败");
    else await fallbackToClipboard("没找到输入框");
  }

  /**
   * 球的单击动作：直接当附件发。成功就继续待在球里；
   * 没进附件通道就展开卡片，让用户换「复制 / 填入」。
   */
  async function doBallAttach() {
    const res = await deliverToComposer(buildSnapshot(), { forceAttachment: true });
    if (res === "file") {
      flashToast("已作为 .txt 附件上传");
      return;
    }
    if (res === "file-pending") {
      flashToast("已提交附件上传，稍等看输入框上方");
      return;
    }
    ui.collapsed = false;
    chrome.storage.local.set({ [UI_KEY]: ui }).catch(() => {});
    if (res === "inline") flashToast("附件通道不可用，已填入输入框；也可用「复制」", true);
    else if (res === "failed") await fallbackToClipboard("附件与填入都失败");
    else await fallbackToClipboard("没找到输入框");
  }

  /* ── 挂载调度（SPA 导航 / 配置变更 / 主题变化） ───────── */

  function sync() {
    const id = currentSessionId();
    const matched = id !== null && config.sessionIds.indexOf(id) >= 0;
    const configured = config.sessionIds.length > 0;
    const setup = id !== null && !matched && (!configured || config.showUnmatchedChip !== false);

    if (!matched && !setup) {
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
      unmount();
      return;
    }

    setupChip = setup;
    ensureMounted();
    render();
    if (matched && !refreshTimer) {
      refreshTimer = setInterval(() => {
        if (shouldMount() && document.visibilityState === "visible") refreshQuotes(false);
      }, REFRESH_MS);
    }
  }

  let lastHref = location.href;

  async function init() {
    const obj = await chrome.storage.local.get([CONFIG_KEY, UI_KEY]);
    config = normalizeConfig(obj[CONFIG_KEY]);
    if (obj[UI_KEY] && typeof obj[UI_KEY] === "object") ui = Object.assign(ui, obj[UI_KEY]);
    if (typeof ui.collapsed !== "boolean") ui.collapsed = true; // 默认收成悬浮球

    pageTheme = detectPageTheme();
    sync();
    if (host) refreshQuotes(false);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[CONFIG_KEY]) return;
      config = normalizeConfig(changes[CONFIG_KEY].newValue);
      sync();
      if (host) refreshQuotes(false);
    });

    setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      sync();
      if (host) refreshQuotes(false);
    }, NAV_POLL_MS);

    // DeepSeek 切浅色/深色时跟着换皮
    themeTimer = setInterval(() => {
      if (host) applyTheme();
    }, THEME_POLL_MS);

    window.addEventListener("popstate", sync);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && host) refreshQuotes(false);
    });
  }

  // 调试钩子：content script 运行在隔离世界，页面脚本看不到这个对象；
  // 用途是让浮层的算术/判定能用外部脚本或控制台验证。
  window.__edgePanelFinance = {
    buildModel,
    buildSnapshot,
    normalizeQuoteCode,
    extractSessionId,
    findComposer,
    insertTextInto,
    fillComposer,
    deliverToComposer,
    derivedFileName,
    dispatchPaste,
    attachmentVisible,
    detectPageTheme,
    setExpanded,
    sync,
    matchSession(pathname) {
      const m = String(pathname || "").match(SESSION_IN_PATH);
      const id = m ? decodeURIComponent(m[1]) : null;
      const matched = id !== null && config.sessionIds.indexOf(id) >= 0;
      const configured = config.sessionIds.length > 0;
      return {
        id,
        matched,
        setupChip: id !== null && !matched && (!configured || config.showUnmatchedChip !== false),
      };
    },
    setTestState(cfg, q) {
      config = normalizeConfig(cfg);
      quotes = q || null;
      quoteFailed = false;
      quoteErrors = [];
    },
  };

  init().catch((err) => console.error("[finance-overlay] init failed:", err));
})();
