/* Read-only, local PDF identity checks before an attachment is imported.
 * Zotero 10.0.7's installed xpcom/pdfWorker/manager.js and document-worker/worker.js
 * provide the guarded private adapter below. getFullText(itemID) requires an
 * existing attachment, so it cannot validate an unimported file without writes.
 */
(function (root) {
  "use strict";
  const MAX_PDF_BYTES = 128 * 1024 * 1024;
  const MAX_TEXT = 100000;
  const MAX_FIRST_PAGE = 32000;
  const MAX_TITLE_REGION = 2500;
  const MAX_PAGES = 2;

  function clean(value, limit = 320) {
    return String(value || "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
  }
  function normalizeDOI(value) {
    let doi = String(value || "").normalize("NFKC").trim().replace(/^doi\s*:\s*/i, "");
    doi = doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
    try { doi = decodeURIComponent(doi); } catch (_) { return ""; }
    doi = doi.replace(/[.,;:]+$/, "");
    while (/[)\]}]$/.test(doi)) {
      const close = doi.slice(-1), open = { ")": "(", "]": "[", "}": "{" }[close];
      if (doi.split(close).length <= doi.split(open).length) break;
      doi = doi.slice(0, -1);
    }
    return doi.length <= 2048 && /^10\.\d{4,9}\/[^\s<>"\u0000-\u001f\u007f]+$/i.test(doi) ? doi.toLowerCase() : "";
  }
  function titleKey(value) {
    return String(value || "").normalize("NFKC").replace(/<[^>]*>/g, " ")
      .replace(/\u00ad/g, "").replace(/([\p{L}])[\-\u2010\u2011][ \t]*\n[ \t]*(?=[\p{L}])/gu, "$1")
      .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  }
  function strongTitle(value) {
    const key = titleKey(value);
    return (key.length >= 32 && key.split(" ").length >= 5) || (key.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length >= 16 ? key : "";
  }
  function targetIdentity(target) {
    if (typeof target?.getField === "function") {
      return { doi: normalizeDOI(target.getField("DOI") || target.getExtraField?.("DOI")), title: clean(target.getField("title"), 2000) };
    }
    return { doi: normalizeDOI(target?.doi || target?.DOI), title: clean(target?.title, 2000) };
  }
  function prepareText(value) {
    return String(value || "").slice(0, MAX_TEXT).normalize("NFKC").replace(/\r\n?/g, "\n")
      .replace(/[\u00ad\u200b\u2060\ufeff]/g, "").replace(/[\u2010\u2011]/g, "-");
  }
  function referenceStart(text) {
    const heading = /(?:^|\n)[ \t]*(?:\d+[.)]?[ \t]+)?(?:references|bibliography|literature cited|references and notes|参考文献)[ \t]*[:.]?[ \t]*(?:\n|$|(?=\d+[.)\]]))/im.exec(text);
    return heading ? heading.index : text.length;
  }
  function bodyStart(text) {
    const heading = /(?:^|\n)[ \t]*(?:\d+[.)]?[ \t]+)?(?:abstract|introduction|summary|background|keywords|摘要|引言)(?:\b|[：:])[ \t]*[:.\-–—]?/im.exec(text);
    return heading ? heading.index : text.length;
  }
  function citationLike(value) {
    return /^\s*(?:\[\d{1,3}\]|\d{1,3}[.)])\s*\S/.test(value)
      || /\bet\s+al\.?\b|\(\s*(?:19|20)\d{2}[a-z]?\s*\)/i.test(value)
      || /\b(?:see(?: also)?|cited|citing|cites|references?|previously|reported by|adapted from|reprinted from|original article|correction to|erratum to)\b/i.test(value);
  }
  function titleEvidence(text, expected) {
    const region = text.slice(0, Math.min(bodyStart(text), MAX_TITLE_REGION));
    const lines = region.split("\n");
    const wanted = strongTitle(expected);
    let detectedTitle = "";
    for (let i = 0; i < lines.length; i++) {
      const line = clean(lines[i], 1000);
      const preceding = lines.slice(Math.max(0, i - 2), i).join(" ");
      if (!line || citationLike(line) || citationLike(preceding) || /(?:\bdoi\b|https?:\/\/|^copyright\b|^©)/i.test(line)) continue;
      if (!detectedTitle && line.length <= 320 && strongTitle(line)) detectedTitle = clean(line);
      if (!wanted) continue;
      for (let count = 1; count <= 6 && i + count <= lines.length; count++) {
        const block = lines.slice(i, i + count).join("\n");
        if (block.length > 2400 || citationLike(block)) break;
        // Full title blocks only: a mention embedded in a paragraph is not a title.
        if (titleKey(block) === wanted) return { matched: true, detectedTitle: clean(expected) };
      }
    }
    return { matched: false, detectedTitle };
  }
  function articleDOIs(text) {
    const found = [];
    const frontEnd = Math.min(bodyStart(text), MAX_TITLE_REGION);
    const pattern = /\b10\.\d{4,9}[ \t]*\/[ \t]*[^\s<>"\u0000-\u001f]*/gi;
    for (let match; (match = pattern.exec(text));) {
      let raw = match[0], end = pattern.lastIndex;
      // Join only an explicit DOI line wrap at a structural separator. Never
      // remove real DOI hyphens or join arbitrary prose/author names to a DOI.
      for (let continuation = 0; continuation < 4; continuation++) {
        const next = /^[ \t]*\n[ \t]*([^\s<>"\u0000-\u001f]+)/.exec(text.slice(end));
        if (!next || !/[\/_\-.][ \t]*$/.test(raw) || !/^[A-Za-z0-9(]/.test(next[1])) break;
        // A sentence-final period is not permission to append the next heading.
        if (/\.[ \t]*$/.test(raw) && !/^[a-z0-9._/-]*\d[a-z0-9._/-]*$/i.test(next[1])) break;
        raw += next[1]; end += next[0].length;
      }
      pattern.lastIndex = end;
      const doi = normalizeDOI(raw.replace(/[ \t]/g, ""));
      if (!doi) continue;
      const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
      const lineEnd = text.indexOf("\n", end);
      const prefix = text.slice(lineStart, match.index).trim();
      const suffix = text.slice(end, lineEnd < 0 ? text.length : lineEnd).trim();
      const precedingLines = text.slice(Math.max(0, lineStart - 700), lineStart).trim().split("\n").slice(-2);
      const preceding = precedingLines.join(" ");
      const footer = /(?:©|\bcopyright\b|\ball rights reserved\b|\bpublished by\b|\bcreative commons\b|\blicensed under\b)/i.test(preceding + " " + prefix);
      // Some publishers put the article DOI after a journal/year/volume/pages
      // footer directly beneath their copyright line. The year is metadata,
      // not a citation; require this full narrow structure before exempting it.
      const journalFooter = footer && /^[\p{L}][\p{L} .,&'’\-–]{1,100}\s+\((?:19|20)\d{2}\)\s+\d+(?:\s*\([\w-]+\))?\s*[,;:]\s*\d+\s*[-–—]\s*\d+\s+doi\s*:\s*$/iu.test(prefix)
        && /^[\s.,;:()\[\]{}]*$/.test(suffix);
      // Wiley's older PDFs join submission dates, DOI and publication notice
      // into one paragraph. Require all three plus the nearby copyright line.
      const publicationFooter = /\bReceived\b[^<>]{0,240}\bAccepted\b[^<>]{0,100}\bDOI\s*:?\s*$/i.test(prefix)
        && /^Published online (?:in|at)\b/i.test(suffix)
        && /(?:©|\bcopyright\b)/i.test(text.slice(end, Math.min(text.length, end + 500)));
      const priorLine = precedingLines[precedingLines.length - 1] || "";
      const pageRange = /^[\p{L}][\p{L} .,&'’\-–]{1,100}\s+\((?:19|20)\d{2}\)\s+\d+(?:\s*\([\w-]+\))?\s*[,;:]\s*(\d{1,6})\s*[-–—]\s*(\d{1,6})\b/iu.exec(priorLine);
      // The printed opening page can share the DOI's text line. It is metadata
      // only when the immediately preceding journal/copyright line supplies
      // exactly that opening page; arbitrary numbers after a DOI stay unknown.
      const numberedFooter = !!pageRange && /(?:©|\bcopyright\b)/i.test(priorLine)
        && /^(?:doi\s*:\s*|https?:\/\/(?:dx\.)?doi\.org\/)?$/i.test(prefix)
        && /^\d{1,6}$/.test(suffix) && Number(suffix) === Number(pageRange[1]);
      if ((!journalFooter && citationLike(prefix)) || (!numberedFooter && citationLike(preceding))) continue;
      const standalone = /^(?:(?:digital object identifier|doi)[ \t]*:[ \t]*|(?:https?:\/\/)?(?:dx\.)?doi\.org\/)?$/i.test(prefix)
        && /^[\s.,;:()\[\]{}]*$/.test(suffix);
      const header = match.index < frontEnd && prefix.length < 220
        && /(?:^|\s)doi[ \t]*:[ \t]*$/i.test(prefix) && suffix.length < 100;
      if (((standalone && (match.index < frontEnd || footer)) || header || journalFooter || publicationFooter || numberedFooter) && !found.includes(doi)) found.push(doi);
      if (found.length === 8) break;
    }
    return found;
  }
  const descriptions = {
    doi_match: "PDF 首页的文献 DOI 与目标条目一致。",
    title_match: "PDF 首页的完整标题与目标条目一致，未发现冲突的文献 DOI。",
    doi_mismatch: "PDF 首页的文献 DOI 与目标条目不同，已阻止导入。",
    conflicting_dois: "PDF 首页存在多个可能的文献 DOI，无法可靠确认身份。",
    insufficient_identity: "未找到足够可靠的首页 DOI 或完整标题，需人工核对 PDF。",
    title_outside_front_matter: "在首页后续版面或参考文献区域发现目标标题，但无法确认它是本文标题。请预览候选 PDF 后人工核对。",
    no_text: "PDF 未提取到可核验文字，可能是扫描件或受保护文件，需人工核对。",
    target_missing: "目标条目缺少可核验的 DOI 或完整标题，需人工核对。",
    extraction_unavailable: "当前 Zotero 的 PDF 提取接口不可用，需人工核对 PDF。",
    extraction_failed: "PDF 文字提取未完成，需人工核对文件。",
    file_too_large: "PDF 超过 128 MiB，未自动核验身份。",
    invalid_file: "所选文件无法作为本地 PDF 读取。"
  };
  function result(status, reason, target, evidence = {}) {
    return {
      status, reason, message: descriptions[reason], summary: descriptions[reason],
      matchedBy: status === "match" ? reason === "doi_match" ? "doi" : "title" : "",
      expectedDOI: target.doi, detectedDOIs: (evidence.dois || []).slice(0, 8),
      detectedTitle: clean(evidence.detectedTitle),
    };
  }
  function classify(extracted, target) {
    const text = prepareText(typeof extracted === "string" ? extracted : extracted?.text);
    if (!/[\p{L}\p{N}]/u.test(text)) return result("unknown", "no_text", target);
    // Second-page citations can never establish the document's identity.
    const firstPage = text.split("\f", 1)[0].slice(0, MAX_FIRST_PAGE);
    const front = firstPage.slice(0, referenceStart(firstPage));
    const title = titleEvidence(front, target.title), dois = articleDOIs(front);
    const evidence = { dois, detectedTitle: title.detectedTitle };
    if (dois.length > 1) return result("unknown", "conflicting_dois", target, evidence);
    if (target.doi && dois.length === 1) {
      return result(dois[0] === target.doi ? "match" : "mismatch", dois[0] === target.doi ? "doi_match" : "doi_mismatch", target, evidence);
    }
    if (title.matched) return result("match", "title_match", target, evidence);
    const wanted = strongTitle(target.title);
    if (wanted && (" " + titleKey(firstPage) + " ").includes(" " + wanted + " ")) return result("unknown", "title_outside_front_matter", target, evidence);
    return result("unknown", "insufficient_identity", target, evidence);
  }
  function taggedError(code) { const error = new Error(code); error.code = code; return error; }
  function checkBytes(bytes) {
    if (!ArrayBuffer.isView(bytes) || bytes.BYTES_PER_ELEMENT !== 1 || !bytes.byteLength) throw taggedError("invalid_file");
    if (bytes.byteLength > MAX_PDF_BYTES) throw taggedError("file_too_large");
    return bytes;
  }
  function create({ Zotero, IOUtils, extractText } = {}) {
    const extractor = extractText || (async (path, options) => {
      const worker = Zotero?.PDFWorker;
      if (typeof worker?._enqueue !== "function" || typeof worker?._query !== "function") throw taggedError("extraction_unavailable");
      let bytes = options.bytes;
      if (!bytes) {
        if (typeof path !== "string" || !path || typeof IOUtils?.read !== "function" || typeof IOUtils?.stat !== "function") throw taggedError("invalid_file");
        const stat = await IOUtils.stat(path);
        if (stat.type && stat.type !== "regular") throw taggedError("invalid_file");
        if (stat.size > MAX_PDF_BYTES) throw taggedError("file_too_large");
        bytes = await IOUtils.read(path);
      }
      checkBytes(bytes);
      // The caller imports these exact bytes after verification. Transfer an
      // independent copy so the worker cannot detach or mutate that snapshot.
      const buf = new Uint8Array(bytes).buffer;
      return worker._enqueue(() => worker._query("pdf.getFulltext", { buf, maxPages: MAX_PAGES }, [buf]), false);
    });
    return {
      async inspect(path, taskOrItem, { bytes } = {}) {
        let target;
        try { target = targetIdentity(taskOrItem); }
        catch (_) { target = { doi: "", title: "" }; }
        if (!target.doi && !strongTitle(target.title)) return result("unknown", "target_missing", target);
        try {
          if (bytes !== undefined) checkBytes(bytes);
          const extracted = await extractor(path, { maxPages: MAX_PAGES, bytes });
          return classify(extracted, target);
        }
        catch (error) {
          const reason = Object.hasOwn(descriptions, error?.code) ? error.code : "extraction_failed";
          return result("unknown", reason, target);
        }
      }
    };
  }
  const api = { create, MAX_PDF_BYTES };
  root.FulltextPDFIdentity = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
