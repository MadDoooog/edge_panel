const DEFAULTS = {
  cursorTeamId: "",
  cursorUserId: "",
  cursorUserEmail: "",
  releaseMatrixVersion: "26q3",
  sshConfig: { ssh_defaults: { username: "", password: "", key_file: "" }, du_paths: [], targets: [] },
};

function showStatus(text, ok = true, keep = false) {
  const status = document.getElementById("save-status");
  status.textContent = text;
  status.className = ok ? "status" : "status error";
  if (!keep) setTimeout(() => (status.textContent = ""), 4000);
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  document.getElementById("cursor-team-id").value = stored.cursorTeamId;
  document.getElementById("cursor-user-id").value = stored.cursorUserId;
  document.getElementById("cursor-user-email").value = stored.cursorUserEmail;
  document.getElementById("release-matrix-version").value = stored.releaseMatrixVersion;

  const cfg = stored.sshConfig || {};
  const sd = cfg.ssh_defaults || {};
  document.getElementById("ssh-username").value = sd.username || "";
  document.getElementById("ssh-password").value = sd.password || "";
  document.getElementById("ssh-key-file").value = sd.key_file || "";
  document.getElementById("ssh-du-paths").value = (cfg.du_paths || []).join("\n");
  renderTargets(cfg.targets || []);
}

/* ── SSH 服务器行 ─────────────────────────────────────── */

function renderTargets(targets) {
  const container = document.getElementById("ssh-targets");
  container.innerHTML = "";
  for (const t of targets) container.appendChild(targetRow(t));
}

function targetRow(t) {
  const row = document.createElement("div");
  row.className = "s-row";
  const fields = [
    ["name", "名称", "text"],
    ["host", "主机", "text"],
    ["port", "22", "number"],
    ["username", "留空用默认", "text"],
    ["password", "留空用默认", "password"],
    ["key_file", "可选", "text"],
  ];
  for (const [field, ph, type] of fields) {
    const input = document.createElement("input");
    input.type = type;
    input.placeholder = ph;
    input.spellcheck = false;
    input.dataset.field = field;
    input.value = field === "port" ? (t.port || 22) : (t[field] != null ? t[field] : "");
    row.appendChild(input);
  }
  const del = document.createElement("button");
  del.type = "button";
  del.className = "del-btn";
  del.textContent = "✕";
  del.title = "删除";
  del.addEventListener("click", () => row.remove());
  row.appendChild(del);
  return row;
}

function collectSshConfig() {
  const targets = [];
  for (const row of document.querySelectorAll("#ssh-targets .s-row")) {
    const t = { type: "ssh" };
    for (const input of row.querySelectorAll("input[data-field]")) {
      t[input.dataset.field] = input.dataset.field === "port" ? (Number(input.value) || 22) : input.value.trim();
    }
    targets.push(t);
  }
  const duPaths = document.getElementById("ssh-du-paths").value
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return {
    ssh_defaults: {
      username: document.getElementById("ssh-username").value.trim(),
      password: document.getElementById("ssh-password").value.trim(),
      key_file: document.getElementById("ssh-key-file").value.trim(),
    },
    du_paths: duPaths,
    targets,
  };
}

/* ── 保存（一次性写入 sync + local）/ 导入 / 下载模板 ─── */

document.getElementById("save-btn").addEventListener("click", async () => {
  const fin = collectFinance();
  if (fin.bandLowPct >= fin.bandHighPct) {
    showStatus(`下限 ${fin.bandLowPct} 必须小于上限 ${fin.bandHighPct}`, false, true);
    return;
  }
  try {
    await chrome.storage.sync.set({
      cursorTeamId: document.getElementById("cursor-team-id").value.trim(),
      cursorUserId: document.getElementById("cursor-user-id").value.trim(),
      cursorUserEmail: document.getElementById("cursor-user-email").value.trim(),
      releaseMatrixVersion: document.getElementById("release-matrix-version").value.trim() || DEFAULTS.releaseMatrixVersion,
      sshConfig: collectSshConfig(),
    });
    await chrome.storage.local.set({ [FIN_KEY]: fin });
  } catch (err) {
    // 典型情形：扩展刚被重载，本页的 chrome.* 已失效（Extension context invalidated）
    showStatus(`保存失败：${(err && err.message) || err} —— 请刷新本页重试`, false, true);
    return;
  }
  const back = await chrome.storage.local.get(FIN_KEY);
  renderStoredSummary(Object.assign({}, FIN_DEFAULTS, back[FIN_KEY] || {}));
  const bad = fin.holdings.filter((h) => !/^(?:sh|sz)\d{6}$/.test(h.code));
  if (bad.length) showStatus(`已保存；${bad.map((h) => h.code).join("、")} 不是 6 位沪深代码`, false);
  else if (!fin.sessionIds.length) showStatus("已保存；会话 id 为空 → 不显示浮层", false, true);
  else showStatus(`✓ 已保存（${fin.sessionIds.length} 个会话 / ${fin.holdings.length} 条持仓）`);
});

document.getElementById("ssh-add-target").addEventListener("click", () => {
  document.getElementById("ssh-targets").appendChild(
    targetRow({ name: "", host: "", port: 22, username: "", password: "", key_file: "" })
  );
});

document.getElementById("download-template-btn").addEventListener("click", () => {
  chrome.downloads.download(
    { url: chrome.runtime.getURL("config.example.yaml"), filename: "edge-panel-config.example.yaml" },
    () => {
      if (chrome.runtime.lastError) showStatus("下载失败: " + chrome.runtime.lastError.message, false);
      else showStatus("✓ 模板已下载，填写后在「导入配置」上传");
    }
  );
});

document.getElementById("import-config-btn").addEventListener("click", () => {
  document.getElementById("import-file").click();
});

document.getElementById("import-file").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      applySshConfig(parseConfigText(String(reader.result)));
      showStatus("✓ 已导入，请检查后点「保存」");
    } catch (err) {
      showStatus("导入失败: " + err.message, false);
    }
  };
  reader.readAsText(file);
});

// 导入文本解析：JSON 或 YAML（yaml.js 提供 parseYamlConfig）
function parseConfigText(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  return parseYamlConfig(text);
}

/* ── 持仓配置（chrome.storage.local：含金额，不跟浏览器账号上云） ── */

const FIN_KEY = "financeConfig";
const FIN_CLASSES = [
  ["stock", "股"],
  ["bond", "债"],
  ["gold", "金"],
  ["cash", "现金"],
];
const FIN_DEFAULTS = {
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

/** 归一化代码：允许 "510300" / "sh510300"，缺市场时按首位数字推断。 */
function normalizeQuoteCode(raw) {
  const m = String(raw || "").trim().toLowerCase().match(/^(?:(sh|sz))?(\d{6})$/);
  if (!m) return String(raw || "").trim();
  const prefix = m[1] || (/^[569]/.test(m[2]) ? "sh" : "sz");
  return prefix + m[2];
}

/** 会话 id 归一化：允许直接粘整条 URL（从中抽 /s/<id>），容忍裸 id 与中英文引号。 */
function normalizeSessionId(raw) {
  const s = String(raw || "")
    .trim()
    .replace(/^[\s"'`\u201c\u201d\u2018\u2019\u300c\u300d]+|[\s"'`\u201c\u201d\u2018\u2019\u300c\u300d]+$/g, "");
  const m = s.match(/\/s\/([^/?#\s]+)/);
  if (m) return m[1];
  return s.replace(/[/?#].*$/, "");
}

/**
 * 显示「存储里实际存了什么」。只读 chrome.storage.local、不读表单 ——
 * 保存失败时页面原本毫无反馈（看着填好了、实际是空的），这个摘要就是为了暴露它。
 */
function renderStoredSummary(cfg) {
  const el = document.getElementById("fin-stored");
  if (!el) return;
  const ids = cfg.sessionIds || [];
  const n = (cfg.holdings || []).length;
  const money = (v) => Number(v || 0).toLocaleString("zh-CN");
  if (!ids.length && !n) {
    el.textContent = "※ 本地还没有持仓配置 —— 填好后点最下方「保存」。";
    el.className = "note warn";
    return;
  }
  const idTxt = ids.length ? ids.map((s) => (s.length > 12 ? `${s.slice(0, 8)}…` : s)).join("、") : "（无）";
  el.textContent =
    `已存：会话 ${ids.length} 个（${idTxt}）· 持仓 ${n} 条 · 应急金 ${money(cfg.emergencyFund)} · ` +
    `可投资 ${money(cfg.investableCash)} · 目标 ${cfg.targetPct}% / 带 ${cfg.bandLowPct}~${cfg.bandHighPct}%`;
  el.className = "note ok";
}

/** 构造单行网格里的输入控件。 */
function fieldInput(field, type, placeholder, value, extra) {
  const input = document.createElement("input");
  input.type = type;
  input.placeholder = placeholder;
  input.dataset.field = field;
  if (type === "number") input.spellcheck = false;
  else input.spellcheck = false;
  if (value != null) input.value = value;
  Object.assign(input, extra || {});
  return input;
}

/** 持仓行：代码 / 名称 / 类别 / 份额 / 成本 / 对账日 / ✕（与 options.css 的网格列一致） */
function holdingRow(h) {
  const row = document.createElement("div");
  row.className = "h-row";

  row.appendChild(fieldInput("code", "text", "510300", h.code || ""));
  row.appendChild(fieldInput("name", "text", "可留空", h.name || ""));

  const cls = document.createElement("select");
  cls.dataset.field = "cls";
  for (const [value, label] of FIN_CLASSES) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    if ((h.cls || "stock") === value) opt.selected = true;
    cls.appendChild(opt);
  }
  row.appendChild(cls);

  row.appendChild(fieldInput("shares", "number", "0", h.shares != null ? h.shares : "", { step: "1", min: "0" }));
  row.appendChild(fieldInput("cost", "number", "0.000", h.cost != null ? h.cost : "", { step: "0.001", min: "0" }));
  row.appendChild(fieldInput("asof", "date", "", h.asof || "", { title: "份额/成本的对账日期" }));

  const del = document.createElement("button");
  del.type = "button";
  del.className = "del-btn";
  del.textContent = "✕";
  del.title = "删除";
  del.addEventListener("click", () => row.remove());
  row.appendChild(del);
  return row;
}

function renderHoldings(holdings) {
  const container = document.getElementById("fin-holdings");
  container.innerHTML = "";
  for (const h of holdings) container.appendChild(holdingRow(h));
}

function collectFinance() {
  const holdings = [];
  for (const row of document.querySelectorAll("#fin-holdings .h-row")) {
    const h = {};
    for (const input of row.querySelectorAll("[data-field]")) {
      const f = input.dataset.field;
      if (f === "shares" || f === "cost") h[f] = Number(input.value) || 0;
      else if (f === "code") h.code = input.value.trim() ? normalizeQuoteCode(input.value) : "";
      else h[f] = input.value.trim();
    }
    if (h.code) holdings.push(h);
  }
  const num = (id, fallback) => {
    const v = Number(document.getElementById(id).value);
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    sessionIds: document
      .getElementById("fin-session-ids")
      .value.split(/\r?\n/)
      .map(normalizeSessionId)
      .filter(Boolean),
    holdings,
    emergencyFund: num("fin-emergency", 0),
    investableCash: num("fin-investable", 0),
    targetPct: num("fin-target", FIN_DEFAULTS.targetPct),
    bandLowPct: num("fin-band-low", FIN_DEFAULTS.bandLowPct),
    bandHighPct: num("fin-band-high", FIN_DEFAULTS.bandHighPct),
    commissionRateBp: num("fin-fee-bp", FIN_DEFAULTS.commissionRateBp),
    commissionMin: num("fin-fee-min", FIN_DEFAULTS.commissionMin),
    showUnmatchedChip: document.getElementById("fin-unmatched-chip").checked,
  };
}

async function loadFinance() {
  const obj = await chrome.storage.local.get(FIN_KEY);
  const cfg = Object.assign({}, FIN_DEFAULTS, obj[FIN_KEY] || {});
  document.getElementById("fin-session-ids").value = (cfg.sessionIds || []).join("\n");
  document.getElementById("fin-emergency").value = cfg.emergencyFund;
  document.getElementById("fin-investable").value = cfg.investableCash;
  document.getElementById("fin-target").value = cfg.targetPct;
  document.getElementById("fin-band-low").value = cfg.bandLowPct;
  document.getElementById("fin-band-high").value = cfg.bandHighPct;
  document.getElementById("fin-fee-bp").value = cfg.commissionRateBp;
  document.getElementById("fin-fee-min").value = cfg.commissionMin;
  document.getElementById("fin-unmatched-chip").checked = cfg.showUnmatchedChip !== false;
  renderHoldings(cfg.holdings || []);
  renderStoredSummary(cfg);
}

document.getElementById("fin-add-holding").addEventListener("click", () => {
  document.getElementById("fin-holdings").appendChild(
    holdingRow({ name: "", code: "", cls: "stock", shares: "", cost: "", asof: "" })
  );
});

/* ── SSH 配置导入回填 ─────────────────────────────────── */

// 把解析结果归一化到表单结构并回填
function applySshConfig(parsed) {
  const cfg = parsed && typeof parsed === "object" ? parsed : {};
  const sd = cfg.ssh_defaults || {};
  document.getElementById("ssh-username").value = sd.username || "";
  document.getElementById("ssh-password").value = sd.password || "";
  document.getElementById("ssh-key-file").value = sd.key_file || "";
  document.getElementById("ssh-du-paths").value = (Array.isArray(cfg.du_paths) ? cfg.du_paths : []).join("\n");
  const targets = Array.isArray(cfg.targets)
    ? cfg.targets.filter((t) => t && typeof t === "object")
    : [];
  renderTargets(targets);
}

loadSettings();
loadFinance();
