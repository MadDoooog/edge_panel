const DEFAULTS = {
  cursorTeamId: "",
  cursorUserId: "",
  cursorUserEmail: "",
  logshedUrl: "http://logshed-search-eu.prod.mypna.com/",
  releaseMatrixVersion: "26q3",
  sshConfig: { ssh_defaults: { username: "", password: "", key_file: "" }, du_paths: [], targets: [] },
};

function showStatus(text, ok = true) {
  const status = document.getElementById("save-status");
  status.textContent = text;
  status.style.color = ok ? "#3dd68c" : "#f85149";
  setTimeout(() => (status.textContent = ""), 2500);
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  document.getElementById("cursor-team-id").value = stored.cursorTeamId;
  document.getElementById("cursor-user-id").value = stored.cursorUserId;
  document.getElementById("cursor-user-email").value = stored.cursorUserEmail;
  document.getElementById("logshed-url").value = stored.logshedUrl;
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
  row.className = "target-row";
  const fields = [
    ["name", "名称", "text"],
    ["host", "主机 host", "text"],
    ["port", "端口", "number"],
    ["username", "用户名（留空用默认）", "text"],
    ["password", "密码（留空用默认）", "password"],
    ["key_file", "密钥文件（可选）", "text"],
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
  del.textContent = "✕ 删除";
  del.addEventListener("click", () => row.remove());
  row.appendChild(del);
  return row;
}

function collectSshConfig() {
  const targets = [];
  for (const row of document.querySelectorAll("#ssh-targets .target-row")) {
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

/* ── 保存 / 导入 / 下载模板 ───────────────────────────── */

document.getElementById("save-btn").addEventListener("click", async () => {
  await chrome.storage.sync.set({
    cursorTeamId: document.getElementById("cursor-team-id").value.trim(),
    cursorUserId: document.getElementById("cursor-user-id").value.trim(),
    cursorUserEmail: document.getElementById("cursor-user-email").value.trim(),
    logshedUrl: document.getElementById("logshed-url").value.trim() || DEFAULTS.logshedUrl,
    releaseMatrixVersion: document.getElementById("release-matrix-version").value.trim() || DEFAULTS.releaseMatrixVersion,
    sshConfig: collectSshConfig(),
  });
  showStatus("✓ 已保存");
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
