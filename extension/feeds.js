/* ============================================================
   feeds.js — 知乎阅读流（直连 zhihu.com）
   直连 zhihu.com（host_permissions 免 CORS；Cookie/Referer 由 background 的
   DNR 动态规则注入，见 background.js updateAuthRules，故 fetch 用 credentials:"omit"）
   归一化、去重缓存、收藏、评论全部在扩展内完成，存 chrome.storage.local。
   item_id 格式：zhihu:<native_type>:<native_id>
   ============================================================ */

/* ── 归一化 ────────────────────────────────────────────── */
function htmlToText(html) {
  if (!html) return "";
  return String(html)
    .replace(/\r\n?/g, "\n")
    .replace(/<(br\s*\/?|p|div|li|h[1-6]|blockquote|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean)
    .join("\n");
}

function makeItemId(platform, nativeType, nativeId) {
  return `${platform}:${nativeType}:${nativeId}`;
}

function parseItemId(itemId) {
  const parts = String(itemId).split(":");
  if (parts.length !== 3) throw new Error(`invalid item_id: ${itemId}`);
  return { platform: parts[0], nativeType: parts[1], nativeId: parts[2] };
}

function isVideoItem(raw) {
  if (raw.has_video) return true;
  if (raw.native_type === "zvideo" || raw.native_type === "video") return true;
  const att = (raw.extra && raw.extra.attachment) || {};
  if (att.type === "video") return true;
  return false;
}

function normalizeItem(raw) {
  if (!raw || isVideoItem(raw)) return null;
  let text = String(raw.text || "");
  if (text.includes("<")) text = htmlToText(text);
  const excerpt = raw.extra && raw.extra.excerpt ? htmlToText(raw.extra.excerpt) : "";
  if (!text.trim() && excerpt.trim()) text = excerpt;
  return {
    id: makeItemId(raw.platform, raw.native_type, raw.native_id),
    platform: raw.platform,
    native_type: raw.native_type,
    native_id: raw.native_id,
    title: String(raw.title || "").trim(),
    text: text.trim(),
    author: String(raw.author || "").trim(),
    url: raw.url || "",
    published_at: raw.published_at || "",
    comment_count: Number(raw.comment_count || 0),
  };
}

function normalizeComment(c) {
  const text = String(c.text || "");
  const result = {
    id: String(c.id || ""),
    author: String(c.author || ""),
    text: text.includes("<") ? htmlToText(text) : text,
    published_at: c.published_at || "",
    like_count: Number(c.like_count || 0),
    avatar_url: c.avatar_url || "",
    child_count: Number(c.child_count || 0),
    reply_to_author: c.reply_to_author || "",
  };
  if (Array.isArray(c.children) && c.children.length) {
    result.children = c.children.map(normalizeComment);
  }
  return result;
}

/* ── 知乎适配（移植 adapters/zhihu.py） ─────────────────── */
const ZHIHU_HEADERS = {
  accept: "application/json",
  "x-requested-with": "fetch",
};
const ZHIHU_FEED_URL = "https://www.zhihu.com/api/v3/feed/topstory/recommend";
const ZHIHU_COMMENTS_BASE = { answer: "answers", article: "articles", pin: "pins" };
const ZHIHU_DETAIL_ENDPOINTS = {
  answer: (id) => `https://www.zhihu.com/api/v4/answers/${id}`,
  article: (id) => `https://www.zhihu.com/api/v4/articles/${id}`,
  pin: (id) => `https://www.zhihu.com/api/v4/pins/${id}`,
};
const EMBEDDED_CHILD_CACHE = {}; // commentId -> normalized children

function pad2(n) {
  return String(n).padStart(2, "0");
}

function tsToIso(ts) {
  if (!ts) return "";
  const d = new Date(Number(ts) * 1000);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(
    d.getHours()
  )}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function authorName(author) {
  if (!author || typeof author !== "object") return "";
  const member = author.member;
  if (member && typeof member === "object") return String(member.name || "");
  return String(author.name || author.fullname || "");
}

function authorAvatar(author) {
  if (!author || typeof author !== "object") return "";
  const member = author.member;
  if (member && typeof member === "object") return String(member.avatar_url || "");
  return String(author.avatar_url || "");
}

function hasVideo(target) {
  if (target.type === "zvideo") return true;
  if (target.video) return true;
  const att = target.attachment || {};
  if (att.type === "video") return true;
  return false;
}

function webUrl(nativeType, target) {
  const nativeId = String(target.id || "");
  if (nativeType === "answer") {
    const qid = (target.question || {}).id || "";
    return `https://www.zhihu.com/question/${qid}/answer/${nativeId}`;
  }
  if (nativeType === "article") return `https://zhuanlan.zhihu.com/p/${nativeId}`;
  if (nativeType === "pin") return `https://www.zhihu.com/pin/${nativeId}`;
  return `https://www.zhihu.com/${nativeType}/${nativeId}`;
}

function titleForTarget(nativeType, target) {
  if (nativeType === "answer") return String((target.question || {}).title || "");
  return String(target.title || target.excerpt_title || "");
}

function rawFromTarget(target) {
  if (!target || typeof target !== "object") return null;
  const nativeType = String(target.type || "");
  if (!nativeType || nativeType === "zvideo") return null;
  const nativeId = String(target.id || "");
  if (!nativeId) return null;
  const content = target.content || target.excerpt || target.content_text || "";
  return {
    platform: "zhihu",
    native_type: nativeType,
    native_id: nativeId,
    title: titleForTarget(nativeType, target),
    text: String(content),
    author: authorName(target.author),
    url: webUrl(nativeType, target),
    published_at: tsToIso(target.created_time || target.updated_time),
    comment_count: Number(target.comment_count || 0),
    has_video: hasVideo(target),
    extra: { excerpt: target.excerpt || "", attachment: target.attachment || {} },
  };
}

function commentFromRow(row, includeChildren = true) {
  if (!row || typeof row !== "object") return null;
  const replyTo = row.reply_to_author;
  const replyName = replyTo && typeof replyTo === "object" ? authorName(replyTo) : "";
  let embedded = [];
  if (includeChildren && Array.isArray(row.child_comments)) {
    embedded = row.child_comments.map((c) => commentFromRow(c, false)).filter(Boolean);
  }
  return {
    id: String(row.id || ""),
    author: authorName(row.author),
    text: String(row.content || row.excerpt || ""),
    published_at: tsToIso(row.created_time),
    like_count: Number(row.vote_count || 0),
    avatar_url: authorAvatar(row.author),
    child_count: Number(row.child_comment_count || embedded.length || 0),
    reply_to_author: replyName,
    children: embedded,
  };
}

async function zhihuFetchFeed(limit, offset) {
  const items = [];
  let apiOffset = offset;
  const pageSize = Math.min(20, limit);
  while (items.length < limit) {
    const params = new URLSearchParams({
      session_token: "",
      limit: String(pageSize),
      offset: String(apiOffset),
      desktop: "true",
    });
    const resp = await fetch(`${ZHIHU_FEED_URL}?${params}`, {
      credentials: "omit",
      headers: ZHIHU_HEADERS,
    });
    if (!resp.ok) throw new Error(`zhihu feed HTTP ${resp.status}`);
    const payload = await resp.json();
    const batch = Array.isArray(payload.data) ? payload.data : [];
    if (!batch.length) break;
    for (const entry of batch) {
      const raw = rawFromTarget(entry.target);
      if (raw) {
        items.push(raw);
        if (items.length >= limit) break;
      }
    }
    if (payload.paging && payload.paging.is_end === true) break;
    if (batch.length) apiOffset += batch.length;
    else break;
  }
  return items.slice(0, limit);
}

async function zhihuFetchItemDetail(nativeType, nativeId) {
  const make = ZHIHU_DETAIL_ENDPOINTS[nativeType];
  if (!make) throw new Error(`unsupported zhihu content type: ${nativeType}`);
  const resp = await fetch(make(nativeId), { credentials: "omit", headers: ZHIHU_HEADERS });
  if (!resp.ok) throw new Error(`zhihu detail HTTP ${resp.status}`);
  const target = await resp.json();
  const raw = rawFromTarget(target);
  if (!raw) throw new Error(`zhihu item ${nativeType}:${nativeId} is not readable text content`);
  return normalizeItem(raw);
}

async function zhihuFetchComments(nativeType, nativeId, offset, limit) {
  const base = ZHIHU_COMMENTS_BASE[nativeType];
  if (!base) return [];
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    order: "default",
  });
  const url = `https://www.zhihu.com/api/v4/${base}/${nativeId}/root_comments?${params}`;
  const resp = await fetch(url, { credentials: "omit", headers: ZHIHU_HEADERS });
  if (!resp.ok) throw new Error(`zhihu comments HTTP ${resp.status}`);
  const payload = await resp.json();
  const comments = [];
  for (const row of payload.data || []) {
    const c = commentFromRow(row);
    if (!c) continue;
    if (c.children && c.children.length) EMBEDDED_CHILD_CACHE[c.id] = c.children;
    comments.push(c);
  }
  return comments;
}

async function zhihuFetchChildComments(commentId, offset, limit) {
  const cached = EMBEDDED_CHILD_CACHE[commentId];
  if (cached && offset < cached.length) return cached.slice(offset, offset + limit);
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    order_by: "ts",
    scene: "comment",
  });
  const url = `https://www.zhihu.com/api/v4/comments/${commentId}/child_comments?${params}`;
  const resp = await fetch(url, { credentials: "omit", headers: ZHIHU_HEADERS });
  if (!resp.ok) throw new Error(`zhihu child comments HTTP ${resp.status}`);
  const payload = await resp.json();
  return (payload.data || []).map((row) => commentFromRow(row, false)).filter(Boolean);
}

/* ── 存储（移植 feeds_storage.py / bookmarks_storage.py） ── */
const FEEDS_STORAGE_KEY = "feeds";
const BOOKMARKS_KEY = "feedBookmarks";
const MAX_ITEMS = 80;
const LOAD_MORE_BATCH = 20;

async function loadFeedsData() {
  const obj = await chrome.storage.local.get(FEEDS_STORAGE_KEY);
  return obj[FEEDS_STORAGE_KEY] || { last_updated: null, items: [], platforms: {} };
}

async function saveFeedsData(data) {
  data.last_updated = new Date().toISOString();
  await chrome.storage.local.set({ [FEEDS_STORAGE_KEY]: data });
}

function sortByPublishedDesc(items) {
  return items
    .slice()
    .sort((a, b) => String(b.published_at || "").localeCompare(String(a.published_at || "")));
}

function mergeItems(allItems, platform, newItems, maxItems, replace) {
  if (replace) {
    const other = allItems.filter((i) => i.platform !== platform);
    return sortByPublishedDesc(other.concat(newItems.slice(0, maxItems)));
  }
  const byId = new Map();
  for (const it of allItems) if (it.id) byId.set(it.id, it);
  for (const it of newItems) if (it.id) byId.set(it.id, it);
  const merged = sortByPublishedDesc([...byId.values()]);
  const plat = merged.filter((i) => i.platform === platform).slice(0, maxItems);
  const other = merged.filter((i) => i.platform !== platform);
  return sortByPublishedDesc(plat.concat(other));
}

async function recordPlatformStatus(
  platform,
  { status, error = null, itemCount = 0, feedOffset = null, hasMore = null }
) {
  const data = await loadFeedsData();
  data.platforms = data.platforms || {};
  const entry = data.platforms[platform] || {};
  entry.last_fetch_at = new Date().toISOString();
  entry.status = status;
  entry.error = error;
  entry.item_count = itemCount;
  if (feedOffset != null) entry.feed_offset = feedOffset;
  if (hasMore != null) entry.has_more = hasMore;
  data.platforms[platform] = entry;
  await saveFeedsData(data);
}

async function loadBookmarks() {
  const obj = await chrome.storage.local.get(BOOKMARKS_KEY);
  return obj[BOOKMARKS_KEY] || { bookmarks: [] };
}

async function listBookmarkIds() {
  const data = await loadBookmarks();
  return new Set(data.bookmarks.map((b) => b.item_id).filter(Boolean));
}

async function addBookmark(item) {
  const data = await loadBookmarks();
  const itemId = item.item_id || item.id;
  if (!itemId) throw new Error("item_id");
  data.bookmarks = data.bookmarks.filter((b) => b.item_id !== itemId);
  data.bookmarks.unshift({
    item_id: itemId,
    platform: item.platform || "",
    url: item.url || "",
    title: item.title || "",
    author: item.author || "",
    text: item.text || "",
    published_at: item.published_at || "",
    comment_count: Number(item.comment_count || 0),
    bookmarked_at: new Date().toISOString(),
  });
  await chrome.storage.local.set({ [BOOKMARKS_KEY]: data });
  return data.bookmarks[0];
}

async function removeBookmark(itemId) {
  const data = await loadBookmarks();
  const before = data.bookmarks.length;
  data.bookmarks = data.bookmarks.filter((b) => b.item_id !== itemId);
  await chrome.storage.local.set({ [BOOKMARKS_KEY]: data });
  return data.bookmarks.length < before;
}

function enabledPlatforms() {
  return { zhihu: true }; // Phase 1 仅知乎
}

/* ── 编排（移植 orchestrator.py） ─────────────────────────── */
async function runFetch({ platform } = {}) {
  const maxItems = MAX_ITEMS;
  const initialBatch = Math.min(LOAD_MORE_BATCH, maxItems);
  const targets = enabledPlatforms();
  if (platform && !targets[platform]) throw new Error(`platform not enabled: ${platform}`);
  if (platform) {
    for (const k of Object.keys(targets)) if (k !== platform) delete targets[k];
  }

  // 友好提示：未登录知乎 / z_c0 缺失
  const cookieHeader = await getCookieHeader("https://www.zhihu.com");
  if (!/z_c0=/.test(cookieHeader)) {
    for (const platformId of Object.keys(targets)) {
      await recordPlatformStatus(platformId, {
        status: "error",
        error: "zhihu cookies missing z_c0 — 请先在浏览器登录知乎",
        itemCount: 0,
      });
    }
    return;
  }

  const data = await loadFeedsData();
  let allItems = data.items || [];
  for (const platformId of Object.keys(targets)) {
    try {
      const rawItems = await zhihuFetchFeed(initialBatch, 0);
      const normalized = rawItems.map(normalizeItem).filter(Boolean);
      allItems = mergeItems(allItems, platformId, normalized, maxItems, true);
      await recordPlatformStatus(platformId, {
        status: "ok",
        error: null,
        itemCount: allItems.filter((i) => i.platform === platformId).length,
        feedOffset: normalized.length,
        hasMore: rawItems.length >= initialBatch,
      });
    } catch (err) {
      console.error("[feeds] fetch failed for", platformId, err);
      await recordPlatformStatus(platformId, {
        status: "error",
        error: String((err && err.message) || err),
        itemCount: allItems.filter((i) => i.platform === platformId).length,
      });
    }
  }
  data.items = allItems;
  await saveFeedsData(data);
}

async function runLoadMore({ platform } = {}) {
  const maxItems = MAX_ITEMS;
  const targets = enabledPlatforms();
  if (platform && !targets[platform]) throw new Error(`platform not enabled: ${platform}`);
  if (platform) {
    for (const k of Object.keys(targets)) if (k !== platform) delete targets[k];
  }
  const data = await loadFeedsData();
  let allItems = data.items || [];
  const result = { added: 0, has_more: false, total: allItems.length };

  for (const platformId of Object.keys(targets)) {
    const state = (data.platforms || {})[platformId] || {};
    const currentCount = allItems.filter((i) => i.platform === platformId).length;
    if (currentCount >= maxItems) {
      result.has_more = false;
      continue;
    }
    const feedOffset = Number(state.feed_offset || 0);
    try {
      const rawItems = await zhihuFetchFeed(LOAD_MORE_BATCH, feedOffset);
      const normalized = rawItems.map(normalizeItem).filter(Boolean);
      const before = allItems.length;
      allItems = mergeItems(allItems, platformId, normalized, maxItems, false);
      const added = allItems.length - before;
      const newOffset = feedOffset + rawItems.length;
      const hasMore =
        rawItems.length >= LOAD_MORE_BATCH &&
        allItems.filter((i) => i.platform === platformId).length < maxItems;
      await recordPlatformStatus(platformId, {
        status: "ok",
        error: null,
        itemCount: allItems.filter((i) => i.platform === platformId).length,
        feedOffset: newOffset,
        hasMore,
      });
      result.added += added;
      result.has_more = result.has_more || hasMore;
      result.total = allItems.length;
    } catch (err) {
      console.error("[feeds] load-more failed for", platformId, err);
      await recordPlatformStatus(platformId, {
        status: "error",
        error: String((err && err.message) || err),
        itemCount: currentCount,
      });
      throw err;
    }
  }
  data.items = allItems;
  await saveFeedsData(data);
  return result;
}

function itemFromBookmarkEntry(entry, byId) {
  const itemId = entry.item_id;
  if (!itemId) return null;
  const cached = byId.get(itemId);
  if (cached) return { ...cached, bookmarked: true };
  let platform = entry.platform;
  let nativeType = "";
  let nativeId = "";
  try {
    const p = parseItemId(itemId);
    platform = p.platform;
    nativeType = p.nativeType;
    nativeId = p.nativeId;
  } catch (e) {
    return null;
  }
  return {
    id: itemId,
    platform,
    native_type: nativeType,
    native_id: nativeId,
    title: entry.title || "",
    text: entry.text || "",
    author: entry.author || "",
    url: entry.url || "",
    published_at: entry.published_at || entry.bookmarked_at || "",
    comment_count: Number(entry.comment_count || 0),
    bookmarked: true,
  };
}

async function getFeeds({ platform, bookmarkedOnly = false, offset = 0, limit = null } = {}) {
  const data = await loadFeedsData();
  const cacheItems = data.items || [];
  const bookmarkIds = await listBookmarkIds();
  const byId = new Map(cacheItems.filter((i) => i.id).map((i) => [i.id, i]));

  let items;
  if (bookmarkedOnly) {
    items = [];
    const seen = new Set();
    const bk = await loadBookmarks();
    for (const entry of bk.bookmarks) {
      const item = itemFromBookmarkEntry(entry, byId);
      if (item && !seen.has(item.id)) {
        items.push(item);
        seen.add(item.id);
      }
    }
  } else {
    items = cacheItems.map((item) => ({ ...item, bookmarked: bookmarkIds.has(item.id) }));
  }

  if (platform) items = items.filter((i) => i.platform === platform);
  const total = items.length;
  if (limit != null) items = items.slice(offset, offset + limit);

  const platforms = data.platforms || {};
  let hasMore = false;
  if (platform && platforms[platform]) hasMore = !!platforms[platform].has_more;
  else if (!platform) hasMore = Object.values(platforms).some((v) => v && v.has_more);

  return {
    last_updated: data.last_updated,
    items,
    total,
    offset,
    limit,
    has_more: hasMore || (limit != null && offset + items.length < total),
    platforms,
  };
}

async function getStatus() {
  const data = await loadFeedsData();
  return { last_updated: data.last_updated, platforms: data.platforms || {} };
}

async function getItemDetail(itemId) {
  const { platform, nativeType, nativeId } = parseItemId(itemId);
  if (platform !== "zhihu") throw new Error(`platform not enabled: ${platform}`);
  const item = await zhihuFetchItemDetail(nativeType, nativeId);
  if (!item) throw new Error("item contains video content and was filtered");
  const ids = await listBookmarkIds();
  item.bookmarked = ids.has(itemId);
  return item;
}

async function getItemComments(itemId, offset, limit) {
  const { platform, nativeType, nativeId } = parseItemId(itemId);
  if (platform !== "zhihu") throw new Error(`platform not enabled: ${platform}`);
  const comments = await zhihuFetchComments(nativeType, nativeId, offset, limit);
  return { item_id: itemId, offset, limit, comments: comments.map(normalizeComment) };
}

async function getCommentChildren(commentId, offset, limit) {
  const children = await zhihuFetchChildComments(commentId, offset, limit);
  return { comment_id: commentId, offset, limit, comments: children.map(normalizeComment) };
}

async function toggleBookmark(itemId, item) {
  const ids = await listBookmarkIds();
  if (ids.has(itemId)) {
    await removeBookmark(itemId);
    return false;
  }
  await addBookmark(item || { item_id: itemId });
  return true;
}

window.Feeds = {
  runFetch,
  runLoadMore,
  getFeeds,
  getStatus,
  getItemDetail,
  getItemComments,
  getCommentChildren,
  toggleBookmark,
  parseItemId,
};
