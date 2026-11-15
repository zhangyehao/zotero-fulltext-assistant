/* Independent, read-only CNKI reference parsing.
 * Evidence: official www.cnki.com.cn/Article/CJFDTOTAL-DHDZ202305001.htm,
 * checked 2026-11-15. Its direct references use tbReferences*Body and an
 * explicitly declared same-origin references/ref.html request. The page labels
 * each returned group “first N”; this module never promises a complete list.
 * No script execution, network, credentials, imports or guessed API parameters.
 */
(function (root) {
  "use strict";
  const CNKI = root.FulltextCNKI || (typeof require === "function" ? require("./cnki.js") : null);
  const MAX_REFS = 500, MAX_CANDIDATES = 4, MAX_TEXT = 12000;
  const GROUPS = Object.freeze({
    CJFD: { key: "cjfdList", label: "中国期刊全文数据库", title: "articleName", year: "year", type: "journalArticle" },
    CPFD: { key: "cpfdList", label: "中国重要会议论文全文数据库", title: "cnTitle", year: "year", type: "conferencePaper" },
    CDFD: { key: "cdfdList", label: "中国博士学位论文全文数据库", title: "cnTitle", year: "disYear", type: "thesis" },
    CMFD: { key: "cmfdList", label: "中国优秀硕士学位论文全文数据库", title: "cnTitle", year: "disYear", type: "thesis" },
    CCND: { key: "ccndList", label: "中国重要报纸全文数据库", title: "ccndTitle", year: "year", type: "newspaperArticle" }
  });
  const clean = (value, limit = MAX_TEXT) => typeof value === "string" || typeof value === "number"
    ? String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim().slice(0, limit) : "";
  function official(value, base) {
    try {
      const url = new URL(String(value || ""), base);
      if (url.protocol !== "https:" || url.username || url.password || url.port || url.href.length > 8192
          || !/(?:^|\.)cnki\.(?:net|com\.cn)$/.test(url.hostname) || url.hostname.endsWith(".")) return null;
      url.hash = ""; return url;
    } catch (_) { return null; }
  }
  function hidden(node) {
    for (let current = node; current?.nodeType === 1; current = current.parentElement) {
      if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true"
          || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(current.getAttribute("style") || "")) return true;
    }
    return false;
  }
  function visibleText(node, limit = MAX_TEXT) {
    if (!node || hidden(node)) return "";
    const copy = node.cloneNode(true);
    for (const child of [...copy.querySelectorAll("script,style,template,noscript,[hidden],[aria-hidden='true']")]) child.remove();
    for (const child of [...copy.querySelectorAll("[style]")]) if (hidden(child)) child.remove();
    return clean(copy.textContent, limit);
  }
  function doi(value) {
    let text = clean(value, 2048).replace(/^doi\s*:\s*/i, "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
    try { text = decodeURIComponent(text); } catch (_) { return ""; }
    text = text.replace(/[.,;:]+$/, "");
    while (/[)\]}]$/.test(text)) {
      const close = text.slice(-1), open = { ")": "(", "]": "[", "}": "{" }[close];
      if (text.split(close).length <= text.split(open).length) break;
      text = text.slice(0, -1);
    }
    return /^10\.\d{4,9}\/[^\s<>"\u0000-\u001F]{1,1800}$/i.test(text) ? text.toLowerCase() : "";
  }
  function stableLink(value, base) {
    const url = official(value, base);
    if (!url) return "";
    if (/^\/Article\/[A-Z0-9_]+-[A-Z0-9_.-]+\.htm$/i.test(url.pathname)) return url.origin + url.pathname;
    // Opaque article/download query values must not become reference metadata.
    return CNKI?.safeArticleURL(url.href) || "";
  }
  function cleanTitle(value) {
    const title = clean(value, 2000);
    return title.length >= 2 && !/[<>\uFFFD]/.test(title)
      && !/^(?:全文|原文|查看|查看原文|下载|PDF|DOI|链接|link|full text|download|details|abstract)$/i.test(title) ? title : "";
  }
  function year(value) { const text = clean(value, 20); return /^(?:1[5-9]|20)\d{2}$/.test(text) ? text : ""; }
  function hash(value) { let h = 2166136261; for (const char of value) { h ^= char.codePointAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); }
  function empty(status = "unavailable") {
    return { status, references: [], groups: [], totalCount: null, visibleCount: 0, complete: false, partial: true, candidates: [], diagnostics: [] };
  }
  function count(text) {
    const value = clean(text, 300);
    const exact = /(?:共|总计|總計|total\s*[:：]?)\s*(\d{1,6})\s*(?:条|條|篇|项|項|references?)?/i.exec(value)
      || /^(?:参考文献|參考文獻|references)\s*[（(\[]\s*(\d{1,6})\s*[）)\]]/i.exec(value);
    return { totalCount: exact ? Number(exact[1]) : null, partial: /(?:前\s*\d|部分|更多|more|first\s+\d)/i.test(value) };
  }
  function addGroup(result, group) {
    if (!group.references.length && group.totalCount === null) return;
    group.visibleCount = group.references.length;
    group.partial = true;
    result.groups.push(group);
    for (const ref of group.references) {
      const key = ref.doi ? "doi:" + ref.doi : ref.url ? "url:" + ref.url : "text:" + ref.title + "|" + ref.raw;
      const prior = result.references.find(value => value._key === key);
      if (prior) continue;
      if (result.references.length >= MAX_REFS) { result.diagnostics.push({ code: "reference_limit" }); break; }
      ref.id = "cnki-ref-" + hash(key); ref._key = key; result.references.push(ref);
    }
  }
  function finish(result) {
    const used = new Set();
    for (const ref of result.references) { let id = ref.id; while (used.has(id)) id += "-2"; ref.id = id; used.add(id); delete ref._key; }
    result.visibleCount = result.references.length;
    if (result.groups.length && result.groups.every(group => Number.isInteger(group.totalCount))) result.totalCount = result.groups.reduce((sum, group) => sum + group.totalCount, 0);
    if (!result.gate) result.status = result.visibleCount ? "partial" : result.candidates.length ? "page_declared" : result.totalCount === 0 ? "empty" : "unavailable";
    return result;
  }
  function candidateURL(value, base, format = "html") {
    const origin = official(base), url = official(value, base);
    if (!origin || !url || url.origin !== origin.origin || /^(?:pay|mall|login|passport)\./i.test(url.hostname)) return null;
    if (/\/(?:login|logout|signout|order|pay|purchase|delete|remove|submit|accept|save)(?:[/.]|$)/i.test(url.pathname)
        || [...url.searchParams].some(([key]) => /^(?:action|operation|method|callback|token|password|auth|redirect|returnurl)$/i.test(key))) return null;
    if (format === "cnki-references-json") {
      if (url.hostname !== "www.cnki.com.cn" || url.pathname !== "/cnkispace/cjfd/references/ref.html"
          || [...url.searchParams].length !== 1 || !/^[A-F0-9]{16,512}$/i.test(url.searchParams.get("fileName") || "")) return null;
    } else if (!/(?:reference|reflist|references?list)/i.test(url.pathname)) return null;
    return { url: url.href, method: "GET", format, transient: true };
  }
  function addCandidate(result, candidate) {
    if (candidate && result.candidates.length < MAX_CANDIDATES && !result.candidates.some(value => value.url === candidate.url)) result.candidates.push(candidate);
  }
  function gate(doc, base) {
    if (/^(?:login|passport)\./.test(base.hostname)) return "login_required";
    const copy = doc.cloneNode(true);
    for (const node of copy.querySelectorAll("script,style,template,noscript,nav,footer,.abstract,.abstract-text,#ChDivSummary,#references,.references,[id^='tbReferences']")) node.remove();
    const text = visibleText(copy.body || copy, 20000);
    const heading = visibleText(copy.querySelector("h1,title"), 500);
    if (/^(?:安全验证|人机验证|访问验证|验证码|security check|verify you are human)$/i.test(heading)
        || /请(?:完成|进行|输入).{0,8}(?:验证码|安全验证|人机验证)|异常访问.{0,25}验证|verify you are human/i.test(text)) return "human_verification";
    if (/请先登录|登录后(?:查看|访问|下载)|登录已过期|会话已过期|sign in to (?:view|access)/i.test(text)) return "login_required";
    if (/无(?:查看|访问)权限|没有(?:查看|访问)权限|机构未订购|access denied|subscription required/i.test(text)) return "access_denied";
    return null;
  }
  function rowReference(row, group, base, legacy = false) {
    const raw = visibleText(row);
    if (!raw || raw.length < 3 || /^(?:暂无|暂无参考文献|无参考文献|没有参考文献|no references)[。.]?$/i.test(raw)) return null;
    const anchors = [...row.querySelectorAll("a[href]")].filter(node => !hidden(node));
    const article = anchors.find(node => stableLink(node.getAttribute("href"), base));
    const titleNode = row.querySelector('[itemprop="name"],.reference-title,.ref-title,[data-reference-title]');
    const title = cleanTitle(titleNode ? visibleText(titleNode, 2000) : article ? visibleText(article, 2000) : "");
    const url = article ? stableLink(article.getAttribute("href"), base) : "";
    const authors = [...row.querySelectorAll('[itemprop="author"],.reference-author,.ref-author')].filter(node => !hidden(node)).map(node => visibleText(node, 300)).filter(Boolean);
    let authorText = authors.join("; "), publicationYear = "";
    const date = row.querySelector('[itemprop="datePublished"],time[datetime],.reference-year,.ref-year');
    if (date) publicationYear = year(date.getAttribute("datetime") || date.getAttribute("content") || visibleText(date, 20));
    if (legacy && article) {
      const cell = article.closest("td") || row;
      const text = visibleText(cell), label = visibleText(article), offset = text.indexOf(label);
      if (offset >= 0) {
        if (!authorText) authorText = clean(text.slice(0, offset).replace(/[;；,，\s]+$/, ""), 2000);
        const tail = text.slice(offset + label.length);
        publicationYear ||= year(/[;；]\s*((?:1[5-9]|20)\d{2})\s*年/.exec(tail)?.[1]);
      }
    }
    const dois = new Set();
    for (const anchor of anchors) {
      try { const linked = new URL(anchor.getAttribute("href"), base); if (/^(?:dx\.)?doi\.org$/.test(linked.hostname)) { const value = doi(linked.href); if (value) dois.add(value); } } catch (_) {}
    }
    for (const match of raw.matchAll(/\bDOI\s*[:：]\s*(10\.\d{4,9}\/[^\s<>]+)/gi)) { const value = doi(match[1]); if (value) dois.add(value); }
    const paperDOI = dois.size === 1 ? [...dois][0] : "";
    const record = /\/Article\/CDMD-/i.test(url) ? null : CNKI?.normalizeRecord(url) || null;
    return { id: "", group, title, authors: [...new Set(authors)], authorText, year: publicationYear, doi: paperDOI, url, raw,
      itemType: GROUPS[group]?.type || "journalArticle", record, canImport: !!title && dois.size <= 1 };
  }
  function parse(doc, baseURL) {
    const result = empty(), base = official(baseURL);
    if (!base || !doc?.querySelectorAll) { result.status = "unsupported_url"; return result; }
    const seenRoots = new Set();
    let referenceGate = null;
    for (const [code, info] of Object.entries(GROUPS)) {
      const body = doc.getElementById("tbReferences" + code + "Body");
      if (!body || hidden(body)) continue;
      seenRoots.add(body);
      const badge = visibleText(doc.getElementById("tbReferences" + code + "Num"), 300);
      const refs = [...body.querySelectorAll("tr")].filter(row => !row.querySelector("tr") && !hidden(row)).slice(0, MAX_REFS)
        .map(row => rowReference(row, code, base.href, true)).filter(Boolean);
      addGroup(result, { id: code, label: info.label, references: refs, ...count(badge) });
    }
    const roots = [...doc.querySelectorAll('#references,#reference-list,.references,.reference-list,[data-section="references"]')];
    for (const heading of doc.querySelectorAll("h2,h3,h4")) {
      if (/^[【\[\s]*(?:参考文献|參考文獻|references)[】\]\s]*(?:[（(]\s*\d+\s*[)）])?$/i.test(visibleText(heading, 200))) {
        const container = heading.parentElement;
        if (container && !/^(?:body|html)$/i.test(container.localName) && container.querySelector("li,tr,p")) roots.push(container);
      }
    }
    for (const container of roots) {
      if (hidden(container) || [...seenRoots].some(value => value.contains(container) || container.contains(value))) continue;
      if (container.closest('[id^="tbQuote"],[id^="tbSecReferences"],[id^="tbSecQuote"]')) continue;
      seenRoots.add(container);
      const rows = [...container.querySelectorAll("li,tr,.reference-item,.ref-item")].filter(row => !hidden(row) && !row.querySelector("li,tr,.reference-item,.ref-item")
        && !row.closest('nav,.related,.related-articles,[data-section="related"]'));
      if (!rows.length) rows.push(...[...container.querySelectorAll("p")].filter(row => /^\s*[\[［]?\d{1,4}[\]］.)、]/.test(visibleText(row))));
      const refs = rows.slice(0, MAX_REFS).map(row => rowReference(row, "references", base.href)).filter(Boolean);
      const heading = container.querySelector("h1,h2,h3,h4,.reference-count,.count");
      addGroup(result, { id: "references-" + result.groups.length, label: "参考文献", references: refs, ...count(visibleText(heading, 300)) });
      // A list may remain partly readable while its own remainder requires
      // login. Do not discard those rows or confuse a gate with zero results.
      const notice = container.cloneNode(true);
      for (const row of notice.querySelectorAll("li,tr,.reference-item,.ref-item")) row.remove();
      const noticeText = visibleText(notice, 3000);
      if (/请(?:完成|进行|输入).{0,8}(?:验证码|安全验证|人机验证)/i.test(noticeText)) referenceGate = "human_verification";
      else if (/(?:请先登录|登录后.{0,10}(?:查看|获取)|请登录后查看|sign in to view)/i.test(noticeText)) referenceGate ||= "login_required";
      else if (/无(?:查看|访问)权限|没有(?:查看|访问)权限|机构未订购/i.test(noticeText)) referenceGate ||= "access_denied";
      for (const node of container.querySelectorAll("a[href],iframe[src]")) {
        if (hidden(node)) continue;
        const label = visibleText(node, 200);
        if (node.localName === "iframe" || /^(?:更多参考文献|全部参考文献|更多|下一页|next|more references|all references)$/i.test(label) || node.getAttribute("rel") === "next") {
          addCandidate(result, candidateURL(node.getAttribute("href") || node.getAttribute("src"), base.href));
        }
      }
    }
    result.gate = gate(doc, base) || referenceGate;
    if (result.gate) result.status = result.gate;
    if (!result.gate && base.hostname === "www.cnki.com.cn" && /^\/Article\//i.test(base.pathname)) {
      for (const script of [...doc.querySelectorAll("script:not([src])")].slice(0, 100)) {
        const text = script.textContent || "";
        if (text.length > 500000 || !text.includes("refarticles.references")) continue;
        // Only read the public literal GET declaration observed on this page.
        // Do not eval JavaScript, decrypt values or synthesize fileName tokens.
        const pattern = /\$\.get\(\s*(["'])(\/cnkispace\/cjfd\/references\/ref\.html)\1\s*,\s*\{\s*fileName\s*:\s*(["'])([A-F0-9]{16,512})\3\s*\}/gi;
        for (const match of text.matchAll(pattern)) {
          const url = new URL(match[2], base); url.searchParams.set("fileName", match[4]);
          addCandidate(result, candidateURL(url.href, base.href, "cnki-references-json"));
        }
      }
    }
    return finish(result);
  }
  function parseResponse(data, responseURL) {
    const result = empty(), url = official(responseURL);
    if (!url || !candidateURL(url.href, url.origin, "cnki-references-json")) { result.status = "unsupported_url"; return result; }
    if (!data || typeof data !== "object" || Array.isArray(data)) return result;
    const message = clean(data.msg || data.message, 300);
    if (/验证码|安全验证|captcha/i.test(message)) result.gate = "human_verification";
    else if (/登录|登入|login|sign in/i.test(message)) result.gate = "login_required";
    else if (/权限|拒绝|denied/i.test(message)) result.gate = "access_denied";
    if (result.gate) { result.status = result.gate; return result; }
    const references = data.error === 200 ? data.refarticles?.references : null;
    if (!references || typeof references !== "object" || Array.isArray(references)) {
      result.diagnostics.push({ code: /降级|降級/.test(message) ? "service_degraded" : "references_unavailable" }); return result;
    }
    for (const [code, info] of Object.entries(GROUPS)) {
      const values = references[info.key]; if (!Array.isArray(values)) continue;
      const refs = [];
      for (const value of values.slice(0, MAX_REFS)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const title = cleanTitle(value[info.title]), authorText = clean(value.author, 2000), publicationYear = year(value[info.year]);
        const file = clean(value.fileName, 160), unit = clean(value.conferUintCode, 30);
        let link = "";
        if (/^[A-Z0-9][A-Z0-9_.-]{0,127}$/i.test(file) && !file.includes("..")) {
          if (code === "CJFD") link = "https://www.cnki.com.cn/Article/CJFDTOTAL-" + file + ".htm";
          else if (code === "CPFD") link = "https://cpfd.cnki.com.cn/Article/CPFDTOTAL-" + file + ".htm";
          else if ((code === "CMFD" || code === "CDFD") && /^\d{3,12}$/.test(unit)) link = "https://cdmd.cnki.com.cn/Article/CDMD-" + unit + "-" + file.replace(/\.nh$/i, "") + ".htm";
        }
        const record = file ? CNKI?.normalizeRecord({ dbcode: code, filename: file }) || null : null;
        if (!title && !authorText) continue;
        refs.push({ id: "", group: code, title, authors: [], authorText, year: publicationYear, doi: doi(value.doi), url: link, raw: "",
          itemType: info.type, record, canImport: !!title });
      }
      addGroup(result, { id: code, label: info.label, references: refs, totalCount: null, partial: true });
    }
    return finish(result);
  }
  function merge(...values) {
    const result = empty();
    for (const value of values.filter(Boolean)) {
      for (const group of value.groups || []) addGroup(result, { ...group, references: (group.references || []).map(ref => ({ ...ref })) });
      for (const candidate of value.candidates || []) addCandidate(result, candidate);
      result.diagnostics.push(...(value.diagnostics || []));
      if (value.gate) result.gate = value.gate;
    }
    if (result.gate) result.status = result.gate;
    return finish(result);
  }
  const api = Object.freeze({ parse, parseResponse, merge, candidateURL });
  root.FulltextCNKIReferences = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
