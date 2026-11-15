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
      || /^\/Article\/[A-Z0-9_]+-[A-Z0-9_.-]+\.htm$/i.test(url.pathname) || !!readerRoute(url);
  }
  function readerRoute(url) {
    if (url.hostname === "ix.cnki.net" && url.pathname === "/read/article/readonline") return "ix";
    if (url.hostname === "x.cnki.net" && url.pathname === "/web/xmlRead/pdf.html") return "x";
    return "";
  }
  function readerURL(record, source) {
    const route = readerRoute(source);
    if (!route || !record.dbname) return null;
    const app = parameter(source, ["appid"], value => value), type = parameter(source, ["filesourcetype"], value => value), page = parameter(source, ["pagetype"], value => value);
    // These are the nonsecret routing values observed in the official reader
    // and its redirect. Never preserve session keys or invent another route.
    if (app.conflict || type.conflict || page.conflict || app.value && app.value !== "CRSP_BASIC_PSMC"
        || type.value && type.value !== "1" || page.value && page.value !== "pdfweb" || route === "x" && page.value !== "pdfweb") return null;
    const url = new URL(source.origin + source.pathname);
    if (route === "x") url.searchParams.set("pageType", "pdfweb");
    url.searchParams.set(route === "x" ? "dbCode" : "dbcode", record.dbcode);
    url.searchParams.set(route === "x" ? "tableName" : "tablename", record.dbname);
    url.searchParams.set(route === "x" ? "fileName" : "filename", record.filename);
    if (type.value) url.searchParams.set("fileSourceType", type.value);
    if (app.value) url.searchParams.set(route === "x" ? "appId" : "appid", app.value);
    return url.href;
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
      const code = parameter(url, ["dbcode"], databaseCode), name = parameter(url, ["dbname", "tablename"]), file = parameter(url, ["filename"]);
      if (code.conflict || name.conflict || file.conflict) return null;
      if (readerRoute(url) && (!code.value || !name.value || !file.value)) return null;
      result = fields(code.value, name.value, file.value);
    }
    if (!result) return null;
    if (article) result.url = url.origin + "/Article/" + result.dbname + "-" + result.filename + ".htm";
    else if (readerRoute(url)) { result.url = readerURL(result, url); if (!result.url) return null; }
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
    const record = recordFromURL(url.href);
    const hasIdentity = [...url.searchParams.keys()].some(key => ["filename", "dbcode", "dbname", "tablename"].includes(key.toLowerCase()));
    if (readerRoute(url)) return record?.url || null;
    return hasIdentity && !record ? null : url.href;
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
  function inputDOI(value) {
    const text = String(value || "").trim().replace(/^doi\s*:\s*/i, "");
    return /^10\.\d{4,9}\/[^\s<>"?#\\]{1,1800}$/i.test(text) ? text.toLowerCase() : "";
  }
  function resolverURL(value) {
    try {
      const url = new URL(String(value || "").trim());
      if (url.protocol !== "https:" || url.username || url.password || url.port || url.href.length > 8192) return null;
      let raw = "", address;
      if (url.hostname === "doi.org" && !url.search) {
        raw = decodeURIComponent(url.pathname.slice(1));
        address = "https://doi.org/";
      } else if (url.hostname === "www.chndoi.org" && url.pathname === "/Resolution/Handler") {
        const values = [...url.searchParams];
        if (values.length !== 1 || values[0][0] !== "doi") return null;
        raw = values[0][1]; address = "https://www.chndoi.org/Resolution/Handler?doi=";
      } else if (["link.cnki.net", "link.oversea.cnki.net"].includes(url.hostname) && url.pathname.startsWith("/doi/") && !url.search) {
        raw = decodeURIComponent(url.pathname.slice(5)); address = url.origin + "/doi/";
      } else return null;
      const paperDOI = inputDOI(raw);
      if (!paperDOI || raw !== raw.trim() || /^doi\s*:/i.test(raw)) return null;
      // Escaping the suffix prevents DOI characters from becoming URL syntax.
      const encoded = encodeURIComponent(paperDOI).replace(/%2F/gi, "/");
      return { doi: paperDOI, url: address + (url.hostname === "www.chndoi.org" ? encodeURIComponent(paperDOI) : encoded) };
    } catch (_) { return null; }
  }
  function normalizeInput(value) {
    const text = String(value || "").trim();
    if (!text || text.length > 8192 || /[\u0000-\u001F\u007F]/.test(text)) return null;
    const resolved = resolverURL(text);
    if (resolved) return { kind: "doi", value: resolved.doi, ...resolved };
    const paperDOI = inputDOI(text);
    if (paperDOI) return { kind: "doi", value: paperDOI, doi: paperDOI, url: resolverURL("https://doi.org/" + encodeURIComponent(paperDOI).replace(/%2F/gi, "/")).url };
    const address = pageURL(text);
    if (address) return { kind: "url", value: address, url: address };
    if (/^(?:[a-z][a-z0-9+.-]*:\/\/|(?:https?|file|data|javascript|doi):|www\.)/i.test(text) || /^10\.\d+\//.test(text) || text.length > 2000) return null;
    const title = clean(text);
    return title ? { kind: "title", value: title, title } : null;
  }
  function parseDOIResolver(doc, address, expectedDOI) {
    const source = resolverURL(address), wanted = inputDOI(expectedDOI);
    if (!source || !wanted || source.doi !== wanted || new URL(source.url).hostname !== "www.chndoi.org" || !doc?.querySelectorAll) return null;
    const region = doc.querySelector(".feedbackresult .fbBd");
    if (!region) return null;
    const values = { doi: [], title: [], authors: [] };
    for (const row of region.querySelectorAll("tr")) {
      const label = row.querySelector("td label");
      if (!label) continue;
      const key = nodeText(label, 100).replace(/[:：\s]/g, "").toLowerCase();
      const field = key === "doi码" || key === "doi" ? "doi" : key === "题名" ? "title" : key === "作者" ? "authors" : "";
      if (!field) continue;
      const cell = label.parentElement.cloneNode(true);
      for (const element of cell.querySelectorAll("label")) element.remove();
      const value = nodeText(cell, field === "title" ? 2000 : 4000);
      if (value) values[field].push(value);
    }
    if (!values.doi.length || values.doi.some(value => inputDOI(value) !== wanted) || new Set(values.title).size > 1) return null;
    const links = [];
    for (const node of region.querySelectorAll("a[href]")) {
      const link = resolverURL(node.getAttribute("href"));
      if (!link || link.doi !== wanted || !["link.cnki.net", "link.oversea.cnki.net"].includes(new URL(link.url).hostname)) continue;
      if (!links.includes(link.url) && links.length < LIMIT) links.push(link.url);
    }
    if (!links.length) return null;
    const authors = [...new Set(values.authors.flatMap(value => value.split(/[;；、]/)).map(value => clean(value, 300)).filter(Boolean))].slice(0, 100);
    return { doi: wanted, title: values.title[0] || "", authors, links };
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
  function hidden(doc, names) {
    const wanted = new Set((Array.isArray(names) ? names : [names]).map(value => value.toLowerCase()));
    return [...doc.querySelectorAll("input")].filter(node => [node.id, node.getAttribute("name")].some(value => wanted.has(String(value || "").toLowerCase())))
      .map(node => clean(node.getAttribute("value"), 160)).filter(Boolean);
  }
  function pageRecord(doc, url) {
    const file = hidden(doc, ["hidfilename", "param-filename"]), code = hidden(doc, ["hiddbcode", "paramdbcode"]), name = hidden(doc, "hiddbname");
    if ([file, name].some(values => new Set(values.map(value => value.toUpperCase())).size > 1) || new Set(code.map(databaseCode)).size > 1) return { conflict: true };
    const location = recordFromURL(url);
    const visible = file.length ? fields(code[0] || location?.dbcode, name[0] || location?.dbname, file[0]) : null;
    const suppliedIdentity = [...new URL(url).searchParams.keys()].some(key => ["filename", "dbcode", "dbname", "tablename"].includes(key.toLowerCase()));
    if (suppliedIdentity && !location) return { conflict: true };
    if (file.length && !visible || visible && location && visible.id !== location.id
        || location && code.length && databaseCode(code[0]) !== location.dbcode
        || name.length && !fields(code[0] || location?.dbcode, name[0], file[0] || location?.filename)) return { conflict: true };
    const record = visible || location;
    return { conflict: false, record: record ? { ...record, url: location?.url || stableURL(record, new URL(url).hostname) } : null };
  }
  function metadata(doc, record, address) {
    const first = names => metaValues(doc, names)[0] || "";
    const heading = doc.querySelector(".wx-tit h1 .title-one,h1 .title-one,.wx-tit h1,h1.xx_title,h1");
    const title = first(["citation_title", "dc.title"]) || nodeText(heading);
    let authors = metaValues(doc, ["citation_author"]);
    const authorNodes = doc.querySelectorAll("#authorpart a");
    if (!authors.length) authors = [...(authorNodes.length ? authorNodes : doc.querySelectorAll(".author a,.authors a"))]
      .filter(node => !/\/organ\/detail(?:[/?#]|$)/i.test(node.getAttribute("href") || "")).map(node => nodeText(node, 300)).filter(Boolean);
    if (!authors.length && heading?.matches("h1.xx_title")) authors = [...(heading.parentElement?.nextElementSibling?.querySelectorAll('a[href*="author="]') || [])].map(node => nodeText(node, 300)).filter(Boolean);
    let paperDOI = doi(first(["citation_doi", "dc.identifier"]));
    if (!paperDOI) paperDOI = doi(nodeText(doc.querySelector("#DOI,#doi")));
    const date = first(["citation_publication_date", "citation_date", "dc.date"]);
    const itemType = TYPES[record?.dbcode] || (/^https:\/\/cdmd\.cnki\.com\.cn\/Article\/CDMD-/i.test(address) || hidden(doc, "paramresource").includes("DISSERTATION") ? "thesis" : "journalArticle");
    const university = itemType === "thesis" ? first(["citation_dissertation_institution"]) || nodeText(doc.querySelector('.wx-tit .author a[href*="/organ/detail"]'), 500) : "";
    return { title: clean(title), doi: paperDOI, authors: [...new Set(authors)].slice(0, 100),
      abstract: first(["citation_abstract"]) || nodeText(doc.querySelector("#ChDivSummary,.abstract-text"), 20000),
      journal: first(["citation_journal_title"]), date: clean(date, 100),
      volume: first(["citation_volume"]), issue: first(["citation_issue"]),
      pages: [first(["citation_firstpage"]), first(["citation_lastpage"])].filter(Boolean).join("-"),
      issn: first(["citation_issn"]), isbn: first(["citation_isbn"]),
      keywords: [...new Set(metaValues(doc, ["citation_keywords", "keywords"]).flatMap(value => value.split(/[;,；，]|\s{2,}/).map(value => clean(value, 200)).filter(Boolean)))].slice(0, 40),
      university: clean(university, 500), itemType };
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
    if (!info.title || info.title.includes("\uFFFD") || readerRoute(url) && info.title === "研学阅读") { result.status = "metadata_unavailable"; return result; }
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
      const explicitPDF = /^(?:PDF|PDF下载|下载PDF|Download PDF|Full Text PDF)$/i.test(label) || node.closest("#DownLoadParts") && /\bPDF\b/i.test(label);
      const pdf = explicitPDF || /(?:^|\s)(?:pdfDown|ty_pdf|pdfdown)(?:$|\s)/i.test(marker);
      const caj = /\bCAJ\b/i.test(label) || !explicitPDF && /(?:^|\s)(?:cajDown|ty_caj|cajdown)(?:$|\s)/i.test(marker);
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
  const api = Object.freeze({ normalizeRecord, normalizeInput, resolverURL, parseDOIResolver, fromItem, isCNKIURL, safeArticleURL, pageURL, parsePage, classifyResponse, searchURL, decodeHTML });
  root.FulltextCNKI = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
