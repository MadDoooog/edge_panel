/* ============================================================
   metrics.js — 服务器磁盘采集（Native Messaging → Go 宿主）
   侧边栏页面直接 chrome.runtime.connectNative 拉起 Go 宿主，
   SSH 采集 type:ssh 目标的磁盘，收到响应即断开（按需使用）。
   ============================================================ */
const METRICS_CACHE_KEY = "metrics";
const NATIVE_HOST_NAME = "com.edge_panel.host";

// 留空则使用 Go 宿主编译时默认的 config.yaml 路径（WSL UNC）。
// 如需指定，可填 Windows 可见的 config.yaml 路径。
const METRICS_CONFIG_PATH = "";

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
  const data = await connectNativeHost({ type: "collect", config_path: METRICS_CONFIG_PATH });
  if (data && data.error) throw new Error(data.error);
  return data;
}

/** 读取最近一次采集缓存（面板打开时先展示，后台再刷新）。 */
async function loadMetricsCache() {
  const obj = await chrome.storage.local.get(METRICS_CACHE_KEY);
  return obj[METRICS_CACHE_KEY] || null;
}

async function saveMetricsCache(data) {
  await chrome.storage.local.set({ [METRICS_CACHE_KEY]: data });
}
