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
    // Some embedded PDF fonts expose the base Latin letter but omit its accent
    // even though the rendered glyph is correct. Whole-title comparison can
    // tolerate that orthographic loss; DOI identity remains exact.
    return String(value || "").normalize("NFKD").replace(/([\p{Script=Latin}])\p{M}+/gu, "$1").replace(/<[^>]*>/g, " ")
      .replace(/\u00ad/g, "").replace(/([\p{L}])[\-\u2010\u2011][ \t]*\n[ \t]*(?=[\p{L}])/gu, "$1")
      .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  }
  function strongTitle(value) {
    const key = titleKey(value);
    return (key.length >= 32 && key.split(" ").length >= 5) || (key.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length >= 16 ? key : "";
  }
  function titleDisplay(value) {
    return clean(String(value || "").replace(/([\p{L}])[-\u2010\u2011][ \t]*\n[ \t]*(?=[\p{L}])/gu, "$1"));
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
    const heading = /(?:^|\n)[ \t]*(?:\d+[.)]?[ \t]+)?(?:(?:abstract|introduction|summary|background|keywords|摘要|引言)(?:\b|[：:])|(?:graphical abstract|highlights|authors|correspondence|in brief)(?:[ \t]*[:：]|[ \t]*[.\-–—]?[ \t]*(?=\n|$)))/im.exec(text);
    return heading ? heading.index : text.length;
  }
  function citationLike(value) {
    return /^\s*(?:\[\d{1,3}\]|\d{1,3}[.)])\s*\S/.test(value)
      || /\bet\s+al\.?\b|\(\s*(?:19|20)\d{2}[a-z]?\s*\)/i.test(value)
      || /\b(?:see(?: also)?|cited|citing|cites|references?|previously|reported by|adapted from|reprinted from|original article|correction to|erratum to)\b/i.test(value);
  }
  function articleLabel(value) {
    return /^(?:short article|research articles?(?: summary)?|original article|original research|article|report|research report|research paper|brief communication|letter|review|opinion)$/i.test(clean(value));
  }
  function journalLike(value) {
    return /\b(?:journal of|proceedings of|transactions of|issn|eissn|volume\s+\d|vol\.\s*\d)\b|^(?:received|accepted|published|available online|open access|research gate)\b/i.test(value);
  }
  function similarity(a, b) {
    const joinedHyphens = value => titleKey(String(value || "").replace(/([\p{L}])[-\u2010\u2011](?=[\p{L}])/gu, "$1"));
    const joinedA = joinedHyphens(a), joinedB = joinedHyphens(b);
    if (joinedA && joinedA === joinedB) return 1;
    a = titleKey(a); b = titleKey(b);
    if (!a || !b) return null;
    if (a === b) return 1;
    const stop = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to", "with"]);
    const words = value => new Set(value.split(" ").filter(word => word.length > 1 && !stop.has(word)));
    const left = words(a), right = words(b);
    const common = [...left].filter(word => right.has(word)).length;
    const lexical = left.size + right.size ? 2 * common / (left.size + right.size) : 0;
    const grams = value => new Set(Array.from({ length: Math.max(0, value.length - 2) }, (_, i) => value.slice(i, i + 3)));
    const x = grams(a), y = grams(b), shared = [...x].filter(gram => y.has(gram)).length;
    const character = x.size + y.size ? 2 * shared / (x.size + y.size) : 0;
    return Math.round((lexical * 0.75 + character * 0.25) * 1000) / 1000;
  }
  function titleEvidence(text, expected) {
    const region = text.slice(0, Math.min(bodyStart(text), MAX_TITLE_REGION));
    const lines = region.split("\n");
    const wanted = strongTitle(expected);
    let detectedTitle = "", reliable = false;
    for (let i = 0; i < lines.length; i++) {
      const line = clean(lines[i], 1000);
      const preceding = lines.slice(Math.max(0, i - 2), i).join(" ");
      if (!line || citationLike(line) || citationLike(preceding) || journalLike(line) || /(?:\bdoi\b|https?:\/\/|^copyright\b|^©)/i.test(line)) continue;
      if (line.length <= 320 && strongTitle(line)) {
        const previous = lines.slice(0, i).filter(value => value.trim()).slice(-1)[0] || "";
        const next = clean(lines[i + 1] || "");
        const beforeBody = !lines.slice(i + 1).some(value => value.trim()) && bodyStart(text) < text.length;
        const authorLine = /^[A-Z][\p{L}'’\-]+(?:\s+(?:[A-Z]\.\s*)?[A-Z][\p{L}'’\-]+){1,3}$/u.test(next);
        const continued = /(?:\b(?:of|and|the|in|on|for|with|by|to|a|an)|[-–])$/i.test(line);
        const lineReliable = !continued && (articleLabel(previous) || beforeBody || authorLine);
        if (!detectedTitle || !reliable && lineReliable) { detectedTitle = clean(line);reliable = lineReliable; }
      }
      if (!wanted) continue;
      for (let count = 1; count <= 6 && i + count <= lines.length; count++) {
        const block = lines.slice(i, i + count).join("\n");
        if (block.length > 2400 || citationLike(block) || journalLike(block)) break;
        // Full title blocks only: a mention embedded in a paragraph is not a title.
        if (titleKey(block) === wanted) return { matched: true, detectedTitle: titleDisplay(block), reliable: true, similarity: 1 };
      }
    }
    return { matched: false, detectedTitle, reliable, similarity: similarity(detectedTitle, expected) };
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
      const copyright = value => /(?:©|\bcopyright\b|\ball rights reserved\b|\bpublished by\b|\bcreative commons\b|\blicensed under\b)/i.test(value)
        || /\b((?:19|20)\d{2})\s+ª\s+\1\b/.test(value);
      const footer = copyright(preceding + " " + prefix);
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
      const standalone = /^(?:(?:digital object identifier|doi)[ \t]*:[ \t]*|(?:https?:\/\/)?(?:dx\.)?doi\.org\/)?$/i.test(prefix)
        && /^[\s.,;:()\[\]{}]*$/.test(suffix);
      // Geometry-preserving extraction keeps a publisher's citation, copyright
      // and standalone DOI on separate lines. A preceding author "et al." is
      // then harmless only when the immediate line carries copyright evidence.
      const publisherFooter = standalone && copyright(priorLine);
      // Copyright can accompany a quoted/reprinted work too. It never overrides
      // an explicit attribution/correction context; only plain author et al.
      // in the publisher's own citation can receive the narrow footer exception.
      if (/\b(?:see(?: also)?|cited|citing|cites|references?|previously|reported by|adapted from|reprinted from|original article|correction to|erratum to)\b/i.test(prefix + " " + preceding)) continue;
      if ((!journalFooter && citationLike(prefix)) || (!numberedFooter && !publisherFooter && citationLike(preceding))) continue;
      const header = match.index < frontEnd && prefix.length < 220
        && /(?:^|\s)doi[ \t]*:[ \t]*$/i.test(prefix) && suffix.length < 100;
      if (((standalone && (match.index < frontEnd || footer)) || header || journalFooter || publicationFooter || numberedFooter || publisherFooter) && !found.includes(doi)) found.push(doi);
      if (found.length === 8) break;
    }
    return found;
  }
  function geometryFirstPage(recognized) {
    // getRecognizerData's installed worker contract preserves actual PDF lines
    // and char.u. Metadata Title/DOI is intentionally ignored: it can be stale.
    const page = recognized?.pages?.[0];
    if (!Array.isArray(page) || !Number.isFinite(page[0]) || !Number.isFinite(page[1]) || page[0] <= 0 || page[1] <= 0) return { text: "", lines: [] };
    const rows = [], layout = [];let visited = 0, characters = 0;
    const isWord = word => Array.isArray(word) && word.length >= 14 && typeof word[13] === "string"
      && word[13].length <= 2000 && word.slice(0, 5).every(Number.isFinite) && word[4] > 0
      && word[0] >= -20 && word[1] >= -20 && word[2] >= word[0] && word[3] >= word[1]
      && word[2] <= page[0] + 20 && word[3] <= page[1] + 20;
    function visit(node, depth) {
      if (!Array.isArray(node) || depth > 12 || ++visited > 50000 || characters > MAX_FIRST_PAGE) return;
      if (node.length && node.every(isWord)) {
        let row = "", previous = null, segment = [];
        function emit() {
          if (!row.trim()) return;
          const fonts = segment.map(word => word[4]).sort((a, b) => a - b);
          rows.push(row.trim());characters += row.length;
          layout.push({ text: row.trim(), x: Math.min(...segment.map(word => word[0])), right: Math.max(...segment.map(word => word[2])),
            y: Math.min(...segment.map(word => word[1])), bottom: Math.max(...segment.map(word => word[3])), font: fonts[Math.floor(fonts.length / 2)] });
          row = "";segment = [];
        }
        for (const word of node) {
          if (characters + row.length > MAX_FIRST_PAGE) break;
          // Widely separated or differently sized marks (logos/page numbers)
          // must not become a DOI suffix merely because the PDF groups them.
          const gap = previous ? word[0] - previous[2] : 0;
          const separate = previous && (gap > Math.max(24, Math.min(word[4], previous[4]) * 3)
            || gap > 5 && Math.max(word[4], previous[4]) / Math.min(word[4], previous[4]) > 1.6);
          if (separate && row.trim()) emit();
          row += word[13] + (word[5] ? " " : "");segment.push(word);previous = word;
        }
        emit();
        return;
      }
      for (const child of node) visit(child, depth + 1);
    }
    visit(page[2], 0);
    // NFC preserves the ordinal copyright glyph some fonts map to U+00AA;
    // NFKC would lose that evidence by reducing it to the ordinary letter a.
    return { text: rows.join("\n").slice(0, MAX_FIRST_PAGE).normalize("NFC").replace(/[\u00ad\u200b\u2060\ufeff]/g, ""), lines: layout, width: page[0], height: page[1] };
  }
  function geometryTitleEvidence(geometry, expected) {
    const fallback = titleEvidence(geometry.text.slice(0, referenceStart(geometry.text)), expected);
    if (!geometry.lines.length) return fallback;
    const end = Math.min(bodyStart(geometry.text), referenceStart(geometry.text), MAX_TITLE_REGION);
    const fonts = geometry.lines.filter(line => line.text.length > 20).map(line => line.font).sort((a, b) => a - b);
    const bodyFont = fonts[Math.floor(fonts.length / 2)] || 10;
    const candidates = [];let offset = 0;
    const rows = geometry.lines.map(line => { const row = { ...line, offset };offset += line.text.length + 1;return row; });
    const eligible = row => row && row.offset < end && row.y >= geometry.height * 0.05 && row.y < geometry.height * 0.5
      && !articleLabel(row.text) && !journalLike(row.text) && !citationLike(row.text)
      && !/(?:https?:\/\/|\bdoi\b|@|^copyright\b|^©|^\d+[.)])/i.test(row.text);
    for (let i = 0; i < rows.length && i < 50; i++) {
      const first = rows[i];if (!eligible(first)) continue;
      const labelled = articleLabel(rows[i - 1]?.text || "");
      if (first.font < 10 || first.font < bodyFont * 1.15) continue;
      const group = [first];let last = first;
      const adjacent = row => eligible(row) && Math.abs(row.font - first.font) / first.font < 0.12
        && row.y >= last.y + last.font * 0.4 && row.y - last.bottom <= first.font * 1.5
        && (Math.abs(row.x - first.x) <= first.font * 3 || Math.abs((row.x + row.right) - (first.x + first.right)) <= geometry.width * 0.3);
      let next = i + 1;
      while (group.length < 6 && adjacent(rows[next])) { last = rows[next++];group.push(last); }
      if (group.length === 6 && adjacent(rows[next])) continue;
      const block = group.map(row => row.text).join("\n"), title = clean(block, 2000);
      if (title.length > 320 || !strongTitle(block) || citationLike(block) || journalLike(block)) continue;
      // A large title block must be visually bounded. An undifferentiated page
      // of large text is not permission to call its first paragraph a title.
      const following = rows[next];
      const bounded = following && (following.font < first.font * 0.9 || !eligible(following) || following.y - last.bottom > first.font * 1.5);
      if (!bounded && !labelled) continue;
      candidates.push({ text: titleDisplay(block), raw: block, font: first.font, index: i });i = next - 1;
    }
    candidates.sort((a, b) => b.font - a.font || a.index - b.index);
    if (!candidates.length) return fallback;
    const selected = candidates[0], matched = !!strongTitle(expected) && titleKey(selected.raw) === strongTitle(expected);
    return { matched, detectedTitle: selected.text, reliable: true, similarity: similarity(selected.raw, expected) };
  }
  const descriptions = {
    doi_match: "PDF 首页的文献 DOI 与目标条目一致。",
    title_match: "PDF 首页的完整标题与目标条目一致，未发现冲突的文献 DOI。",
    doi_mismatch: "PDF 首页的文献 DOI 与目标条目不同，已阻止导入。",
    conflicting_dois: "PDF 首页存在多个可能的文献 DOI，无法可靠确认身份。",
    conflicting_identity: "PDF 首页的 DOI 与标题证据相互冲突，需人工核对 PDF。",
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
      related: evidence.related === true, candidateScore: evidence.candidateScore || 0,
      titleSimilarity: Number.isFinite(evidence.titleSimilarity) ? evidence.titleSimilarity : null,
      evidence: {
        extractionSucceeded: evidence.extractionSucceeded === true,
        firstPageCharacterCount: evidence.firstPageCharacterCount || 0,
        extractedPages: Number.isInteger(evidence.extractedPages) && evidence.extractedPages >= 0 ? evidence.extractedPages : null,
        totalPages: Number.isInteger(evidence.totalPages) && evidence.totalPages >= 0 ? evidence.totalPages : null,
        titleReliable: evidence.titleReliable === true, doiReliable: (evidence.dois || []).length > 0,
        identityConflict: evidence.identityConflict === true,
        candidateBasis: evidence.candidateBasis || [reason === "no_text" ? "no_extractable_text" : reason === "target_missing" ? "no_reliable_identity" : "extraction_failed"],
      },
    };
  }
  function classify(extracted, target) {
    const text = prepareText(typeof extracted === "string" ? extracted : extracted?.text);
    const geometry = geometryFirstPage(extracted?.recognized), geometric = geometry.text;
    const initialEvidence = { extractionSucceeded: true, extractedPages: extracted?.extractedPages, totalPages: extracted?.totalPages,
      firstPageCharacterCount: (geometric || text.split("\f", 1)[0]).slice(0, MAX_FIRST_PAGE).replace(/\s/g, "").length };
    if (!/[\p{L}\p{N}]/u.test(text + geometric)) return result("unknown", "no_text", target, initialEvidence);
    // Second-page citations can never establish the document's identity.
    const firstPage = text.split("\f", 1)[0].slice(0, MAX_FIRST_PAGE);
    const front = firstPage.slice(0, referenceStart(firstPage));
    const geometryFront = geometric.slice(0, referenceStart(geometric));
    const plainTitle = titleEvidence(front, target.title), geometryTitle = geometryTitleEvidence(geometry, target.title);
    const title = geometryTitle.reliable || geometryTitle.matched || !plainTitle.detectedTitle && geometryTitle.detectedTitle ? geometryTitle : plainTitle;
    const dois = [...new Set([...articleDOIs(front), ...articleDOIs(geometryFront)])].slice(0, 8);
    const evidence = { ...initialEvidence, dois, detectedTitle: title.detectedTitle, titleReliable: title.reliable,
      titleSimilarity: title.similarity, candidateBasis: [], related: false, candidateScore: 0 };
    const matchingDOI = !!target.doi && dois.includes(target.doi);
    if (dois.length && target.doi) evidence.candidateBasis.push(matchingDOI ? "article_doi_match" : "article_doi_mismatch");
    if (title.matched) evidence.candidateBasis.push("front_title_match");
    else if (title.reliable && title.similarity !== null) evidence.candidateBasis.push(title.similarity >= 0.65 ? "front_title_similar" : "front_title_different");
    const conflict = dois.length === 1 && !!target.doi && (matchingDOI && title.reliable && title.similarity !== null && title.similarity < 0.9
      || !matchingDOI && title.reliable && title.similarity >= 0.9);
    if (conflict || dois.length > 1) {
      evidence.identityConflict = true;evidence.candidateBasis.push("identity_conflict");
      evidence.related = matchingDOI || title.reliable && title.similarity >= 0.9;evidence.candidateScore = evidence.related ? 0.7 : 0;
      return result("unknown", dois.length > 1 ? "conflicting_dois" : "conflicting_identity", target, evidence);
    }
    if (target.doi && dois.length === 1) {
      evidence.related = matchingDOI;evidence.candidateScore = matchingDOI ? 1 : 0;
      return result(dois[0] === target.doi ? "match" : "mismatch", dois[0] === target.doi ? "doi_match" : "doi_mismatch", target, evidence);
    }
    if (title.matched) { evidence.related = true;evidence.candidateScore = 1;return result("match", "title_match", target, evidence); }
    if (title.reliable && title.similarity >= 0.65) { evidence.related = true;evidence.candidateScore = Math.round(title.similarity * 0.8 * 1000) / 1000; }
    const wanted = strongTitle(target.title);
    if (wanted && (" " + titleKey(firstPage) + " ").includes(" " + wanted + " ")) {
      evidence.candidateBasis.push("title_outside_front_matter");return result("unknown", "title_outside_front_matter", target, evidence);
    }
    if (!evidence.candidateBasis.length) evidence.candidateBasis.push("no_reliable_identity");
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
      const buf = new Uint8Array(bytes).buffer, geometryBuf = new Uint8Array(bytes).buffer;
      return worker._enqueue(async () => {
        const extracted = await worker._query("pdf.getFulltext", { buf, maxPages: MAX_PAGES }, [buf]);
        // This installed read-only capability has a fixed five-page bound. We
        // use only page one and never load an external PDF/recognition engine.
        // Unsupported/failed geometry does not discard a successful extraction.
        try {
          const recognized = await worker._query("pdf.getRecognizerData", { buf: geometryBuf }, [geometryBuf]);
          return { ...(typeof extracted === "string" ? { text: extracted } : extracted), recognized };
        } catch (_) { return extracted; }
      }, false);
    });
    const cache = new WeakMap(), order = [];let cacheBytes = 0, cacheID = 0;
    const sameBytes = (a, b) => a.byteLength === b.byteLength && a.every((value, index) => value === b[index]);
    async function extract(path, bytes) {
      if (!bytes || typeof WeakRef !== "function" || bytes.byteLength > 8 * 1024 * 1024) return extractor(path, { maxPages: MAX_PAGES, bytes });
      const prior = cache.get(bytes);
      if (prior && sameBytes(prior.snapshot, bytes)) return prior.promise;
      // Bounded per-instance single-flight/result reuse across targets sharing
      // the same snapshot. A mutated/reused Uint8Array cannot reuse an identity.
      while (order.length && (order.length >= 4 || cacheBytes + bytes.byteLength > 16 * 1024 * 1024 || !order[0].ref.deref())) {
        const removed = order.shift(), key = removed.ref.deref();cacheBytes -= removed.size;
        if (key && cache.get(key)?.id === removed.id) cache.delete(key);
      }
      const entry = { id: ++cacheID, snapshot: new Uint8Array(bytes), promise: null };
      entry.promise = Promise.resolve().then(() => extractor(path, { maxPages: MAX_PAGES, bytes }));
      cache.set(bytes, entry);order.push({ ref: new WeakRef(bytes), id: entry.id, size: bytes.byteLength });cacheBytes += bytes.byteLength;
      try { return await entry.promise; }
      catch (error) { if (cache.get(bytes) === entry) cache.delete(bytes);throw error; }
    }
    return {
      async inspect(path, taskOrItem, { bytes } = {}) {
        let target;
        try { target = targetIdentity(taskOrItem); }
        catch (_) { target = { doi: "", title: "" }; }
        if (!target.doi && !strongTitle(target.title)) return result("unknown", "target_missing", target);
        try {
          if (bytes !== undefined) checkBytes(bytes);
          const extracted = await extract(path, bytes);
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
