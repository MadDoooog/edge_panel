/* ============================================================
   metrics.js — 服务器磁盘采集（Native Messaging → Go 宿主）
   侧边栏页面直接 chrome.runtime.connectNative 拉起 Go 宿主，
   SSH 采集 type:ssh 目标的磁盘，收到响应即断开（按需使用）。
   采集配置（sshConfig）由设置页存于 chrome.storage.sync，
   经 native 消息内联传给宿主（不再依赖磁盘 config.yaml）。
   ============================================================ */
const METRICS_CACHE_KEY = "metrics";
const NATIVE_HOST_NAME = "com.edge_panel.host";
const SSH_CONFIG_KEY = "sshConfig";

// 插件自带、随打包脚本放入 extension/native/ 的宿主与安装脚本
const NATIVE_HOST_DOWNLOAD_DIR = "edge-panel-host";
const NATIVE_HOST_FILES = ["edge-panel-host.exe", "install-edge-panel-host.ps1", "install-edge-panel-host.bat"];

/** 读取设置页保存的 SSH 采集配置。 */
async function loadSshConfig() {
  const obj = await chrome.storage.sync.get({ [SSH_CONFIG_KEY]: null });
  return obj[SSH_CONFIG_KEY] || null;
}

/** 判断错误是否为 Native 宿主未注册（需要先下载并安装宿主）。 */
function isNativeHostMissing(err) {
  return /native messaging host|host not found/i.test(String(err && err.message ? err.message : err));
}

/**
 * 连接宿主并发送一条消息，收到首个响应后断开。
 * 宿主未注册时 onDisconnect 会带 lastError（"Specified native messaging host not found"）。
 */
function connectNativeHost(msg) {
  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch (e) {
    return Promise.reject(new Error(`native host connect: ${e.message}`));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    port.onMessage.addListener((resp) => {
      if (settled) return;
      settled = true;
      port.disconnect();
      resolve(resp);
    });
    port.onDisconnect.addListener(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `native host: ${(chrome.runtime.lastError && chrome.runtime.lastError.message) || "disconnected"}`
        )
      );
    });
    port.postMessage(msg);
  });
}

/** 请求 Go 宿主采集 SSH 目标磁盘。返回 { last_updated, servers[] }。 */
async function collectMetrics() {
  const config = await loadSshConfig();
  const targets = (config && Array.isArray(config.targets) ? config.targets : []).filter((t) => t && t.host);
  if (targets.length === 0) {
    throw new Error("未配置 SSH 服务器");
  }
  const data = await connectNativeHost({ type: "collect", config });
  if (data && data.error) throw new Error(data.error);
  return data;
}

/** 把插件自带的宿主与安装脚本下载到下载目录（edge-panel-host/ 子目录），由用户双击 .bat 注册。 */
function installNativeHost() {
  return Promise.all(
    NATIVE_HOST_FILES.map(
      (name) =>
        new Promise((resolve, reject) => {
          chrome.downloads.download(
            {
              url: chrome.runtime.getURL(`native/${name}`),
              filename: `${NATIVE_HOST_DOWNLOAD_DIR}/${name}`,
              conflictAction: "uniquify",
            },
            (id) => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(id);
            }
          );
        })
    )
  );
}

/** 读取最近一次采集缓存（面板打开时先展示，后台再刷新）。 */
async function loadMetricsCache() {
  const obj = await chrome.storage.local.get(METRICS_CACHE_KEY);
  return obj[METRICS_CACHE_KEY] || null;
}

async function saveMetricsCache(data) {
  await chrome.storage.local.set({ [METRICS_CACHE_KEY]: data });
}
