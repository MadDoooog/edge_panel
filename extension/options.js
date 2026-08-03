const DEFAULTS = {
  cursorTeamId: "",
  cursorUserId: "",
  cursorUserEmail: "",
  logshedUrl: "http://logshed-search-eu.prod.mypna.com/",
};

async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  document.getElementById("cursor-team-id").value = stored.cursorTeamId;
  document.getElementById("cursor-user-id").value = stored.cursorUserId;
  document.getElementById("cursor-user-email").value = stored.cursorUserEmail;
  document.getElementById("logshed-url").value = stored.logshedUrl;
}

document.getElementById("save-btn").addEventListener("click", async () => {
  await chrome.storage.sync.set({
    cursorTeamId: document.getElementById("cursor-team-id").value.trim(),
    cursorUserId: document.getElementById("cursor-user-id").value.trim(),
    cursorUserEmail: document.getElementById("cursor-user-email").value.trim(),
    logshedUrl: document.getElementById("logshed-url").value.trim() || DEFAULTS.logshedUrl,
  });
  const status = document.getElementById("save-status");
  status.textContent = "✓ 已保存";
  setTimeout(() => (status.textContent = ""), 1500);
});

loadSettings();
