/* CNKI page interpretation only: no requests, credentials, orders or imports.
 * Field/route evidence checked against Zotero's official CNKI translator and
 * official CNKI article pages on 2026-11-15. This is an independent implementation.
 * Opaque detail/download URLs are transient; persist articleURL/record only.
 */
(function (root) {
  "use strict";
  const TYPES = Object.freeze({ CJFQ: "journalArticle", CJFD: "journalArticle", CAPJ: "journalArticle", SJES: "journalArticle", SJPD: "journalArticle", SSJD: "journalArticle", CCJD: "journalArticle", CYFD: "journalArticle", CDFD: "thesis", CMFD: "thesis", CLKM: "thesis", CCND: "newspaperArticle", CPFD: "conferencePaper", IPFD: "conferencePaper", SCPD: "patent" });
  const LIMIT = 8;
  const clean = (value, limit = 2000) => String(value || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/\s+/g, " ").trim().slice(0, limit);
  // Zotero's official CNKI translator includes an article with dbcode=CJFQ
  // and dbname=CJFDLAST2015. Treat this explicit legacy journal alias as CJFD
  // throughout identity checks; other database names remain distinct.
  const databaseCode = value => { const code = clean(value, 20).toUpperCase(); return code === "CJFQ" ? "CJFD" : code; };
  const titleKey = value => clean(value).normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "");
  const doi = value => {
    const text = clean(value).replace(/^doi\s*:\s*/i, "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
    return /^10\.\d{4,9}\/[^\s<>]{1,1800}$/i.test(text) ? text.replace(/[.,;]+$/, "").toLowerCase() : "";
  };
  function officialURL(value, base) {
    try {
      const url = new URL(String(value || ""), base);
      if (url.protocol !== "https:" || url.username || url.password || url.port || url.href.length > 8192
          || !/(?:^|\.)cnki\.(?:net|com\.cn)$/.test(url.hostname) || url.hostname.endsWith(".")) return null;
      url.hash = "";
      return url;
    } catch (_) { return null; }
  }
  function articleLocation(value) {
    try { const url = new URL(String(value || "")); if (url.protocol === "http:") url.protocol = "https:"; return officialURL(url.href); }
    catch (_) { return null; }
  }
  function isCNKIURL(value) { return !!articleLocation(value); }
  function parameter(url, names, normalize = value => value.toUpperCase()) {
    const values = [...url.searchParams].filter(([key]) => names.includes(key.toLowerCase())).map(([, value]) => value.trim());
    if (new Set(values.map(normalize)).size > 1) return { conflict: true, value: "" };
    return { conflict: false, value: values[0] || "" };
  }
  function fields(dbcode, dbname, filename) {
    dbcode = databaseCode(dbcode); dbname = clean(dbname, 80).toUpperCase(); filename = clean(filename, 160).toUpperCase();
    if (!dbcode && dbname) dbcode = databaseCode(dbname.slice(0, 4));
    if (!TYPES[dbcode] || !/^[A-Z0-9][A-Z0-9_.-]{0,127}$/.test(filename) || filename.includes("..")
        || dbname && (!/^[A-Z0-9_]{4,64}$/.test(dbname) || databaseCode(dbname.slice(0, 4)) !== dbcode)) return null;
    return { provider: "cnki", id: "CNKI:" + dbcode + ":" + filename, dbcode, dbname, filename };
  }
  function detailURL(url) {
    return /^\/(?:kcms\/detail\/detail\.aspx|kcms2\/article\/abstract)\/?$/i.test(url.pathname)
      || /^\/Article\/[A-Z0-9_]+-[A-Z0-9_.-]+\.htm$/i.test(url.pathname);
  }
  function recordFromURL(value) {
    const url = articleLocation(value);
    if (!url || !detailURL(url)) return null;
    let result;
    const article = /^\/Article\/([A-Z0-9_]+)-([A-Z0-9_.-]+)\.htm$/i.exec(url.pathname);
    // Public thesis links encode institution + thesis ID under CDMD. They do
    // not disclose whether the actual database is CMFD or CDFD, or the .NH
    // suffix. Keep them as readable pages, never invent a download identity.
    if (article && article[1].toUpperCase() === "CDMD") return null;
    if (article) result = fields("", article[1], article[2]);
    else {
      const code = parameter(url, ["dbcode"], databaseCode), name = parameter(url, ["dbname"]), file = parameter(url, ["filename"]);
      if (code.conflict || name.conflict || file.conflict) return null;
      result = fields(code.value, name.value, file.value);
    }
    if (!result) return null;
    if (article) result.url = url.origin + "/Article/" + result.dbname + "-" + result.filename + ".htm";
    else result.url = stableURL(result, url.hostname);
    return result;
  }
  function stableURL(record, hostname = "kns.cnki.net") {
    const host = /^(?:kns\d*|oversea|epub)\.cnki\.net$/.test(hostname) ? hostname : "kns.cnki.net";
    const url = new URL("https://" + host + "/KCMS/detail/detail.aspx");
    url.searchParams.set("dbcode", record.dbcode);
    if (record.dbname) url.searchParams.set("dbname", record.dbname);
    url.searchParams.set("filename", record.filename);
    return url.href;
  }
  function normalizeRecord(input) {
    if (typeof input === "string") {
      const match = /^CNKI:([A-Z]{4}):([A-Z0-9_.-]+)$/i.exec(input.trim());
      if (match) { const value = fields(match[1], "", match[2]); return value ? { ...value, url: stableURL(value) } : null; }
      return recordFromURL(input);
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const suppliedURL = input.url || input.articleURL || "", fromURL = recordFromURL(suppliedURL);
    let value = fields(input.dbcode, input.dbname, input.filename);
    if (value && input.id && normalizeRecord(input.id)?.id !== value.id) return null;
    if (!value && input.id) value = normalizeRecord(input.id);
    if (!value) return fromURL;
    if (fromURL && fromURL.id !== value.id) return null;
    const source = officialURL(suppliedURL);
    return { ...value, url: fromURL?.url || stableURL(value, source?.hostname) };
  }
  function safeArticleURL(input) { return normalizeRecord(input)?.url || null; }
  function pageURL(input) {
    if (input?.getField) input = input.getField("url");
    else if (input && typeof input === "object") input = input.url || input.articleURL || normalizeRecord(input)?.url;
    const url = articleLocation(input);
    if (!url || !detailURL(url)) return null;
    const hasIdentity = [...url.searchParams.keys()].some(key => ["filename", "dbcode", "dbname"].includes(key.toLowerCase()));
    return hasIdentity && !recordFromURL(url.href) ? null : url.href;
  }
  function fromItem(item) {
    if (!item) return null;
    const url = item.getField?.("url") || item.url || "", direct = normalizeRecord(url);
    const extra = String(item.getField?.("extra") || item.extra || "");
    const extraURL = /^CNKI URL\s*:\s*(https:\/\/\S+)\s*$/im.exec(extra)?.[1];
    const extraID = /^CNKI(?: ID)?\s*:\s*(CNKI:[A-Z]{4}:[A-Z0-9_.-]+)\s*$/im.exec(extra)?.[1];
    const known = [direct, normalizeRecord(extraURL), normalizeRecord(item.getExtraField?.("CNKI")), normalizeRecord(extraID)].filter(Boolean);
    return new Set(known.map(record => record.id)).size > 1 ? null : known[0] || null;
  }
  function searchURL(title) {
    // Search is an explicit browser handoff. Do not invent query parameters or
    // bind an arbitrary first result to the current paper.
    return "https://kns.cnki.net/kns8s/defaultresult/index";
  }
  function metaValues(doc, names) {
    const wanted = new Set(names.map(value => value.toLowerCase()));
    return [...doc.querySelectorAll("meta[name],meta[property]")].filter(node => wanted.has((node.getAttribute("name") || node.getAttribute("property") || "").toLowerCase()))
      .map(node => clean(node.getAttribute("content"), 20000)).filter(Boolean);
  }
  function nodeText(node, limit = 2000) {
    if (!node) return "";
    node = node.cloneNode(true);
    for (const child of node.querySelectorAll("script,style,.full-text,.type,[hidden],[aria-hidden='true']")) child.remove();
    return clean(node.textContent, limit);
  }
  function hidden(doc, name) {
    return [...doc.querySelectorAll("input")].filter(node => (node.id || node.getAttribute("name") || "").toLowerCase() === name)
      .map(node => clean(node.getAttribute("value"), 160)).filter(Boolean);
  }
  function pageRecord(doc, url) {
    const file = hidden(doc, "hidfilename"), code = hidden(doc, "hiddbcode"), name = hidden(doc, "hiddbname");
    if ([file, name].some(values => new Set(values.map(value => value.toUpperCase())).size > 1) || new Set(code.map(databaseCode)).size > 1) return { conflict: true };
    const visible = file.length ? fields(code[0], name[0], file[0]) : null;
    const location = recordFromURL(url);
    const suppliedIdentity = [...new URL(url).searchParams.keys()].some(key => ["filename", "dbcode", "dbname"].includes(key.toLowerCase()));
    if (suppliedIdentity && !location) return { conflict: true };
    if (file.length && !visible || visible && location && visible.id !== location.id) return { conflict: true };
    const record = visible || location;
    return { conflict: false, record: record ? { ...record, url: location?.url || stableURL(record, new URL(url).hostname) } : null };
  }
  function metadata(doc, record, address) {
    const first = names => metaValues(doc, names)[0] || "";
    const heading = doc.querySelector(".wx-tit h1 .title-one,h1 .title-one,.wx-tit h1,h1.xx_title,h1");
    const title = first(["citation_title", "dc.title"]) || nodeText(heading);
    let authors = metaValues(doc, ["citation_author"]);
    if (!authors.length) authors = [...doc.querySelectorAll("#authorpart a,.author a,.authors a")].map(node => nodeText(node, 300)).filter(Boolean);
    if (!authors.length && heading?.matches("h1.xx_title")) authors = [...(heading.parentElement?.nextElementSibling?.querySelectorAll('a[href*="author="]') || [])].map(node => nodeText(node, 300)).filter(Boolean);
    let paperDOI = doi(first(["citation_doi", "dc.identifier"]));
    if (!paperDOI) paperDOI = doi(nodeText(doc.querySelector("#DOI,#doi")));
    const date = first(["citation_publication_date", "citation_date", "dc.date"]);
    return { title: clean(title), doi: paperDOI, authors: [...new Set(authors)].slice(0, 100),
      abstract: first(["citation_abstract"]) || nodeText(doc.querySelector("#ChDivSummary,.abstract-text"), 20000),
      journal: first(["citation_journal_title"]), date: clean(date, 100),
      volume: first(["citation_volume"]), issue: first(["citation_issue"]),
      pages: [first(["citation_firstpage"]), first(["citation_lastpage"])].filter(Boolean).join("-"),
      issn: first(["citation_issn"]), isbn: first(["citation_isbn"]),
      keywords: [...new Set(metaValues(doc, ["citation_keywords", "keywords"]).flatMap(value => value.split(/[;,；，]|\s{2,}/).map(value => clean(value, 200)).filter(Boolean)))].slice(0, 40),
      itemType: TYPES[record?.dbcode] || (/^https:\/\/cdmd\.cnki\.com\.cn\/Article\/CDMD-/i.test(address) ? "thesis" : "journalArticle") };
  }
  function gate(doc, url) {
    const host = officialURL(url)?.hostname || "";
    if (/^(?:login|passport)\.cnki\.net$/.test(host)) return "login_required";
    const visible = doc.cloneNode(true);
    for (const node of visible.querySelectorAll('script,style,template,noscript,[hidden],[aria-hidden="true"],nav,footer,[role="navigation"],.references,#references,.reference-list,#reference-list,[id^="tbReferences"],[id^="tbQuote"],[id^="tbSecReferences"],[id^="tbSecQuote"],.related-articles,#ChDivSummary,.abstract-text')) node.remove();
    const text = clean(visible.body?.textContent, 100000);
    const verificationTitle = [...visible.querySelectorAll('h1,h2,[role="heading"]')].some(node => /^(?:安全验证|访问验证|异常访问|验证码|Security verification|Verify you are human)$/i.test(nodeText(node, 100)));
    if (verificationTitle || /请输入验证码|请(?:完成|通过|进行)(?:安全|身份|人机)验证|访问过于频繁|操作过于频繁|verify.{0,20}(?:you are human|your identity)|complete the captcha|unusual traffic/i.test(text)) return "human_verification";
    if (visible.querySelector('input[type="password"]') || /请先登录|登录后(?:下载|查看|访问)|登录已过期|会话已过期|sign in to (?:download|access)/i.test(text)) return "login_required";
    if (/无(?:下载|访问)权限|没有(?:下载|访问)权限|机构未订购|不在(?:订购|授权)范围|access denied|subscription required/i.test(text)) return "access_denied";
    return null;
  }
  function parsePage(doc, address, { expectedRecord, expectedDOI = "", expectedTitle = "" } = {}) {
    const result = { record: null, articleURL: null, metadata: null, candidates: [], cajAvailable: false, status: "unsupported_url", diagnostics: [] };
    const url = officialURL(address);
    if (!url || !doc?.querySelectorAll) return result;
    const restricted = gate(doc, url.href);
    if (restricted) { result.status = restricted; return result; }
    if (!detailURL(url)) return result;
    const parsed = pageRecord(doc, url.href), wanted = normalizeRecord(expectedRecord);
    if (parsed.conflict || wanted && parsed.record && wanted.id !== parsed.record.id) { result.status = "article_mismatch"; return result; }
    const info = metadata(doc, parsed.record, url.href);
    result.metadata = info; result.record = parsed.record; result.articleURL = parsed.record?.url || null;
    if (doi(expectedDOI) && info.doi && doi(expectedDOI) !== info.doi
        || titleKey(expectedTitle) && titleKey(info.title) && titleKey(expectedTitle) !== titleKey(info.title)) {
      result.status = "article_mismatch"; return result;
    }
    if (!result.record) { result.status = "record_unavailable"; return result; }
    if (!info.title || info.title.includes("\uFFFD")) { result.status = "metadata_unavailable"; return result; }
    let purchase = false;
    function add(raw, format, node) {
      const candidate = officialURL(raw, url.href);
      if (!candidate) return;
      const dtype = parameter(candidate, ["dtype", "format"]);
      if (dtype.conflict) return;
      if (/\.caj(?:$|\/)/i.test(candidate.pathname) || /^caj$/i.test(dtype.value)) format = "caj";
      const file = parameter(candidate, ["filename"]), code = parameter(candidate, ["dbcode", "dbtype"], databaseCode);
      const dataFile = node?.getAttribute("data-fn"), dataCode = node?.getAttribute("data-dbcode");
      if (file.conflict || code.conflict || file.value && file.value.toUpperCase() !== result.record.filename
          || code.value && databaseCode(code.value) !== result.record.dbcode
          || dataFile && dataFile.toUpperCase() !== result.record.filename || dataCode && databaseCode(dataCode) !== result.record.dbcode) {
        result.diagnostics.push({ code: "candidate_mismatch" }); return;
      }
      if (format === "caj") { result.cajAvailable = true; return; }
      if (/^(?:pay|mall)\.cnki\.net$/.test(candidate.hostname) || /购买|充值|purchase|buy\b/i.test(nodeText(node, 300))) { purchase = true; return; }
      if (/^(?:login|passport)\.cnki\.net$/.test(candidate.hostname)) return;
      if (!result.candidates.some(value => value.url === candidate.href) && result.candidates.length < LIMIT) result.candidates.push({ url: candidate.href, referrer: url.href, format: "pdf", recordID: result.record.id });
    }
    for (const node of doc.querySelectorAll('meta[name="citation_pdf_url"],meta[property="citation_pdf_url"]')) add(node.getAttribute("content"), "pdf", node);
    for (const node of doc.querySelectorAll("a[href]")) {
      if (node.closest('[hidden],[aria-hidden="true"],.references,#references,.related-articles,[class*="reference"],[id*="reference"]')) continue;
      const marker = [node.id, node.getAttribute("name"), node.getAttribute("data-dflag")].join(" ");
      const label = nodeText(node, 300);
      const pdf = /(?:^|\s)(?:pdfDown|ty_pdf|pdfdown)(?:$|\s)/i.test(marker) || /^(?:PDF|PDF下载|下载PDF|Download PDF|Full Text PDF)$/i.test(label)
        || node.closest("#DownLoadParts") && /\bPDF\b/i.test(label);
      const caj = /(?:^|\s)(?:cajDown|ty_caj|cajdown)(?:$|\s)/i.test(marker) || /\bCAJ\b/i.test(label);
      if (pdf || caj) add(node.getAttribute("href"), caj ? "caj" : "pdf", node);
    }
    result.status = result.candidates.length ? "pdf_available" : purchase ? "purchase_required" : result.cajAvailable ? "caj_only" : "metadata_only";
    return result;
  }
  function classifyResponse({ status = 200, url, contentType = "", bytes, document }, expected = {}) {
    const target = officialURL(url);
    if (!target) return { status: "unsafe_redirect" };
    const wanted = normalizeRecord(expected.expectedRecord);
    const file = parameter(target, ["filename"]), code = parameter(target, ["dbcode", "dbtype"], databaseCode);
    if (file.conflict || code.conflict || wanted && (file.value && file.value.toUpperCase() !== wanted.filename || code.value && databaseCode(code.value) !== wanted.dbcode)) return { status: "article_mismatch" };
    if (/^(?:pay|mall)\.cnki\.net$/.test(target.hostname)) return { status: "purchase_required" };
    if (/^(?:login|passport)\.cnki\.net$/.test(target.hostname) || status === 401) return { status: "login_required" };
    if (status === 403) return { status: "access_denied" };
    if (status === 429) return { status: "rate_limited" };
    if (status < 200 || status >= 300) return { status: "http_error" };
    const view = bytes instanceof Uint8Array ? bytes : bytes && typeof bytes.byteLength === "number" ? new Uint8Array(bytes) : new Uint8Array();
    const head = String.fromCharCode(...view.subarray(0, 32)).replace(/^\xEF\xBB\xBF/, "").trimStart();
    if (/^%PDF-\d\.\d(?:\s|$)/.test(head)) return { status: "pdf" };
    if (document) return parsePage(document, url, expected);
    if (/^\s*(?:<!doctype\s+html|<html|<head|<body)/i.test(head) || /text\/html/i.test(contentType)) return { status: "html_response" };
    if (/caj/i.test(contentType) || /\.caj$/i.test(target.pathname) || /^CAJ\b/.test(head)) return { status: "caj_only" };
    return { status: "invalid_pdf" };
  }
  function decodeHTML(bytes, type = "", Decoder = root.TextDecoder) {
    const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(type)?.[1] || "utf-8";
    let text;
    try { text = new Decoder(charset).decode(bytes); } catch (_) { text = new Decoder("utf-8").decode(bytes); }
    // Some official legacy Article pages currently declare UTF-8 but serve GB
    // bytes. Only use the alternative when it removes decoding replacements.
    if (text.includes("\uFFFD")) {
      try { const alternate = new Decoder("gb18030").decode(bytes); if ((alternate.match(/\uFFFD/g) || []).length < (text.match(/\uFFFD/g) || []).length) text = alternate; } catch (_) {}
    }
    return text;
  }
  const api = Object.freeze({ normalizeRecord, fromItem, isCNKIURL, safeArticleURL, pageURL, parsePage, classifyResponse, searchURL, decodeHTML });
  root.FulltextCNKI = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
