/* ============================================================
   anjuke-overlay.js — 安居客「地图找房」气泡户型浮层（content script）

   形态：
   - 地图气泡 div.mark 下方挂一条小标签：「2/2/1-95平-92万  2/2/1-90平-87万」
   - 点标签展开面板：房型/户型/面积/参考总价/朝向 + 复制 + 去详情页
   - 地图接口自带的户型最多 3 条（服务端写死），面板里可点「加载全部 N 个户型」
     去抓详情页补齐

   设计约束（改这个文件前先读）：
   - 气泡是纯 DOM（div.mark.mark-point），内联 left/top 像素定位；地图平移时
     【回收复用】这些节点，不增不删只改 style/文本 —— 所以 MutationObserver
     必须同时监听 attributes + characterData，且重扫必须幂等（靠 __epRaw 文本
     比对做快路径），否则要么不更新，要么自己触发自己死循环。
   - 气泡文本 = 楼盘名 + 价格【连写无分隔符】（"浐灞1016000元/m²"），纯正则剥
     价格会误伤带数字的楼盘名 —— 用三级匹配：剥价格精确 / 原文精确 / 最长前缀。
   - 价格单位是 m²(U+00B2)，不是 ㎡(U+33A1)。
   - 取数必须经 background：页面自己是用 jQuery JSONP 调
     api.fang.anjuke.com/web/loupan/mapNewlist/ 的，该接口不返回 CORS 头，
     content script 直接 fetch 会被页面源 CORS 拦。background 用 webRequest
     观察那条请求的 URL（拿到 bbox/zoom/筛选），再用同参数取纯 JSON（去掉
     callback 参数即返回纯 JSON），结果推送回本脚本。
   - 详情页 xa.fang.anjuke.com/loupan/<id>.html 与地图页【同源】，
     所以 content script 直接 fetch 即可（无 CORS 问题，cookie 自动带）；
     background 代理只作兜底。详情页若前端渲染则用同源 iframe 兜底
     （页面 CSP frame-ancestors 明确允许 *.anjuke.com）。
   - 户型提取【不依赖 class 名】：按「房型 + 面积 + 总价」的文本特征聚类，
     避免页面改版就失效。
   - 面板用 Shadow DOM + adoptedStyleSheets 隔离（也绕开页面 CSP）。
   ============================================================ */
(function () {
  "use strict";

  /* ── 常量 ─────────────────────────────────────────────── */

  const LOG_PREFIX = "[ajk-overlay]";
  const DEBUG = true; // 排查期保持 true；日志统一走 log()/warn()，便于一次性关掉
  const MARK_SEL = "div.mark";
  const BADGE_CLS = "ep-ajk-badge";
  const BADGE_MAX_ITEMS = 4; // 标签上最多列几个户型，超出用 "…+N" 收尾（完整列表在面板与 title 里）
  const PANEL_HOST_CLS = "ep-ajk-panel-host";
  const PRICE_RE = /\d+(\.\d+)?\s*元\s*\/?\s*(m²|㎡|m2|平)/i;
  const SHIELD_RE = /验证码|geetest|xxzlGatewayUrl/i;
  const STATS_LOG_MS = 3000; // 统计日志节流
  const BADGE_LOG_MAX = 12; // 逐条打日志的上限，之后只出统计

  const ROOM_RE = /(\d+)\s*室\s*(\d+)\s*厅(?:\s*(\d+)\s*卫)?/;
  const ROOM2_RE = /(\d+)\s*居室/;
  const AREA_RE = /(\d+(?:\.\d+)?)\s*(?:㎡|m²|m2|平方米|平米|平)(?![\w])/;
  const TOTAL_RE = /(?:总价|参考总价|总价约|售价)\s*[:：]?\s*约?\s*(\d+(?:\.\d+)?)\s*万/;

  /* ── 日志 ─────────────────────────────────────────────── */

  function log(...args) {
    if (DEBUG) console.log(LOG_PREFIX, ...args);
  }
  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }
  function err(...args) {
    console.error(LOG_PREFIX, ...args);
  }

  /* ── 状态 ─────────────────────────────────────────────── */

  const INDEX = new Map(); // 归一化楼盘名 -> 接口行
  const DETAIL_CACHE = new Map(); // loupan_id -> { status, list, via, note }
  // 贝壳二手房（第三方信息源）：按小区名缓存；连接失败熔断后只允许手点
  const BEIKE_CACHE = new Map(); // name -> { status, data, note }
  // 贝壳 sug 的 <city> 路径段起城市限定作用（xx → 0 条），安居客地图页主机首段
  // 就是城市拼音（xa.fang.anjuke.com → xa）；但 www/m/api 这类前缀不是城市，
  // 传过去只会 0 条，所以拦掉交给 background 兜底。
  const CITY_SLUG = (() => {
    const head = (location.hostname.split(".")[0] || "").toLowerCase().replace(/[^a-z]/g, "");
    return /^(www|m|api|map|www2|fang)$/.test(head) || head.length < 2 ? "" : head;
  })();
  const beikeStatus = { fails: 0, blockedUntil: 0, lastError: "" }; // 最近一次响应里的熔断状态
  const BEIKE_STALL_MS = 20000; // 超时这么久还没结果 -> 面板别再显示「查询中」
  const badgeOfId = new Map(); // loupan_id -> badge（详情页回来后刷新）
  const stats = {
    marksSeen: 0,
    badges: 0,
    matched: 0,
    miss: 0,
    skipped: 0,
    rows: 0,
    ingests: 0,
    detailOk: 0,
    detailFail: 0,
    lastParams: null,
    lastIngestAt: null,
  };
  let lastStatsLog = 0;
  let badgeLogCount = 0;
  const missLogged = new Set();

  /* ── 文本工具 ─────────────────────────────────────────── */

  const norm = (s) => String(s || "").replace(/[\s·•・.\-—_()（）\[\]【】]/g, "").toLowerCase();

  function stripPrice(s) {
    return String(s || "")
      .replace(/\s+/g, "")
      .replace(/\d+(\.\d+)?\s*元\s*\/?\s*(m²|㎡|m2|平(方米)?)/gi, "")
      .replace(/\d+(\.\d+)?\s*万\s*\/?\s*(m²|㎡|m2|平)?/gi, "")
      .replace(/均价|待定|价格待定|元|m²|㎡/gi, "")
      .trim();
  }

  /** "5室2厅3卫1厨" / "5居室" -> "5/2/3" */
  function roomCode(alias) {
    const m = String(alias || "").match(/(\d+)\s*室\s*(\d+)\s*厅\s*(\d+)?/);
    if (m) return [m[1], m[2], m[3] || ""].filter(Boolean).join("/");
    const n = String(alias || "").match(/\d+/g) || [];
    return n.slice(0, 3).join("/") || "?";
  }

  function fmtArea(a) {
    const n = parseFloat(a);
    return Number.isFinite(n) ? String(Math.round(n * 10) / 10) : "";
  }

  /** 面积 × 均价 -> "124万"（推导值，接口不给总价） */
  function fmtTotal(area, price) {
    const a = parseFloat(area);
    const p = parseFloat(price);
    return Number.isFinite(a) && Number.isFinite(p) && p > 0 ? Math.round((a * p) / 10000) + "万" : "";
  }

  /**
   * 户型记录的总价单元格。户型接口给的值可能是"元"(1240000)也可能是"万"(124)：
   * 有地图均价时可交叉验证（面积×均价 的单位是元），量级明显偏大就按元算，否则按万。
   * 接口没给就用 面积×均价 推导并标 ~。
   */
  function fmtTotalCell(h, price) {
    const n = parseFloat(h.total);
    if (Number.isFinite(n) && n > 0) {
      const area = parseFloat(h.area);
      const expectYuan = Number.isFinite(area) && area > 0 && price > 0 ? area * price : 0;
      let wan;
      if (expectYuan > 0 && n > expectYuan * 0.3) wan = n / 10000;
      else if (n >= 100000) wan = n / 10000;
      else wan = n;
      return `${Math.round(wan)}万`;
    }
    const d = fmtTotal(h.area, price);
    return d ? `~${d}` : "—";
  }

  /** 接口自带的 3 条 -> "2/2/1-95平-92万  2/2/1-90平-87万" */
  function summarize(row) {
    const price = parseFloat(row.new_price) || 0;
    const hs = (row.house_types || []).slice(0, 3);
    if (!hs.length) return price ? `均价${price}元/m²` : "价格待定";
    return hs
      .map((h) => `${roomCode(h.alias)}-${fmtArea(h.area)}平-${fmtTotal(h.area, price) || "—"}`)
      .join("  ");
  }

  /** 千分位数字（贝壳单价/均价展示用）。 */
  function fmtNum(n) {
    return Number.isFinite(n) ? Number(n).toLocaleString("en-US") : "";
  }

  const escHtml = (s) =>
    String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  /* ── 气泡 -> 接口行 ───────────────────────────────────── */

  /**
   * 取气泡自身的文本，【排除我们自己注入的标签/面板】。
   * 标签是 div.mark 的子节点，若直接用 mk.textContent，标签文字会被读回来
   * 参与名称解析（实测会污染 __epRaw 快路径、把精确匹配逼成前缀匹配）。
   */
  function markText(mk) {
    let out = "";
    for (const n of mk.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        out += n.nodeValue || "";
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const cl = n.classList;
      if (cl && (cl.contains(BADGE_CLS) || cl.contains(PANEL_HOST_CLS))) continue;
      out += n.textContent || "";
    }
    return out.replace(/\s+/g, "");
  }

  /**
   * 三级匹配。① 剥掉价格后精确查；② 原文精确查；③ 索引最长前缀匹配
   * （③ 专门解决「浐灞101」+「6000元/m²」连写成「浐灞1016000元/m²」的情况）。
   */
  function resolveMark(mk) {
    const raw = markText(mk);
    const hasPrice = PRICE_RE.test(raw);
    const stripped = stripPrice(raw);

    let row = INDEX.get(norm(stripped)) || INDEX.get(norm(raw));
    if (row) return { row, name: row.loupan_name || stripped, hasPrice, via: "exact" };

    if (stripped && stripped !== raw) {
      const rawN = norm(raw);
      let best = null;
      let bestLen = 0;
      for (const [k, v] of INDEX) {
        if (k.length > bestLen && rawN.startsWith(k)) {
          best = v;
          bestLen = k.length;
        }
      }
      if (best) return { row: best, name: best.loupan_name || stripped, hasPrice, via: "prefix" };
    }
    return { row: null, name: stripped || raw, hasPrice, via: null };
  }

  /* ── 与 background 通信 ───────────────────────────────── */

  function askBackground(type, payload) {
    return chrome.runtime.sendMessage(Object.assign({ type }, payload || {})).catch((e) => {
      warn("sendMessage 失败:", type, e && e.message);
      return null;
    });
  }

  /** 收下一批行，合并进索引并触发重扫。 */
  function ingestRows(rows, params, from) {
    if (!Array.isArray(rows) || !rows.length) {
      log("收到空数据（", from, "）");
      return;
    }
    for (const r of rows) {
      if (r.loupan_name) INDEX.set(norm(r.loupan_name), r);
      if (r.loupan_name_short) INDEX.set(norm(r.loupan_name_short), r);
    }
    stats.rows += rows.length;
    stats.ingests++;
    stats.lastIngestAt = new Date().toLocaleTimeString("zh-CN");
    if (params) stats.lastParams = params;

    // 索引变了 -> 清掉全部快路径标记，强制重算
    for (const mk of document.querySelectorAll(MARK_SEL)) mk.__epRaw = null;

    log(
      `取数 #${stats.ingests}（${from}）：${rows.length} 行，索引 ${INDEX.size} 条`,
      params ? { bbox: `${params.swlng},${params.swlat} → ${params.nelng},${params.nelat}`, zoom: params.zoom } : ""
    );
    scheduleSync();
  }

  /* ── 详情页 -> 全部户型 ───────────────────────────────── */

  /**
   * 不依赖 class 名：按「房型 + 面积 + 总价」文本特征聚类。
   * ① 找"最内层含房型"的节点 ② 向上爬 ≤3 层找同时含面积的祖先（容器 >400 字放弃，
   * 防止抓到无关数字）③ 从该祖先文本抽总价 ④ 房型/面积/总价三者皆无 -> 丢弃
   */
  function extractFromDoc(doc, rec) {
    const out = [];
    const seenKey = new Set();
    let roomNodes = 0;
    let climbed = 0;
    let dropped = 0;

    for (const el of doc.querySelectorAll("body *")) {
      const t = el.textContent || "";
      if (!(ROOM_RE.test(t) || ROOM2_RE.test(t))) continue;
      let hasInner = false;
      for (const c of el.children) {
        const ct = c.textContent || "";
        if (ROOM_RE.test(ct) || ROOM2_RE.test(ct)) {
          hasInner = true;
          break;
        }
      }
      if (hasInner) continue; // 只要最内层
      roomNodes++;

      const t0 = t.replace(/\s+/g, " ").trim();
      const rm = ROOM_RE.exec(t0) || ROOM2_RE.exec(t0);
      if (!rm) continue;

      let node = el;
      let text = t0;
      for (let i = 0; i < 3 && node; i++) {
        if (AREA_RE.test(text) && text.length < 400) break;
        node = node.parentElement;
        if (!node) break;
        text = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (AREA_RE.test(text) && text.length < 400) {
          climbed++;
          break;
        }
      }
      if (text.length > 400) text = t0;

      const am = AREA_RE.exec(text);
      const tm = TOTAL_RE.exec(text);
      const alias = ROOM_RE.test(t0)
        ? `${rm[1]}室${rm[2]}厅${rm[3] ? rm[3] + "卫" : ""}`
        : `${rm[1]}居室`;
      const area = am ? am[1] : "";
      const total = tm ? tm[1] : "";
      // 只有房型、既没面积也没总价 -> 噪音（"3室2厅1卫户型已售罄"）
      if (!area && !total) {
        dropped++;
        continue;
      }
      const key = `${alias}|${area}|${total}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      out.push({ alias, area, total, raw: text.slice(0, 180) });
    }

    if (rec) Object.assign(rec, { roomNodes, climbed, dropped });
    return out;
  }

  /* ── 户型接口（首选数据源） ─────────────────────────────
   * GET {origin}/aifang/web/ajax/LoudongHuxing/?loupan_id=<id>
   *   - 与地图页【同源】，content script 直接 fetch 即可（cookie 自动带）
   *   - 需要 x-requested-with: XMLHttpRequest（该头不是 forbidden header，可以设）
   *   - 响应结构未公开，所以解析【不依赖字段名】：递归遍历 JSON，凡是"自己身上带着
   *     房型串（3室2厅2卫 / 5居室）"的对象就当一条户型记录，再从候选键名里取面积/总价/朝向。
   *     解析不出时把原始响应打到 console，照着写死字段映射即可。
   * ─────────────────────────────────────────────────── */
  const KEY_AREA = /^(area|build_area|building_area|jianzhu_area|area_size|mianji|size|huxing_area|total_area|inner_area|area_num|usable_area)$/i;
  const KEY_TOTAL = /^(total_price|totalprice|price_total|total_amount|zongjia|zong_jia|total|huxing_price|amount)$/i;
  const KEY_PRICE = /^(price|avg_price|unit_price|average_price|reference_price)$/i;
  const KEY_ORIENT = /^(orient|orientation|chaoxiang|toward|direction|face)$/i;
  const KEY_NAME = /^(alias|room_alias|huxing_alias|huxing_name|huxingname|room_name|room|fangxing|huxing|name|title|type_name)$/i;
  const ROOM_ANY = /(\d+)\s*室\s*(\d+)\s*厅(?:\s*(\d+)\s*卫)?/;
  const ROOM2_ANY = /(\d+)\s*居室/;
  const AREA_ANY = /(\d+(?:\.\d+)?)\s*(?:㎡|m²|m2|平方米|平米|平)(?![\w])/;

  /** "3室2厅2卫1厨" -> "3室2厅2卫"；"5居室" -> "5居室"；不含房型返回 "" */
  function roomKeyOf(sv) {
    const m = ROOM_ANY.exec(sv);
    if (m) return `${m[1]}室${m[2]}厅${m[3] ? m[3] + "卫" : ""}`;
    const m2 = ROOM2_ANY.exec(sv);
    return m2 ? `${m2[1]}居室` : "";
  }
  /** "105.00㎡" -> "105"；"1,240,000" -> "1240000" */
  function pickNum(sv) {
    const m = String(sv == null ? "" : sv).replace(/,/g, "").match(/\d+(?:\.\d+)?/);
    return m ? m[0] : "";
  }

  /** 递归找户型记录 -> [{alias, area, total, orient, priceRaw, raw}] */
  function parseHouseTypes(json, rec) {
    const out = [];
    const seen = new Set();
    const stat = { objects: 0, objHits: 0, strHits: 0, maxDepth: 0 };
    const add = (alias, area, total, orient, priceRaw, raw) => {
      const key = `${alias}|${area}|${total}`;
      if (!alias || seen.has(key)) return;
      seen.add(key);
      out.push({
        alias,
        area,
        total,
        orient: orient || "",
        priceRaw: priceRaw || "",
        raw: String(raw).slice(0, 200),
      });
    };

    (function walk(node, depth) {
      if (node == null || depth > 8) return;
      stat.maxDepth = Math.max(stat.maxDepth, depth);
      if (Array.isArray(node)) {
        for (const v of node) walk(v, depth + 1);
        return;
      }
      // 顶层就是字符串的情况（响应可能直接是 ["3室2厅2卫/105㎡", ...]）
      if (typeof node === "string") {
        if (node.length <= 60 && AREA_ANY.test(node)) {
          const a = roomKeyOf(node);
          if (a) {
            stat.strHits++;
            const am = AREA_ANY.exec(node);
            add(a, am ? am[1] : "", "", "", "", node);
          }
        }
        return;
      }
      if (typeof node !== "object") return;
      stat.objects++;

      let alias = "";
      let area = "";
      let total = "";
      let orient = "";
      let priceRaw = "";
      let nameGuess = "";
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (v == null || typeof v === "object") continue;
        const sv = String(v).trim();
        if (!sv || sv.length > 60) continue;
        if (!alias) {
          const a = roomKeyOf(sv);
          if (a) alias = a;
        }
        if (!area && KEY_AREA.test(k)) area = pickNum(sv);
        if (!total && KEY_TOTAL.test(k)) total = pickNum(sv);
        if (!orient && KEY_ORIENT.test(k)) orient = sv;
        if (!priceRaw && KEY_PRICE.test(k)) priceRaw = pickNum(sv);
        if (!nameGuess && KEY_NAME.test(k) && sv.length <= 20) nameGuess = sv;
      }
      // 名字不含房型（如 "A户型"）但同一对象里有面积 -> 也算一条
      if (!alias && nameGuess && area) alias = nameGuess;
      // price 字段一般是"均价(元/m²)"，但有的响应里放的是"总价(元)"。
      // 均价现实中不会到 30 万/㎡，所以量级 ≥ 30 万就按总价用；否则留给 面积×均价 推导（显示时带 ~）。
      if (!total && priceRaw && parseFloat(priceRaw) >= 300000) total = priceRaw;
      if (alias) {
        stat.objHits++;
        add(alias, area, total, orient, priceRaw, JSON.stringify(node));
      }

      for (const k of Object.keys(node)) {
        const v = node[k];
        if (v && typeof v === "object") {
          walk(v, depth + 1);
        } else if (typeof v === "string" && v.length <= 60 && AREA_ANY.test(v)) {
          // 兜底：关键信息拼在一个字符串里的情况（"3室2厅2卫 / 105㎡"）。
          // 必须自带面积才算，否则会和上面对象分支抓到的同一条重复一遍（空面积那次）。
          const a = roomKeyOf(v);
          if (a) {
            stat.strHits++;
            const am = AREA_ANY.exec(v);
            add(a, am ? am[1] : "", "", "", "", v);
          }
        }
      }
    })(json, 0);

    if (rec) rec.apiStat = stat;
    return out;
  }

  /** 调户型接口，返回原始文本（① 同源 fetch ② background 代理兜底） */
  async function fetchHuxingApi(id) {
    const url = `${location.origin}/aifang/web/ajax/LoudongHuxing/?loupan_id=${encodeURIComponent(id)}`;
    const headers = {
      "x-requested-with": "XMLHttpRequest",
      accept: "application/json, text/javascript, */*; q=0.01",
    };
    try {
      const r = await fetch(url, { credentials: "include", headers, cache: "no-store" });
      const t = await r.text();
      log(`户型接口 fetch：HTTP ${r.status}，${t.length} 字节`, SHIELD_RE.test(t) ? "（内容像反爬拦截页）" : "");
      if (r.ok && t) return t;
    } catch (e) {
      warn("户型接口同源 fetch 失败，转 background 代理：", e && e.message);
    }
    const res = await askBackground("ajk-fetch-json", { url, headers });
    if (res && res.ok && res.text) {
      log(`户型接口 background 代理：HTTP ${res.status}，${res.text.length} 字节`);
      return res.text;
    }
    warn("户型接口 background 代理也失败：", res && res.error);
    return "";
  }

  /** 失败时打印一段 HTML，用来写死选择器 */
  function snippetAround(html) {
    const i = html.search(/户型/);
    const j = i >= 0 ? i : html.search(/\d+室\d+厅/);
    if (j < 0) return html.slice(0, 1200).replace(/\s+/g, " ");
    return html.slice(Math.max(0, j - 400), j + 900).replace(/\s+/g, " ");
  }

  /** ① 同源 fetch（最像页面自己的请求，带 cookie/Referer）→ ② background 代理兜底 */
  async function getDetailText(url) {
    try {
      const r = await fetch(url, { credentials: "include" });
      const t = await r.text();
      log(`详情页 fetch：HTTP ${r.status}，${t.length} 字节`, SHIELD_RE.test(t) ? "（内容像反爬拦截页）" : "");
      if (r.ok) return t;
    } catch (e) {
      warn("详情页同源 fetch 失败，转 background 代理：", e && e.message);
    }
    const res = await askBackground("ajk-fetch-text", { url });
    if (res && res.ok && res.text) {
      log(`详情页 background 代理：HTTP ${res.status}，${res.text.length} 字节`);
      return res.text;
    }
    warn("详情页 background 代理也失败：", res && res.error);
    return "";
  }

  /** 前端渲染兜底：同源 iframe 加载后读 contentDocument（frame-ancestors 允许 *.anjuke.com） */
  function viaIframe(url, rec) {
    return new Promise((resolve) => {
      const f = document.createElement("iframe");
      f.style.cssText = "position:fixed;left:-10000px;top:0;width:1280px;height:900px;border:0;visibility:hidden";
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        let list = [];
        try {
          const d = f.contentDocument;
          if (!d) {
            rec.note = (rec.note || "") + " / 读不到 iframe 文档";
          } else {
            if (/验证码/.test(d.title || "")) rec.note = (rec.note || "") + " / iframe 落到验证码页";
            list = extractFromDoc(d, rec);
            log(`iframe 渲染后：房型节点 ${rec.roomNodes || 0} 个，解析出 ${list.length} 条`);
          }
        } catch (e) {
          rec.note = (rec.note || "") + " / iframe 读 DOM 失败: " + e.message;
        }
        try {
          f.remove();
        } catch (_) {}
        resolve(list);
      };
      f.addEventListener("load", () => setTimeout(finish, 2000)); // 等前端渲染
      f.src = url;
      document.body.appendChild(f);
      setTimeout(finish, 15000); // 超时兜底
      log("已用同源 iframe 加载详情页（等渲染）：", url);
    });
  }

  /** 抓某个楼盘的全部户型（按需触发，结果缓存） */
  function detailOf(row, force) {
    const id = row.loupan_id;
    const prev = DETAIL_CACHE.get(id);
    if (prev && !force) return prev; // 已取到 / 正在取 -> 直接用缓存
    if (prev && prev.status === "loading") return prev;

    const rec = { status: "loading", list: [], via: "", note: "", id };
    DETAIL_CACHE.set(id, rec);
    log(`开始抓户型：${row.loupan_name}（id=${id}，地图接口只给了 ${(row.house_types || []).length}/${row.house_type_count || "?"} 个）`);

    (async () => {
      const addNote = (m) => {
        rec.note = rec.note ? `${rec.note} / ${m}` : m;
      };

      // ① 户型接口（首选，结构化 JSON）
      try {
        const txt = await fetchHuxingApi(id);
        if (txt && SHIELD_RE.test(txt)) {
          addNote("户型接口被反爬拦截");
        } else if (txt) {
          let j = null;
          try {
            j = JSON.parse(txt);
          } catch (e) {
            addNote("户型接口返回的不是 JSON");
          }
          if (j) {
            const list = parseHouseTypes(j, rec);
            log(`户型接口解析：${list.length} 条`, rec.apiStat, list.slice(0, 4));
            if (list.length) {
              rec.status = "ok";
              rec.list = list;
              rec.via = "api";
              return;
            }
            addNote(`户型接口是 JSON 但没解析出户型记录（${rec.apiStat.objects} 个对象 / ${rec.apiStat.objHits} 对象命中 / ${rec.apiStat.strHits} 字符串命中）`);
            rec.snippet = txt.slice(0, 1500);
            log("↓ 户型接口原始响应（前 1500 字，发我可写死字段映射）:\n" + rec.snippet);
          }
        } else {
          addNote("户型接口无响应");
        }
      } catch (e) {
        addNote("户型接口异常: " + (e && e.message));
      }

      // ② 详情页 HTML：按文本特征聚类（不依赖 class 名）
      const url = row.loupan_link || `${location.origin}/loupan/${id}.html`;
      const html = await getDetailText(url);

      if (!html) {
        addNote("详情页取不到内容");
      } else if (SHIELD_RE.test(html)) {
        addNote("详情页被反爬拦截");
      } else {
        const list = extractFromDoc(new DOMParser().parseFromString(html, "text/html"), rec);
        if (list.length) {
          rec.status = "ok";
          rec.list = list;
          rec.via = "html";
          return;
        }
        addNote(`详情页 HTML 里没解析到户型（房型节点 ${rec.roomNodes || 0} 个，丢弃 ${rec.dropped || 0} 个）`);
        if (!rec.snippet) rec.snippet = snippetAround(html);
      }

      // ③ 兜底：同源 iframe 渲染后再读 DOM
      try {
        const list = await viaIframe(url, rec);
        if (list.length) {
          rec.status = "ok";
          rec.list = list;
          rec.via = "iframe";
          return;
        }
        addNote("iframe 渲染后也没解析到");
      } catch (e) {
        addNote("iframe 异常: " + e.message);
      }
      rec.status = "fail";
    })()
      .then(() => {
        if (rec.status === "ok") {
          stats.detailOk++;
          log(`✓ ${row.loupan_name} 详情页取到 ${rec.list.length} 个户型（via ${rec.via}）`, rec.list.slice(0, 5));
        } else {
          stats.detailFail++;
          warn(`✗ ${row.loupan_name} 详情页没拿到户型。原因：${rec.note}`);
          if (rec.snippet) {
            log("↓ 详情页 HTML 片段（把这段发我就能写死选择器）:\n" + rec.snippet);
          }
        }
        // 标签文字就地刷新（详情状态变了，不能等 MutationObserver）
        const b = badgeOfId.get(id);
        if (b) renderBadge(b);
        if (panelBadge && panelBadge.__epRow && panelBadge.__epRow.loupan_id === id) refreshPanel();
      })
      .catch((e) => {
        rec.status = "fail";
        rec.note = "未预期异常: " + (e && e.message);
        stats.detailFail++;
        err("detailOf 未预期异常", e);
      });

    return rec;
  }

  /* ── 幂等挂载 ─────────────────────────────────────────── */

  let raf = 0;
  function scheduleSync() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      syncAll();
    });
  }

  function syncAll() {
    const marks = document.querySelectorAll(MARK_SEL);
    stats.marksSeen = Math.max(stats.marksSeen, marks.length);
    let created = 0;
    for (const mk of marks) {
      try {
        if (syncMark(mk)) created++;
      } catch (e) {
        err("syncMark 出错", e);
      }
    }
    if (panelHost && !panelHost.isConnected) {
      panelHost = null;
      panelBadge = null;
    }
    // 统计日志节流，避免地图平移时刷屏
    const now = Date.now();
    if (created || now - lastStatsLog > STATS_LOG_MS) {
      lastStatsLog = now;
      log("同步：", {
        气泡: marks.length,
        新建标签: created,
        命中: stats.matched,
        未命中: stats.miss,
        跳过: stats.skipped,
        索引: INDEX.size,
      });
    }
  }

  /** 标签上的缩略摘要："2/2/1-95平-92万|3/2/2-96平-144万"，超出上限用 |…+N 收尾 */
  function badgeSummaryOf(badge) {
    const row = badge.__epRow;
    if (!row) return "详情?";
    const rec = DETAIL_CACHE.get(row.loupan_id);
    if (!rec || rec.status !== "ok" || !rec.list.length) return "详情";
    const price = parseFloat(row.new_price) || 0;
    const items = rec.list.map((h) => `${roomCode(h.alias)}-${fmtArea(h.area)}平-${fmtTotalCell(h, price)}`);
    const shown = items.slice(0, BADGE_MAX_ITEMS);
    if (items.length > shown.length) shown.push(`…+${items.length - shown.length}`);
    return shown.join("|");
  }

  /** 就地刷新标签（详情加载完成后由 detailOf 直接调，不等 MutationObserver） */
  function renderBadge(badge) {
    const txt = badgeSummaryOf(badge);
    if (badge.textContent !== txt) badge.textContent = txt;
    const row = badge.__epRow;
    const price = row ? parseFloat(row.new_price) || 0 : 0;
    const rec = row ? DETAIL_CACHE.get(row.loupan_id) : null;
    const n = rec && rec.status === "ok" ? rec.list.length : 0;
    badge.title = row
      ? `${row.loupan_name}${price ? ` · 均价 ${price} 元/m²` : ""}${n ? ` · 共 ${n} 个户型` : ""} · 点击看明细`
      : badge.__epName || "";
  }

  function findBadge(mk) {
    for (const c of mk.children) if (c.classList && c.classList.contains(BADGE_CLS)) return c;
    return null;
  }

  /** 返回 true 表示新建了标签 */
  function syncMark(mk) {
    const raw = markText(mk);
    if (mk.__epRaw === raw) return false; // 文本没变 -> 快路径（平移只改 style，几乎零开销）
    mk.__epRaw = raw;

    const { row, name, hasPrice, via } = resolveMark(mk);
    // 区域名/地铁站标记：既匹配不到、又不带价格 -> 不打扰
    if ((!name && !hasPrice) || (!row && !hasPrice)) {
      stats.skipped++;
      return false;
    }

    let badge = findBadge(mk);
    // 标签文字取决于「全量户型取到没有」，所以签名里带上详情状态
    const drec = row ? DETAIL_CACHE.get(row.loupan_id) : null;
    const sig = row
      ? `hit:${row.loupan_id}:${row.new_price || 0}:${drec ? drec.status + (drec.list ? drec.list.length : 0) : "-"}`
      : `miss:${name}`;
    if (badge && badge.__epSig === sig) return false;

    const isNew = !badge;
    if (isNew) {
      badge = document.createElement("div");
      badge.className = BADGE_CLS;
      badge.style.cssText = [
        "position:absolute",
        "left:50%",
        "top:100%",
        "transform:translateX(-50%)",
        "margin-top:3px",
        "padding:2px 6px",
        "border-radius:4px",
        "font:12px/1.5 -apple-system,'Segoe UI',sans-serif",
        "white-space:nowrap",
        "background:#fff",
        "color:#1a1a1a",
        "border:1px solid #d0d0d0",
        "box-shadow:0 1px 4px rgba(0,0,0,.18)",
        "cursor:pointer",
        "pointer-events:auto",
        "z-index:2147483000",
        "user-select:none",
      ].join(";");
      // 气泡本身点击会跳详情页 —— 这些事件用 capture 阶段掐断，
      // 它们在本元素上没有 competing listener，安全。
      for (const ev of ["mousedown", "mouseup", "pointerdown", "dblclick", "auxclick", "contextmenu"]) {
        badge.addEventListener(ev, (e) => {
          e.stopPropagation();
          e.preventDefault();
        }, true);
      }
      // click 必须【单独一个非 capture 监听器】同时做两件事：
      // 若把 stopPropagation 放进 capture 监听器，事件在本元素的冒泡阶段
      // 也会被跳过 —— 面板开关就永远不会执行（实测踩过）。
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        togglePanel(badge, mk);
      });
      mk.appendChild(badge);
      stats.badges++;
    }

    badge.__epSig = sig;
    badge.__epName = name;
    badge.__epRow = row || null;

    if (row) {
      stats.matched++;
      badgeOfId.set(row.loupan_id, badge);
      renderBadge(badge);
      badge.style.color = "#1a1a1a";
      badge.style.background = "#fff";
      if (badgeLogCount < BADGE_LOG_MAX) {
        badgeLogCount++;
        log(`挂标签（${via}）：${name} → ${badge.textContent}`, `地图接口自带 ${(row.house_types || []).length}/${row.house_type_count || "?"} 个户型，点开自动取全部`);
      } else if (badgeLogCount === BADGE_LOG_MAX) {
        badgeLogCount++;
        log("（逐条标签日志到此为止，之后只出统计）");
      }
    } else {
      stats.miss++;
      badge.textContent = "详情?";
      badge.style.color = "#888";
      badge.style.background = "#f5f5f5";
      if (!missLogged.has(name)) {
        missLogged.add(name);
        warn(`匹配不到接口数据：气泡文本「${raw}」-> 解析出「${name}」（索引里没有）`);
      }
    }

    if (panelBadge === badge) refreshPanel();
    return isNew;
  }

  /* ── 面板（Shadow DOM 隔离） ──────────────────────────── */

  let panelHost = null;
  let panelBadge = null;

  let sheet = null;
  function panelSheet() {
    if (sheet) return sheet;
    sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      :host { all: initial; }
      .p {
        font: 13px/1.6 -apple-system, "Segoe UI", sans-serif; color: #1a1a1a; background: #fff;
        border: 1px solid #d9d9d9; border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.18);
        padding: 10px 12px; width: max-content; max-width: 580px;
        /* 整体兜底：窗口太矮时面板自己滚，配合 JS 的「下方放不下就翻到气泡上方」 */
        max-height: calc(100vh - 48px); overflow: auto; overscroll-behavior: contain;
      }
      /* 列表最多显示 5 行，超出在列表内滚动（表头吸顶）。--row-h 是单行高度，
         --head-h 给表头留位，这样"5 个"是实数不是估算。 */
      .tbl { --row-h: 27px; --head-h: 26px; max-height: calc(5 * var(--row-h) + var(--head-h)); overflow-y: auto; overscroll-behavior: contain; }
      .tbl table { width: 100%; }
      .tbl thead th { position: sticky; top: 0; background: #fff; z-index: 1; }
      .tbl::-webkit-scrollbar { width: 8px; }
      .tbl::-webkit-scrollbar-thumb { background: #d0d0d0; border-radius: 4px; }
      .tbl::-webkit-scrollbar-track { background: transparent; }
      h4 { margin: 0 0 6px; font-size: 14px; font-weight: 600; }
      .meta { color: #888; font-size: 12px; margin-bottom: 8px; }
      .meta b { color: #e4393c; font-size: 13px; }
      table { border-collapse: collapse; width: 100%; }
      th, td { padding: 3px 8px 3px 0; text-align: left; white-space: nowrap; }
      th { color: #999; font-weight: 400; font-size: 12px; border-bottom: 1px solid #eee; }
      td.c { font-weight: 600; }
      td.num { text-align: right; font-variant-numeric: tabular-nums; }
      td.dim { color: #999; }
      .note { color: #c60; font-size: 12px; margin-top: 6px; max-width: 520px; white-space: normal; }
      .bx { margin-top: 9px; padding-top: 8px; border-top: 1px dashed #e0e0e0; }
      .bx h5 { margin: 0 0 5px; font-size: 12.5px; font-weight: 600; color: #333; }
      .bx h5 b { font-weight: 400; color: #888; margin-left: 6px; font-size: 12px; }
      .bx .bxt td, .bx .bxt th { padding: 2px 8px 2px 0; font-size: 12px; }
      .bx .tbl { --row-h: 24px; --head-h: 20px; }
      .tg { color: #999; margin-left: 6px; font-size: 11.5px; }
      .bx .note { margin-top: 5px; }
      a { color: #0066cc; text-decoration: none; }
      .foot { margin-top: 8px; display: flex; gap: 10px; align-items: center; font-size: 12px; flex-wrap: wrap; }
      button {
        font: inherit; font-size: 12px; padding: 2px 10px; cursor: pointer;
        border: 1px solid #ccc; border-radius: 4px; background: #fafafa; color: #1a1a1a;
      }
      button[disabled] { opacity: .55; cursor: default; }
    `);
    return sheet;
  }

  let fitBound = false;
  function bindFit() {
    if (fitBound) return;
    fitBound = true;
    window.addEventListener("resize", () => fitPanel());
  }

  function closePanel() {
    if (panelHost && panelHost.isConnected) panelHost.remove();
    if (panelBadge) panelBadge.__epPanelOpen = false;
    panelHost = null;
    panelBadge = null;
  }

  function togglePanel(badge, mk) {
    const wasOpen = panelBadge === badge;
    closePanel();
    if (wasOpen) {
      log("面板关闭");
      return;
    }

    const host = document.createElement("div");
    host.className = PANEL_HOST_CLS;
    host.style.cssText =
      "position:absolute;left:50%;top:100%;transform:translateX(-50%);margin-top:26px;z-index:2147483001";
    const root = host.attachShadow({ mode: "open" });
    try {
      root.adoptedStyleSheets = [panelSheet()];
    } catch (e) {
      warn("adoptedStyleSheets 不可用，退回内联 style", e && e.message);
      const st = document.createElement("style");
      st.textContent = panelSheet().cssText || "";
      root.appendChild(st);
    }
    root.innerHTML = `
      <div class="p">
        <h4 id="t"></h4>
        <div class="meta" id="m"></div>
        <div class="tbl">
          <table>
            <thead><tr><th>户型</th><th>面积</th><th>总价</th></tr></thead>
            <tbody id="b"></tbody>
          </table>
        </div>
        <div class="note" id="n"></div>
        <div class="bx">
          <h5>贝壳二手房<b id="bxm"></b></h5>
          <div class="tbl">
            <table class="bxt">
              <thead><tr><th>户型</th><th>面积</th><th>总价</th><th>单价</th></tr></thead>
              <tbody id="bxb"></tbody>
            </table>
          </div>
          <div class="note" id="bxn"></div>
        </div>
        <div class="foot">
          <a id="lk" target="_blank" rel="noopener">去详情页 →</a>
          <a id="bxl" target="_blank" rel="noopener">去贝壳 →</a>
          <button id="bxr">查贝壳</button>
          <button id="rt">重试</button>
          <button id="cp">复制</button>
        </div>
      </div>`;
    // 面板里的点击别传回地图/气泡。必须用【冒泡阶段】而不是 capture：
    // 事件路径是 div.mark > host > (shadow) button，若在 host 的 capture
    // 阶段 stopPropagation，事件根本到不了按钮自己的监听器。
    for (const ev of ["mousedown", "mouseup", "click", "dblclick", "pointerdown"]) {
      host.addEventListener(ev, (e) => e.stopPropagation());
    }
    root.getElementById("cp").addEventListener("click", (e) => {
      e.stopPropagation();
      const btn = root.getElementById("cp");
      navigator.clipboard.writeText(badge.__epCopyText || badge.__epName || "").then(
        () => { btn.textContent = "已复制"; setTimeout(() => { btn.textContent = "复制"; }, 1200); },
        () => { btn.textContent = "复制失败"; }
      );
    });
    root.getElementById("rt").addEventListener("click", (e) => {
      e.stopPropagation();
      if (!badge.__epRow) return;
      log("用户点了「重试」:", badge.__epName);
      detailOf(badge.__epRow, true);
      refreshPanel();
    });
    root.getElementById("lk").addEventListener("click", (e) => e.stopPropagation());
    root.getElementById("bxl").addEventListener("click", (e) => e.stopPropagation());
    root.getElementById("bxr").addEventListener("click", (e) => {
      e.stopPropagation();
      log("用户手点「查贝壳」:", badge.__epName);
      beikeOf(badge, true);
      refreshPanel();
    });

    bindFit();

    mk.appendChild(host);
    panelHost = host;
    panelBadge = badge;
    badge.__epPanelOpen = true;
    refreshPanel();
    log("面板展开:", badge.__epName, badge.__epRow ? `(id=${badge.__epRow.loupan_id})` : "（无接口数据）");

    // 打开面板就自动取全部户型（地图接口自带的最多 3 条，不够）；失败过就再试一次
    // 贝壳：每个小区只自动查一次（background 侧另有 6h 缓存 + 失败冷却，
    // 冷却期内 background 会立刻回一个带原因的失败，不会产生网络请求）
    if (!BEIKE_CACHE.get(badge.__epName)) {
      log("面板展开 -> 自动查贝壳:", badge.__epName, `(城市 ${CITY_SLUG})`);
      beikeOf(badge);
    }

    const pre = badge.__epRow ? DETAIL_CACHE.get(badge.__epRow.loupan_id) : null;
    if (badge.__epRow && (!pre || pre.status === "fail")) {
      log("面板展开 -> 自动加载全部户型:", badge.__epName);
      detailOf(badge.__epRow);
    }
  }

  /**
   * 贝壳 PC 小区页 HTML → 房源列表 + 单价区间。
   * service worker 没有 DOMParser，所以解析在内容脚本做。结构（线上实测）：
   *   ul.sellListContent > li.clear
   *     .title a       标题 + /ershoufang/<id>.html
   *     .houseInfo     高楼层(共11层) 3室2厅 | 112.18平米 | 南 北
   *     .totalPrice span  "135"（万在后面的 <i> 里）
   *     .unitPrice span   "12,035元/平"
   *     .tag span         标签
   */
  function parseBeikeUnit(s) {
    const str = String(s || "");
    const n = Number(str.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(n) || n <= 0) return null;
    return /万/.test(str) ? Math.round(n * 10000) : Math.round(n);
  }

  function parseBeikePcListings(html, origin) {
    let doc;
    try {
      doc = new DOMParser().parseFromString(String(html || ""), "text/html");
    } catch (e) {
      return { listings: [] };
    }
    let nodes = [...doc.querySelectorAll("ul.sellListContent > li")];
    if (!nodes.length) nodes = [...doc.querySelectorAll("li.clear")];

    const listings = [];
    for (const li of nodes) {
      const a = li.querySelector(".title a") || li.querySelector('a[href*="/ershoufang/"]');
      if (!a) continue;
      const infoNode = li.querySelector(".houseInfo");
      const infoText = String((infoNode && infoNode.textContent) || "").replace(/\s+/g, " ").trim();
      const segs = infoText.split("|").map((x) => x.trim()).filter(Boolean);
      const rooms = (infoText.match(/(\d+室(?:\d+厅)?)/) || [])[1] || "";
      const area = ((infoText.match(/([\d.]+\s*(?:平米|㎡|平))/) || [])[1] || "").trim();
      const facing = segs.find((x) => /^[东南西北]/.test(x)) || "";

      const totalSpan = li.querySelector(".totalPrice span");
      const totalNode = li.querySelector(".totalPrice");
      // 价格只留数字：PC 页的 "135" 本身就是 135 万，展示时统一补「万」
      const total = String((totalSpan && totalSpan.textContent) || (totalNode && totalNode.textContent) || "")
        .replace(/[^\d.]/g, "");

      const unitSpan = li.querySelector(".unitPrice span");
      const unit = String((unitSpan && unitSpan.textContent) || "").trim();
      const tags = [...li.querySelectorAll(".tag span")].map((x) => x.textContent.trim()).filter(Boolean);
      const href = a.getAttribute("href") || "";
      let url = "";
      try {
        url = href ? new URL(href, origin).toString() : "";
      } catch (e) {
        url = "";
      }

      listings.push({
        title: a.getAttribute("title") || a.textContent.trim(),
        rooms,
        area,
        facing,
        total,
        unit,
        unitNum: parseBeikeUnit(unit),
        tags,
        hot: tags.some((t) => t.includes("必看好房")),
        url,
      });
    }

    const nums = listings
      .map((l) => l.unitNum)
      .filter((n) => n != null)
      .sort((a, b) => a - b);
    const mid = nums.length
      ? nums.length % 2
        ? nums[(nums.length - 1) / 2]
        : Math.round((nums[nums.length / 2 - 1] + nums[nums.length / 2]) / 2)
      : null;

    return {
      listings,
      unitMin: nums.length ? nums[0] : null,
      unitMax: nums.length ? nums[nums.length - 1] : null,
      unitMedian: mid,
    };
  }

  /**
   * 贝壳二手房（第三方信息源）：小区名 → sug 找到贝壳小区 → 该小区在售二手房。
   * 全程走 background（content script fetch 会被页面源 CORS 拦，且需要
   * 浏览器登录态 cookie，由 background 的 DNR 规则 6 注入）。
   * 风控敏感：同一小区只自动取一次（background 侧还有 6h 缓存），
   * 连续失败后熔断，改成用户手点「查贝壳」。
   */
  function beikeOf(badge, force) {
    const name = badge.__epName;
    if (!name) return null;
    const prev = BEIKE_CACHE.get(name);
    if (prev && prev.status === "loading") return prev;
    if (prev && prev.status !== "fail" && !force) return prev;

    const rec = { status: "loading", data: null, note: "", startedAt: Date.now() };
    BEIKE_CACHE.set(name, rec);
    if (panelBadge === badge) refreshPanel();

    (async () => {
      const t0 = Date.now();
      let res = null;
      try {
        res = await askBackground("beike-community", { name, city: CITY_SLUG, force: force === true });
      } catch (e) {
        warn("贝壳取数抛异常:", (e && e.message) || e);
      }
      if (!res) {
        rec.status = "fail";
        rec.note = "后台无响应";
      } else if (res.ok && res.miss) {
        rec.status = "miss";
        rec.note = `贝壳没搜到「${name}」（城市限定 ${res.city || CITY_SLUG}）`;
      } else if (!res.ok) {
        rec.status = "fail";
        rec.note = res.error || "取数失败";
        beikeStatus.fails = res.fails || 0;
        beikeStatus.blockedUntil = res.blockedUntil || 0;
        beikeStatus.lastError = res.lastError || "";
      } else {
        let data = res;
        // 未命中缓存时 background 返回 PC 小区页 HTML；service worker 没有
        // DOMParser，所以解析在这里做，再把解析结果回写给 background 缓存。
        if (res.html) {
          const parsed = parseBeikePcListings(res.html, `https://${res.city}.ke.com`);
          if (!parsed.listings.length) {
            rec.status = "fail";
            rec.note = `贝壳小区页里没有房源列表 —— 可能未登录 ${res.city}.ke.com / 被风控，或该小区暂无在售`;
          } else {
            data = {
              ...res.hit,
              ...parsed,
              city: res.city,
              totalCount: (res.hit && res.hit.count) || parsed.listings.length,
              exact: res.hit && res.hit.exact,
            };
            askBackground("beike-cache-put", { name, city: res.city, payload: data });
          }
        }
        if (rec.status !== "fail") {
          rec.status = "ok";
          rec.data = data;
        }
      }
      log(
        `贝壳取数「${name}」（城市 ${CITY_SLUG || "默认 xa"}，${Date.now() - t0}ms）→`,
        rec.status,
        rec.data ? `${rec.data.listings.length} 条/在售 ${rec.data.totalCount} 套` : rec.note
      );
      if (panelBadge === badge) refreshPanel();
    })();
    return rec;
  }

  function beikeRowsHtml(rec, anjuPrice) {
    const d = rec.data;
    if (!d || !d.listings.length) return `<tr><td colspan="4" class="dim">—</td></tr>`;
    return d.listings
      .map((l) => {
        const tags = l.tags.slice(0, 3).join("·");
        const price = escHtml(l.total || "");
        return (
          `<tr><td>${escHtml(l.rooms || "")}${l.hot ? '<span class="tg">必看好房</span>' : ""}` +
          `${tags ? `<span class="tg">${escHtml(tags)}</span>` : ""}</td>` +
          `<td class="num">${escHtml(l.area || "")}</td>` +
          `<td class="num">${l.url ? `<a href="${escHtml(l.url)}" target="_blank" rel="noopener">${price}</a>` : price}</td>` +
          `<td class="num">${escHtml(l.unit || "")}</td></tr>`
        );
      })
      .join("");
  }

  /** 贝壳单价区间 vs 安居客小区均价 —— 这才是把它塞进气泡的意义。 */
  function beikeNoteText(rec, anjuPrice) {
    const d = rec.data;
    if (rec.status === "loading") return "正在查贝壳在售二手房…";
    if (rec.status === "fail" || rec.status === "miss") return rec.note;
    const seg = d.unitMedian ? `单价 ${fmtNum(d.unitMin)}–${fmtNum(d.unitMax)} 元/㎡（中位 ${fmtNum(d.unitMedian)}）` : "";
    let cmp = "";
    if (d.unitMedian && anjuPrice) {
      const diff = Math.round(((d.unitMedian - anjuPrice) / anjuPrice) * 100);
      cmp = ` · 安居客小区均价 ${fmtNum(anjuPrice)} → 贝壳挂牌中位${diff === 0 ? "持平" : diff > 0 ? "高 " + diff + "%" : "低 " + -diff + "%"}`;
    }
    const more = d.hasMore ? `，另有更多（本页 ${d.listings.length} 条）` : "";
    return `${seg}${cmp}${more}${d.exact === false ? ` · 匹配到「${d.name}」` : ""}`;
  }

  /** 面板下方放不下就翻到气泡上方；每次刷新后都重算（数据到达会改变高度）。 */
  function fitPanel() {
    if (!panelHost || !panelHost.isConnected) return;
    const st = panelHost.style;
    st.top = "100%";
    st.bottom = "auto";
    st.marginTop = "26px";
    st.marginBottom = "0";
    const r = panelHost.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8 && r.height <= window.innerHeight - 48) {
      st.top = "auto";
      st.bottom = "100%";
      st.marginTop = "0";
      st.marginBottom = "26px";
    }
  }

  function refreshPanel() {
    if (!panelHost || !panelBadge) return;
    const root = panelHost.shadowRoot;
    if (!root) return;
    const badge = panelBadge;
    const row = badge.__epRow;
    const name = badge.__epName || "（未识别名称）";
    const price = row ? parseFloat(row.new_price) || 0 : 0;
    const rec = row ? DETAIL_CACHE.get(row.loupan_id) : null;

    // 全量还没到就先拿地图接口自带的几条垫着，别让面板空着
    const mapList = row ? row.house_types || [] : [];
    const full = rec && rec.status === "ok" && rec.list.length ? rec.list : null;
    const list = full || mapList.map((h) => ({ alias: h.alias, area: h.area, total: "" }));
    const totalCount = row ? row.house_type_count || list.length : 0;

    root.getElementById("t").textContent = name;
    root.getElementById("m").innerHTML = row
      ? (price ? `均价 <b>${price}</b> 元/m² · ` : "价格待定 · ") +
        `${escHtml(row.region_title || "")}${escHtml(row.sub_region_title || "")} · 共 ${totalCount} 个户型`
      : "接口里没匹配到这个楼盘名（可能被缩写/改写过）";

    // 只标注 户型 / 面积 / 总价
    root.getElementById("b").innerHTML = list.length
      ? list
          .map((h) => {
            const total = fmtTotalCell(h, price);
            return (
              `<tr><td>${escHtml(h.alias || "")}</td>` +
              `<td class="num">${escHtml(fmtArea(h.area))} 平</td>` +
              `<td class="num">${escHtml(total)}</td></tr>`
            );
          })
          .join("")
      : `<tr><td colspan="3" class="dim">没有户型数据${price ? "" : "（价格待定）"}</td></tr>`;

    const note = root.getElementById("n");
    if (!row) {
      note.textContent = "";
    } else if (rec && rec.status === "loading") {
      note.textContent = `正在加载全部 ${totalCount} 个户型…（下面先显示地图接口自带的 ${list.length} 个）`;
    } else if (rec && rec.status === "fail") {
      note.textContent = `加载全部户型失败：${rec.note || "未知原因"}（下面是地图接口自带的 ${list.length} 个）`;
    } else if (full) {
      note.textContent = `已取到全部 ${list.length} 个户型（来源：${rec.via === "api" ? "户型接口" : rec.via === "iframe" ? "详情页 iframe 渲染" : "详情页 HTML"}）`;
      note.style.color = "#888";
    } else {
      note.textContent = "";
    }
    if (!full) note.style.color = "#c60";

    // 只有失败时才给「重试」
    const rt = root.getElementById("rt");
    rt.style.display = row && (!rec || rec.status === "fail") ? "" : "none";

    const lk = root.getElementById("lk");
    if (row && row.loupan_link) {
      lk.href = row.loupan_link;
      lk.style.display = "";
    } else {
      lk.style.display = "none";
    }

    // ── 贝壳二手房（第三方信息源）─────────────────────────
    // 关键：**没有记录 ≠ 查询中**。曾经把「无记录」也渲染成 loading，于是
    // 自动取数被熔断（或压根没触发）时面板会永远停在「查询中」，看起来像
    // 请求没回来实则一个请求都没发（用户实测遇到的就是这个）。
    const bxm = root.getElementById("bxm");
    const bxn = root.getElementById("bxn");
    const bxl = root.getElementById("bxl");
    const bxr = root.getElementById("bxr");
    try {
      let rec = BEIKE_CACHE.get(name);
      if (!badge.__epName) rec = { status: "miss", data: null, note: "这个气泡没解析出楼盘名，没法查贝壳" };
      else if (!rec) rec = { status: "idle", data: null, note: "" };

      // 兜底：loading 太久（或 SW 被回收导致回调没回来）就别再显示「查询中」
      if (rec.status === "loading" && rec.startedAt && Date.now() - rec.startedAt > BEIKE_STALL_MS) {
        rec = { status: "stall", data: null, note: `请求已超过 ${Math.round((Date.now() - rec.startedAt) / 1000)}s 未返回 —— 点「查贝壳」重试（Console 里看 [beike] / [ajk-overlay] 日志）` };
      }

      root.getElementById("bxb").innerHTML =
        rec.status === "idle" || rec.status === "stall" ? `<tr><td colspan="4" class="dim">—</td></tr>` : beikeRowsHtml(rec, price);

      if (rec.status === "ok" && rec.data) {
        bxm.textContent = `${rec.data.totalCount} 套在售 · ${rec.data.region || ""}${rec.data.cached ? " · 缓存" : ""}`;
      } else if (rec.status === "loading") {
        bxm.textContent = "查询中…";
      } else if (rec.status === "idle") {
        bxm.textContent = "未查询";
      } else if (rec.status === "stall") {
        bxm.textContent = "查询超时";
      } else {
        bxm.textContent = rec.status === "miss" ? "未匹配到小区" : "取数失败";
      }

      bxn.textContent =
        rec.status === "idle"
          ? "点「查贝壳」按小区名去贝壳查在售二手房（每个小区只自动查一次）"
          : beikeNoteText(rec, price);
      bxn.style.color = rec.status === "ok" || rec.status === "loading" || rec.status === "idle" ? "#888" : "#c60";

      if (rec.status === "ok" && rec.data && rec.data.url) {
        bxl.href = rec.data.url;
        bxl.style.display = "";
      } else {
        bxl.style.display = "none";
      }
      bxr.style.display = rec.status === "loading" ? "none" : "";
    } catch (e) {
      // 渲染层任何异常都不能让面板停在半渲染状态
      err("贝壳区块渲染失败:", (e && e.message) || e);
      bxm.textContent = "贝壳区块出错";
      bxn.textContent = `渲染失败：${(e && e.message) || e}`;
      bxn.style.color = "#c60";
      bxl.style.display = "none";
      bxr.style.display = "";
    }

    const bx = BEIKE_CACHE.get(name);
    const bxPart =
      bx && bx.status === "ok" && bx.data && bx.data.unitMedian
        ? ` | 贝壳在售 ${bx.data.totalCount} 套 单价 ${fmtNum(bx.data.unitMin)}-${fmtNum(bx.data.unitMax)}`
        : "";
    badge.__epCopyText =
      `${name} | ` +
      (list.length
        ? list
            .map((h) => `${roomCode(h.alias)}-${fmtArea(h.area)}平-${fmtTotalCell(h, price)}`)
            .join("|")
        : "无数据") +
      bxPart;

    fitPanel();
  }

  /* ── 启动 ─────────────────────────────────────────────── */

  let observer = null;

  function start() {
    const root = document.querySelector("div.mapmain") || document.body;
    observer = new MutationObserver(scheduleSync);
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"],
      characterData: true,
    });

    const first = document.querySelector(MARK_SEL);
    if (first) {
      log("首个气泡属性:", [...first.attributes].map((a) => `${a.name}=${JSON.stringify(a.value)}`).join(" | "));
      log("首个气泡文本:", (first.textContent || "").replace(/\s+/g, ""));
    } else {
      warn(`没找到 ${MARK_SEL}，地图可能还没渲染完（观察节点 ${root.className || root.tagName}）`);
    }
    log("已启动，观察节点:", root.className || root.tagName);

    // 拉一次后台已缓存的参数/数据（background 可能已经观察到请求了）
    askBackground("ajk-rows").then((res) => {
      if (res && res.ok && Array.isArray(res.rows) && res.rows.length) {
        ingestRows(res.rows, res.params, "init");
      } else {
        log("后台暂无缓存数据（等页面自己发 mapNewlist 请求，或拖动一下地图）", res || {});
      }
    });

    // 后台观察到新请求后会推送过来
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "ajk-rows") ingestRows(msg.rows, msg.params, "push");
    });

    scheduleSync();
  }

  /* ── 调试钩子（隔离世界，页面脚本看不到） ─────────────── */

  window.__edgePanelAnjuke = {
    INDEX,
    DETAIL_CACHE,
    // 贝壳取数状态：auto=false 表示连续失败已熔断（面板会显示「已暂停自动取数」）
    beike: () => ({
      city: CITY_SLUG,
      fails: beikeStatus.fails,
      blockedSeconds: beikeStatus.blockedUntil ? Math.max(0, Math.round((beikeStatus.blockedUntil - Date.now()) / 1000)) : 0,
      lastError: beikeStatus.lastError,
      cache: [...BEIKE_CACHE.entries()].map(([k, v]) => ({ name: k, status: v.status, note: v.note, rows: v.data ? v.data.listings.length : 0 })),
    }),
    beikeRetry: (name) => {
      const b = [...document.querySelectorAll("." + BADGE_CLS)].find((x) => x.__epName === name);
      if (!b) return "没找到这个气泡标签";
      BEIKE_CACHE.delete(name);
      beikeOf(b, true);
      return "已重新取数：" + name;
    },
    stats,
    sync: syncAll,
    ingestRows: (rows, params) => ingestRows(rows, params, "manual"),
    summarize,
    resolveMark,
    roomCode,
    stripPrice,
    extractFromDoc,
    extract: (html) => extractFromDoc(new DOMParser().parseFromString(html, "text/html"), {}),
    parseHouseTypes,
    roomKeyOf,
    fetchHuxingApi,
    parseApi: (json) => parseHouseTypes(json, {}),
    detail: (id) => {
      const r = [...INDEX.values()].find((x) => String(x.loupan_id) === String(id)) || { loupan_id: id };
      return detailOf(r);
    },
    /** 逐气泡列出 raw -> 解析出的名字 -> 是否命中，用来判断名字匹配率 */
    dump: () =>
      [...document.querySelectorAll(MARK_SEL)].map((m) => {
        const r = resolveMark(m);
        return {
          raw: markText(m),
          name: r.name,
          hasPrice: r.hasPrice,
          hit: !!r.row,
          via: r.via,
          badge: (findBadge(m) || {}).textContent || null,
        };
      }),
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(start, 800));
  } else {
    setTimeout(start, 800);
  }

  log("脚本已注入", location.href);
})();
