/* ============================================================
   yaml.js — 极简 YAML 子集解析器（仅覆盖 edge-panel 配置模板结构）
   支持：嵌套映射、"- " 列表（标量或映射项）、# 注释、双引号/单引号/裸标量、整数、布尔
   不支持：锚点/别名、多行字符串、流式 [] {}、内联嵌套等复杂语法
   暴露全局函数 parseYamlConfig(text) → object；解析失败抛 Error。
   ============================================================ */
(function (global) {
  "use strict";

  // 去掉注释：'#' 在引号外且前一个字符是空白或行首时视为注释
  function stripComment(line) {
    let inS = false, inD = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "'" && !inD) inS = !inS;
      else if (c === '"' && !inS) inD = !inD;
      else if (c === "#" && !inS && !inD && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
        return line.slice(0, i);
      }
    }
    return line;
  }

  function parseScalar(raw) {
    const s = raw.trim();
    if (s === "" || s === "~" || s === "null") return null;
    if (/^-?\d+$/.test(s)) return Number(s);
    if (s === "true") return true;
    if (s === "false") return false;
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
      return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
      return s.slice(1, -1);
    }
    return s;
  }

  // 拆出 "key: value"（冒号后须为空白或行尾）；无合法冒号返回 null
  function splitKeyVal(line) {
    for (let i = 0; i < line.length; i++) {
      if (line[i] === ":") {
        const after = line[i + 1];
        if (after === undefined || after === " " || after === "\t") {
          return { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
        }
      }
    }
    return null;
  }

  function parseYamlConfig(text) {
    const lines = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = stripComment(raw).replace(/[ \t]+$/, "");
      const t = line.trim();
      if (t === "") continue;
      lines.push({ indent: line.length - line.trimStart().length, text: t });
    }
    if (lines.length === 0) return {};

    let pos = 0;

    function parseBlock(level) {
      return lines[pos] && (lines[pos].text === "-" || lines[pos].text.startsWith("- "))
        ? parseSeq(level)
        : parseMap(level);
    }

    function parseMap(level) {
      const obj = {};
      while (pos < lines.length) {
        const ln = lines[pos];
        if (ln.indent < level) break;
        if (ln.indent > level) throw new Error(`unexpected indentation: "${ln.text}"`);
        const kv = splitKeyVal(ln.text);
        if (!kv) throw new Error(`expected "key: value": "${ln.text}"`);
        pos++;
        if (kv.value === "") {
          if (pos < lines.length && lines[pos].indent > level) {
            obj[kv.key] = parseBlock(lines[pos].indent);
          } else {
            obj[kv.key] = null;
          }
        } else {
          obj[kv.key] = parseScalar(kv.value);
        }
      }
      return obj;
    }

    function parseSeq(level) {
      const arr = [];
      while (pos < lines.length) {
        const ln = lines[pos];
        if (ln.indent < level) break;
        if (ln.indent > level) break;
        if (!(ln.text === "-" || ln.text.startsWith("- "))) break;
        const rest = ln.text === "-" ? "" : ln.text.slice(2).trim();
        pos++;
        if (rest === "") {
          if (pos < lines.length && lines[pos].indent > level) {
            arr.push(parseBlock(lines[pos].indent));
          } else {
            arr.push(null);
          }
          continue;
        }
        const kv = splitKeyVal(rest);
        if (!kv) {
          arr.push(parseScalar(rest));
          continue;
        }
        // 映射项：首键在本行（- name: ...），后续键缩进更深，对齐 itemLevel
        const itemLevel = ln.indent + 2;
        const item = {};
        if (kv.value === "") {
          if (pos < lines.length && lines[pos].indent > level) item[kv.key] = parseBlock(lines[pos].indent);
          else item[kv.key] = null;
        } else {
          item[kv.key] = parseScalar(kv.value);
        }
        while (pos < lines.length) {
          const nxt = lines[pos];
          if (nxt.indent < itemLevel) break;
          if (nxt.indent === itemLevel) {
            const nk = splitKeyVal(nxt.text);
            if (!nk) throw new Error(`expected "key: value": "${nxt.text}"`);
            pos++;
            if (nk.value === "") {
              if (pos < lines.length && lines[pos].indent > itemLevel) item[nk.key] = parseBlock(lines[pos].indent);
              else item[nk.key] = null;
            } else {
              item[nk.key] = parseScalar(nk.value);
            }
          } else {
            throw new Error(`unexpected indentation: "${nxt.text}"`);
          }
        }
        arr.push(item);
      }
      return arr;
    }

    const result = parseBlock(lines[0].indent);
    if (pos < lines.length) {
      throw new Error(`unparsed content: "${lines[pos].text}"`);
    }
    return result;
  }

  global.parseYamlConfig = parseYamlConfig;
})(typeof globalThis !== "undefined" ? globalThis : this);
