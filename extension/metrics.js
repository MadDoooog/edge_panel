/* ============================================================
   metrics.js — 服务器磁盘采集的页面侧辅助
   实际采集由 background.js 持有（service worker 经 connectNative
   拉起 Go 宿主），宿主流式上报进度，进度持久化在 chrome.storage.local
   （metricsProgress）并经 runtime 消息广播到面板 —— 因此即使侧边栏
   关闭，采集仍在后台继续，重新打开面板时能看到「正在采集到 xx」。
   本文件只负责：采集缓存/进度读写、宿主安装引导、错误识别。
   ============================================================ */
const METRICS_CACHE_KEY = "metrics";
const METRICS_PROGRESS_KEY = "metricsProgress";

// 插件自带、随打包脚本放入 extension/native/ 的宿主与安装脚本
const NATIVE_HOST_DOWNLOAD_DIR = "edge-panel-host";
const NATIVE_HOST_FILES = ["edge-panel-host.exe", "install-edge-panel-host.ps1", "install-edge-panel-host.bat"];

/** 判断错误是否为 Native 宿主未注册（需要先下载并安装宿主）。 */
function isNativeHostMissing(err) {
  return /native messaging host|host not found/i.test(String(err && err.message ? err.message : err));
}

/** 读取最近一次采集缓存（面板打开时先展示，后台再刷新）。 */
async function loadMetricsCache() {
  const obj = await chrome.storage.local.get(METRICS_CACHE_KEY);
  return obj[METRICS_CACHE_KEY] || null;
}

async function saveMetricsCache(data) {
  await chrome.storage.local.set({ [METRICS_CACHE_KEY]: data });
}

/** 读取/写入后台采集的实时进度（面板关闭再打开也能看到「正在采集到 xx」）。 */
async function loadMetricsProgress() {
  const obj = await chrome.storage.local.get(METRICS_PROGRESS_KEY);
  return obj[METRICS_PROGRESS_KEY] || null;
}

async function saveMetricsProgress(p) {
  await chrome.storage.local.set({ [METRICS_PROGRESS_KEY]: p });
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
