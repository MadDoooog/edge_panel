/* ============================================================
   metrics.js — 服务器磁盘采集的页面侧辅助
   实际采集由 background.js 持有（service worker 经 connectNative
   拉起 Go 宿主），宿主流式上报进度，进度持久化在 chrome.storage.local
   （metricsProgress）并经 runtime 消息广播到页面 —— 因此即使新标签页
   已关闭，采集仍在后台继续，重新打开时能看到「正在采集到 xx」。
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

/** 读取最近一次采集缓存（页面打开时先展示，后台再刷新）。 */
async function loadMetricsCache() {
  const obj = await chrome.storage.local.get(METRICS_CACHE_KEY);
  return obj[METRICS_CACHE_KEY] || null;
}

async function saveMetricsCache(data) {
  await chrome.storage.local.set({ [METRICS_CACHE_KEY]: data });
}

/** 读取/写入后台采集的实时进度（页面关掉再打开也能看到「正在采集到 xx」）。 */
async function loadMetricsProgress() {
  const obj = await chrome.storage.local.get(METRICS_PROGRESS_KEY);
  return obj[METRICS_PROGRESS_KEY] || null;
}

async function saveMetricsProgress(p) {
  await chrome.storage.local.set({ [METRICS_PROGRESS_KEY]: p });
}

/**
 * 把插件自带的宿主与安装脚本下载到下载目录（edge-panel-host/ 子目录），由用户双击 .bat 注册。
 * - conflictAction: "overwrite"：重复点只覆盖同名文件，不再堆出 "(1)" "(2)" 副本
 *   （带后缀的 exe 会让安装脚本找不到 edge-panel-host.exe）
 * - 连点合并成一次下载（in-flight promise），免得一次弹好几个提示
 */
let hostDownloadInFlight = null;

function installNativeHost() {
  if (hostDownloadInFlight) return hostDownloadInFlight;

  hostDownloadInFlight = Promise.all(
    NATIVE_HOST_FILES.map(
      (name) =>
        new Promise((resolve, reject) => {
          chrome.downloads.download(
            {
              url: chrome.runtime.getURL(`native/${name}`),
              filename: `${NATIVE_HOST_DOWNLOAD_DIR}/${name}`,
              conflictAction: "overwrite",
            },
            (id) => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(id);
            }
          );
        })
    )
  ).finally(() => {
    hostDownloadInFlight = null;
  });

  return hostDownloadInFlight;
}

/** 下载完之后的固定提示：文件在插件目录的 native/ 里本来就有，双击 .bat 即可。 */
const NATIVE_HOST_INSTALL_HINT =
  "双击 下载/edge-panel-host/install-edge-panel-host.bat（SmartScreen 点「更多信息 → 仍要运行」），再回来点重试；" +
  "插件目录的 native/ 里也有同样三个文件，可以直接用那里的 .bat，不必下载";
