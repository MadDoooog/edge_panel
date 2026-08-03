/* ============================================================
   cookies.js — 自动读取浏览器登录态（chrome.cookies）
   用 host_permissions 直连源站时，从浏览器读取该域名的 Cookie。
   ============================================================ */

/**
 * 读取指定域名的全部 Cookie 并拼成 `Cookie` 请求头。
 * @param {string} domainUrl 例如 "https://cursor.com" / "https://www.zhihu.com"
 */
async function getCookieHeader(domainUrl) {
  try {
    const cookies = await chrome.cookies.getAll({ url: domainUrl });
    if (!cookies || !cookies.length) return "";
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch (err) {
    console.error("[cookies] getAll failed:", err);
    return "";
  }
}
