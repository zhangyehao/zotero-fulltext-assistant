/* Publisher DOM discovery uses Zotero's default cookie context, never external browsers. */
(function (global) {
  "use strict";
  const MAX_PDF_BYTES = 100 * 1024 * 1024;
  const MIN_PDF_BYTES = 1024;
  const MAX_PAGE_BYTES = 10 * 1024 * 1024;
  const MAX_CANDIDATES = 8;

  function responseHeader(response, name) {
    // Zotero's unfollowed-redirect wrapper uses nsIHttpChannel, which throws
    // NS_ERROR_NOT_AVAILABLE for an absent header instead of returning null.
    try { return response.getResponseHeader?.(name) || ""; } catch (_) { return ""; }
  }

  function httpURL(value, base) {
    try {
      const url = new URL(String(value || ""), base);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
      url.hash = "";
      return url.href;
    }
    catch (_) { return null; }
  }
  function doi(value) {
    return String(value || "").match(/10\.\d{4,9}\/[^\s<>]+/i)?.[0].replace(/[.,;]+$/, "").toLowerCase() || "";
  }
  function evidence(kind, confidence, url) {
    const safe = httpURL(url);
    if (safe) { const parsed = new URL(safe); parsed.search = ""; url = parsed.href; }
    else url = null;
    return { kind, confidence, source: "page", url };
  }
  function elsevierArticleRoutes(doc, pageURL) {
    const page = new URL(pageURL);
    const linkingHub = page.hostname.toLowerCase() === "linkinghub.elsevier.com";
    const scienceDirect = /^(?:www\.)?sciencedirect\.com$/i.test(page.hostname);
    const pii = linkingHub ? /^\/retrieve\/pii\/([A-Z0-9]{16,20})\/?$/i.exec(page.pathname)?.[1]
      : scienceDirect ? /^\/science\/article\/(?:abs\/)?pii\/([A-Z0-9]{16,20})\/?$/i.exec(page.pathname)?.[1] : null;
    if (!pii) return [];
    const routes = [];
    function add(raw) {
      const address = httpURL(raw, pageURL);
      if (!address) return;
      const url = new URL(address);
      if (!/^(?:www\.)?sciencedirect\.com$/i.test(url.hostname) || url.protocol !== "https:" || url.port) return;
      const candidate = /^\/science\/article\/pii\/([A-Z0-9]{16,20})\/?$/i.exec(url.pathname)?.[1];
      if (!candidate || candidate.toUpperCase() !== pii.toUpperCase()) return;
      // This is an article address supplied by the publisher, never a guessed
      // PDF endpoint. Do not retain routing keys or tracking query parameters.
      url.search = "";
      if (url.href !== pageURL && !routes.includes(url.href)) routes.push(url.href);
    }
    for (const anchor of doc.querySelectorAll("a[href]")) add(anchor.getAttribute("href"));
    if (linkingHub) {
      // Official Linking Hub's Article Locator supplies an encoded target in
      // this field and/or the Refresh URL's Redirect parameter.
      const encoded = doc.querySelector('input#redirectURL,input[name="redirectURL"]')?.getAttribute("value");
      if (encoded) { try { add(decodeURIComponent(encoded)); } catch (_) {} }
      for (const meta of doc.querySelectorAll("meta[http-equiv]")) {
        if ((meta.getAttribute("http-equiv") || "").toLowerCase() !== "refresh") continue;
        const raw = /(?:^|;)\s*url\s*=\s*['"]?([^'"]+)/i.exec(meta.getAttribute("content") || "")?.[1]?.trim();
        const refresh = httpURL(raw, pageURL);
        if (!refresh) continue;
        const redirect = new URL(refresh);
        if (redirect.hostname === page.hostname && redirect.pathname === "/retrieve/articleSelectSinglePerm") add(redirect.searchParams.get("Redirect"));
        else add(refresh);
      }
    }
    return routes.slice(0, 2);
  }
  function abort() { const error = new Error("已取消获取全文。"); error.name = "AbortError"; return error; }
  function asBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (value && typeof value.byteLength === "number") return new Uint8Array(value);
    return new Uint8Array();
  }
  function validPDF(value) {
    const bytes = asBytes(value);
    if (bytes.length < MIN_PDF_BYTES || bytes.length > MAX_PDF_BYTES) return false;
    const head = String.fromCharCode(...bytes.subarray(0, 32)).replace(/^\xEF\xBB\xBF/, "").trimStart();
    if (!/^%PDF-\d\.\d(?:\s|$)/.test(head)) return false;
    const tail = String.fromCharCode(...bytes.subarray(Math.max(0, bytes.length - 8192)));
    return tail.includes("%%EOF");
  }
  // Check every local attachment. Linked files count; web links and missing or
  // incomplete files do not. Only read the envelope, even for very large PDFs.
  async function findExistingPDF(item, { Zotero, IOUtils }) {
    for (const id of item?.getAttachments?.() || []) {
      try {
        const attachment = await Zotero.Items.getAsync(id);
        if (!attachment || attachment.deleted ||
            (attachment.parentID && attachment.parentID !== item.id) ||
            (attachment.libraryID && attachment.libraryID !== item.libraryID)) continue;
        if (attachment.isFileAttachment?.() === false ||
            attachment.attachmentLinkMode === (Zotero.Attachments?.LINK_MODE_LINKED_URL ?? 3)) continue;
        if (attachment.attachmentContentType !== "application/pdf" &&
            !/\.pdf$/i.test(attachment.attachmentFilename || "")) continue;
        const file = await attachment.getFilePathAsync?.();
        if (!file || /^https?:\/\//i.test(file)) continue;
        const info = await IOUtils.stat(file);
        if (info.type !== "regular" || !Number.isSafeInteger(info.size) || info.size < 32) continue;
        const head = asBytes(await IOUtils.read(file, { maxBytes: 32 }));
        if (!/^%PDF-\d\.\d(?:\s|$)/.test(String.fromCharCode(...head).replace(/^\xEF\xBB\xBF/, "").trimStart())) continue;
        const tail = asBytes(await IOUtils.read(file, { offset: Math.max(0, info.size - 8192), maxBytes: 8192 }));
        if (!String.fromCharCode(...tail).includes("%%EOF")) continue;
        const after = await IOUtils.stat(file);
        if (after.type !== "regular" || after.size !== info.size || after.lastModified !== info.lastModified) continue;
        return attachment.id;
      }
      catch (_) { /* Missing/unreadable attachments must not hide a later PDF. */ }
    }
    return null;
  }
  function discover(doc, pageURL, expectedDOI) {
    const documentDOI = doi(doc.querySelector('meta[name="citation_doi"],meta[name="dc.identifier"],meta[name="DC.Identifier"]')?.getAttribute("content"));
    if (expectedDOI && documentDOI && expectedDOI !== documentDOI) return { candidates: [], articleRoutes: [], needsLogin: false, accessReason: null, accessEvidence: evidence("article_mismatch", "explicit", pageURL), challenge: null, mismatch: true };
    const base = httpURL(doc.querySelector("base[href]")?.getAttribute("href"), pageURL) || pageURL;
    const candidates = [];
    function add(raw, evidence) {
      const url = httpURL(raw, base);
      if (url && !candidates.some(value => value.url === url)) candidates.push({ url, evidence, referrer: pageURL });
    }
    for (const meta of doc.querySelectorAll('meta[name="citation_pdf_url"],meta[name="eprints.document_url"],meta[property="citation_pdf_url"]')) {
      add(meta.getAttribute("content"), "citation_pdf_url");
    }
    for (const link of doc.querySelectorAll('link[type="application/pdf"][href]')) add(link.getAttribute("href"), "pdf-link");
    for (const anchor of doc.querySelectorAll("a[href]")) {
      const raw = anchor.getAttribute("href") || "";
      const label = [anchor.textContent, anchor.getAttribute("aria-label"), anchor.getAttribute("title")].join(" ").replace(/\s+/g, " ");
      if (anchor.closest('[hidden],[aria-hidden="true"],#references,.references,.bibliography,[id*="reference"],[class*="reference"],.related-articles')) continue;
      if (/supplement|supporting\s+(?:information|material)|补充|勘误|correction/i.test(label + " " + raw)) continue;
      if (anchor.getAttribute("type") === "application/pdf" || /\.pdf(?:[?#]|$)/i.test(raw)
          || /\b(?:download|view|full\s*text)\b[^\n]{0,35}\bpdf\b|^\s*pdf\s*$|下载全文|全文下载|PDF下载|下载PDF/i.test(label)) {
        add(raw, "page-pdf-anchor");
      }
    }
    // Article access controls are different from a site's ordinary account
    // sign-in. Inspect a detached copy and ignore navigation/footer prompts,
    // hidden UI and script strings; never suppress a verified public PDF.
    const visible = doc.cloneNode(true);
    for (const node of visible.querySelectorAll('script,style,template,noscript,[hidden],[aria-hidden="true"],[inert],footer,nav,[role="contentinfo"],[role="navigation"],[id*="footer"],[class*="footer"],#references,.references,.bibliography,.related-articles')) node.remove();
    const text = (visible.body?.textContent || "").replace(/\s+/g, " ").slice(0, 120000);
    const labels = [...visible.querySelectorAll('a[href],button,[role="button"],h1,h2,h3,[role="heading"]')]
      .map(node => [node.textContent, node.getAttribute("aria-label"), node.getAttribute("title")].join(" ").replace(/\s+/g, " ")).join("\n").slice(0, 120000);
    const password = !!visible.querySelector('input[type="password"]');
    const challenge = /verify (?:that )?you are human|verifying you are human|checking your browser|performing security verification|unusual traffic|complete the captcha|验证您是真人|请输入验证码|安全验证/i.test(text);
    const cloudflare = challenge && (!!visible.querySelector('[id^="cf-chl"],#challenge-running,#challenge-stage,.cf-turnstile,iframe[src*="challenges.cloudflare.com"]') || /cloudflare|ray id/i.test(text));
    // Elsevier distinguishes personal Sign in from checking subscription access:
    // https://www.elsevier.support/elsevieraccess/answer/what-is-the-difference-between-sign-in-and-check-access
    const institutionPattern = /\b(?:check\s+)?access\s+(?:through|via)\s+(?:your|my|an?)\s+(?:institution|organi[sz]ation)\b|\b(?:sign|log)\s*in\s+(?:via|through|to)\s+(?:your|my|an?)\s+(?:institution|organi[sz]ation)\b|\binstitutional\s+(?:log\s*in|sign\s*in|access)\b|通过(?:您的?|所在)?(?:机构|学校|单位)(?:登录|访问)|机构登录|学校登录/i;
    const institutionLink = [...visible.querySelectorAll('a[href],form[action]')].some(node => {
      const address = httpURL(node.getAttribute("href") || node.getAttribute("action"), pageURL);
      if (!address) return false;
      const target = new URL(address);
      return /^(?:www\.)?sciencedirect\.com$/i.test(target.hostname) && /^\/user\/institution\/login\/?$/i.test(target.pathname);
    });
    const institutionalAccess = institutionPattern.test(labels) || institutionLink;
    const purchase = /\b(?:purchase|buy)\s+(?:(?:this|the)\s+)?(?:pdf|article|full[\s-]*text)\b|购买(?:全文|文章|PDF)|订阅后(?:下载|查看)/i.test(labels);
    const scienceDirect = /(?:^|\.)sciencedirect\.com$/i.test(new URL(pageURL).hostname);
    const blockText = [...visible.querySelectorAll("p,div,section,form")].map(node => node.textContent).join("\n").slice(0, 120000);
    const institutionalHint = !institutionalAccess && (institutionPattern.test(text + "\n" + blockText) || scienceDirect && /(?:^|\n)\s*(?:check access|get access|other access options|access options)\s*(?:\n|$)/i.test(labels));
    const preview = scienceDirect && /\barticle\s+preview\b|\b(?:preview|abstract)\s+only\b/i.test(labels);
    const genericLogin = password || /(?:sign|log)\s*in to (?:access|download|view)|登录后(?:下载|查看)|请先登录/i.test(text);
    const accessReason = institutionalAccess ? "institutional_access" : institutionalHint ? "institutional_hint" : purchase ? "purchase" : preview ? "preview" : genericLogin ? "login_possible" : null;
    const loginGate = !!accessReason;
    const accessEvidence = challenge ? evidence("human_verification", "explicit", pageURL)
      : institutionalAccess ? evidence("institutional_entry", "explicit", pageURL)
      : institutionalHint ? evidence("institutional_hint", "possible", pageURL)
      : purchase ? evidence("purchase", "explicit", pageURL) : preview ? evidence("preview", "explicit", pageURL)
      : genericLogin ? evidence("login_hint", "possible", pageURL) : evidence("automatic_not_found", "unknown", pageURL);
    return { candidates: candidates.slice(0, MAX_CANDIDATES), needsLogin: password || challenge || loginGate,
      articleRoutes: elsevierArticleRoutes(doc, pageURL), accessReason, accessEvidence,
      challenge: challenge ? (cloudflare ? "cloudflare" : "verification") : null, mismatch: false };
  }

  function create({ Zotero, Services, IOUtils, PathUtils, parseHTML, HiddenBrowser: BrowserClass, publisherSession, pdfIdentity, sources, getSourceSettings = () => ({}) }) {
    if (!Zotero || !Services || !IOUtils || !PathUtils || typeof parseHTML !== "function") throw new Error("出版社获取模块缺少运行依赖。");
    const inFlight = new Map();
    const siteQueues = new Map();
    const accessGates = new Map();
    const GATE_COOLDOWN = 10 * 60 * 1000;
    function siteKey(url) {
      try {
        const host = new URL(url).hostname;
        try { return Services.eTLD?.getBaseDomainFromHost(host) || host; } catch (_) { return host; }
      } catch (_) { return ""; }
    }
    function gateFor(url) {
      const key = siteKey(url), gate = accessGates.get(key);
      if (gate && Date.now() - gate.at < GATE_COOLDOWN) return gate;
      if (gate) accessGates.delete(key);
      return null;
    }
    function rememberGate(url, kind) {
      const key = siteKey(url); if (key) accessGates.set(key, { url, kind, at: Date.now() });
    }
    const parse = (html, url) => {
      const parsed = parseHTML(html, url);
      const doc = parsed?.document || parsed;
      if (!doc?.querySelectorAll) throw new Error("无法解析出版社网页。");
      return doc;
    };
    const decode = (bytes, contentType = "") => {
      const Decoder = global.TextDecoder || Zotero.getMainWindow()?.TextDecoder;
      const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1] || "utf-8";
      try { return new Decoder(charset).decode(bytes); }
      catch (_) { return new Decoder("utf-8").decode(bytes); }
    };
    const existingPDF = item => findExistingPDF(item, { Zotero, IOUtils });
    async function run(item, { onProgress = () => {}, isCancelled = () => false } = {}) {
      if (!item?.id || !item.isRegularItem?.()) throw new Error("请选择已保存的普通文献条目。");
      const check = () => { if (isCancelled()) throw abort(); };
      const progress = (stage, message, url) => { check(); onProgress({ stage, message, url: url || null }); };
      async function cancellable(operation, cancel = () => {}) {
        if (isCancelled()) { try { cancel(); } catch (_) {} throw abort(); }
        let done = false;
        const monitor = (async () => {
          while (!done) {
            if (isCancelled()) { cancel(); throw abort(); }
            await Zotero.Promise.delay(150);
          }
          return new Promise(() => {});
        })();
        try { const result = await Promise.race([operation, monitor]); check(); return result; }
        finally { done = true; }
      }
      const oldID = await existingPDF(item);
      check();
      if (oldID) return { attachmentID: oldID, source: "existing", sourceURL: null };
      if (publisherSession) await publisherSession.initialize().catch(() => {});
      const expectedDOI = doi(item.getField("DOI") || item.getExtraField?.("DOI"));
      const expectedTitle = item.getField("title");
      const pmcid = String(item.getExtraField?.("PMCID") || item.getField("extra") || "").match(/\bPMC[1-9]\d{0,11}\b/i)?.[0]?.toUpperCase() || "";
      const sourceDiagnostics = [];
      let pendingReview = null;
      const config = () => getSourceSettings() || {};
      const articleURL = httpURL(item.getField("url"));
      const starts = [...new Set([articleURL, expectedDOI ? "https://doi.org/" + expectedDOI : null].filter(Boolean))];
      const triedDownloads = new Set();
      const visitedPages = new Set();
      let needsLogin = false;
      let loginURL = null;
      let challengeKind = null;
      let accessReason = null;
      let accessEvidence = evidence("automatic_not_found", "unknown", articleURL || starts[0]);
      let lastURL = articleURL || starts[0] || null;
      let publisherURL = articleURL || starts[0] || null;
      let articleRouteCount = 0;

      function rememberPublisherURL(url, source) {
        if (source === "open_access") return;
        const host = new URL(url).hostname, current = publisherURL ? new URL(publisherURL).hostname : "";
        if (host === "doi.org" && current && current !== "doi.org") return;
        if (host === "linkinghub.elsevier.com" && /^(?:www\.)?sciencedirect\.com$/i.test(current)) return;
        publisherURL = url;
      }

      function noteRestriction(url) {
        needsLogin = true; loginURL ||= url;
        if (accessEvidence.confidence === "unknown") accessEvidence = { ...evidence("request_restricted", "possible", url), source: "response" };
      }

      async function request(url, referrer) {
        check();
        const gate = gateFor(url);
        if (gate) { const error = new Error("此站点正在等待人工验证，暂缓重复请求。"); error.name = "PublisherAccessGate"; error.gate = gate; throw error; }
        let cancel = () => {};
        let exceeded = false;
        const headers = { Accept: "application/pdf,text/html;q=0.9,application/xhtml+xml;q=0.8,*/*;q=0.5" };
        if (referrer) headers.Referer = referrer;
        const operation = Zotero.HTTP.request("GET", url, {
          responseType: "arraybuffer", successCodes: false, timeout: 30000, headers,
          debug: false, logBodyLength: 0, errorDelayMax: 0, noRetryOnThrottle: true,
          // Omit userContextId: the publisher window and this request share Zotero's default jar.
          cancellerReceiver(value) { cancel = value; },
          requestObserver(xhr) {
            xhr.addEventListener?.("progress", event => {
              if (event.loaded > MAX_PDF_BYTES) { exceeded = true; xhr.abort(); }
            });
          },
        });
        const response = await cancellable(operation, () => cancel());
        if (exceeded) throw new Error("文件超过 100 MiB 上限。");
        const bytes = asBytes(response.response);
        if (bytes.length > MAX_PDF_BYTES) throw new Error("文件超过 100 MiB 上限。");
        const result = { response, bytes, url: httpURL(response.responseURL) || url, type: responseHeader(response, "Content-Type") };
        if (responseHeader(response, "cf-mitigated") === "challenge") {
          challengeKind = "cloudflare"; needsLogin = true; loginURL ||= result.url; rememberGate(result.url, challengeKind);
          accessEvidence = { ...evidence("human_verification", "explicit", result.url), source: "response" };
        }
        return result;
      }
      async function importPDF(bytes, sourceURL, source, fulltextVersion = "unknown") {
        check();
        if (!validPDF(bytes)) return null;
        // Discovery APIs may point to an unrelated storage provider. Record the
        // final response host only after actual PDF bytes have been obtained.
        const discoveryProvider = source === "rendered_publisher" ? "publisher" : source;
        let pdfHost = "";
        try { pdfHost = new URL(sourceURL).hostname.toLowerCase().replace(/\.$/, ""); } catch (_) {}
        try {
        const duplicate = await existingPDF(item);
        check();
        if (duplicate) return { attachmentID: duplicate, source: "existing", sourceURL: null };
        progress("importing", "正在将验证过的 PDF 附加到原文献…", sourceURL);
        const temporary = await Zotero.Attachments.createTemporaryStorageDirectory();
        const folder = temporary.path;
        const file = PathUtils.join(folder, "fulltext.pdf");
        try {
          await IOUtils.write(file, bytes);
          check();
          if (pdfIdentity) {
            let identity;
            try { identity = await pdfIdentity.inspect(file, { doi: expectedDOI, title: expectedTitle }, { bytes }); }
            catch (_) { identity = { status: "unknown" }; }
            check();
            if (identity.status === "mismatch") {
              sourceDiagnostics.push({ source, code: "pdf_mismatch", message: "PDF 的 DOI 或标题与目标论文冲突，已拒绝自动入库。" });
              return null;
            }
            if (identity.status !== "match") {
              pendingReview ||= { needsReview: true, paper: {doi:expectedDOI,title:expectedTitle}, reviewBytes: bytes, source, discoveryProvider, pdfHost, sourceURL, fulltextVersion, publisherURL };
              sourceDiagnostics.push({ source, code: "pdf_unknown", message: "已取得 PDF，但 DOI 和标题证据不足，需要预览核对。" });
              return null;
            }
          }
          // The item may have been edited while the request or PDF extraction was in flight.
          if (doi(item.getField("DOI") || item.getExtraField?.("DOI")) !== expectedDOI || item.getField("title") !== expectedTitle || item.deleted) throw abort();
          const lateDuplicate = await existingPDF(item);
          check();
          if (lateDuplicate) return { attachmentID: lateDuplicate, source: "existing", sourceURL: null };
          const attachment = await Zotero.Attachments.importFromFile({ file, parentItemID: item.id, libraryID: item.libraryID, title: "全文", contentType: "application/pdf" });
          // The import has committed. Cancellation now must not misreport it as absent.
          try { attachment.setField("url", sourceURL); await attachment.saveTx(); } catch (_) {}
          return { attachmentID: attachment.id, source, discoveryProvider, pdfHost, sourceURL, publisherURL, fulltextVersion, sourceDiagnostics };
        }
        finally {
          await IOUtils.remove(file, { ignoreAbsent: true }).catch(() => {});
          await IOUtils.remove(folder, { ignoreAbsent: true }).catch(() => {});
        }
        }
        catch (cause) {
          if (cause.name === "AbortError") throw cause;
          const error = new Error("已取得有效 PDF，但写入或导入 Zotero 失败。请检查文库权限和磁盘空间后重试；不会转为科研通求助。");
          error.name = "AttachmentImportError";
          throw error;
        }
      }
      async function sourceRequest(candidate) {
        check();
        const prepared = candidate.source === "open_access"
          ? { url: await sources.validateURL(candidate.url, { isCancelled }), headers: { Accept: "application/pdf,text/html;q=0.9" }, timeout: 20000 }
          : await sources.prepareRequest(candidate, { isCancelled });
        let url = prepared.url, headers = { ...prepared.headers };
        const seen = new Set();
        for (let hop = 0; hop < 6; hop++) {
          check();
          url = await sources.validateURL(url, { isCancelled });
          if (seen.has(url)) throw new Error("下载重定向循环。");
          seen.add(url);
          await sources.beforeRequest?.(url, { source: candidate.source, headers, isCancelled });
          let cancel = () => {}, exceeded = false;
          const operation = Zotero.HTTP.request("GET", url, {
            responseType: "arraybuffer", successCodes: false, anon: true, followRedirects: false,
            timeout: prepared.timeout || 20000, headers, debug: false, logBodyLength: 0, errorDelayMax: 0, noRetryOnThrottle: true,
            cancellerReceiver(value) { cancel = value; },
            requestObserver(xhr) { xhr.addEventListener?.("progress", event => { if (event.loaded > MAX_PDF_BYTES) { exceeded = true; xhr.abort(); } }); },
          });
          const response = await cancellable(operation, () => cancel());
          if (exceeded) throw new Error("下载文件超过上限。");
          const actual = response.responseURL || url;
          if (new URL(actual).href !== new URL(url).href) throw new Error("下载器返回了未经核验的重定向。");
          const status = Number(response.status);
          sources.recordResponse?.(url, { source: candidate.source, headers, status, retryAfter: responseHeader(response, "Retry-After") });
          if (status >= 300 && status < 400) {
            const location = responseHeader(response, "Location");
            if (!location) throw new Error("下载重定向缺少地址。");
            const next = await sources.validateURL(new URL(location, url).href, { isCancelled });
            if (new URL(next).origin !== new URL(url).origin) headers = { Accept: headers.Accept };
            // Even a same-origin redirect cannot move an API credential to another endpoint.
            else if (new URL(next).pathname !== new URL(url).pathname || new URL(next).search !== new URL(url).search) headers = { Accept: headers.Accept };
            url = next; continue;
          }
          const bytes = asBytes(response.response);
          if (bytes.length > MAX_PDF_BYTES) throw new Error("下载文件超过上限。");
          return { bytes, url, status, fulltextVersion: prepared.fulltextVersion || candidate.version || "unknown", type: responseHeader(response, "Content-Type"), challenge: responseHeader(response, "cf-mitigated") === "challenge" };
        }
        throw new Error("下载重定向次数超过上限。");
      }
      async function trySource(candidate, depth = 0) {
        check();
        if (triedDownloads.size >= 24 || triedDownloads.has("api:" + candidate.url)) return null;
        triedDownloads.add("api:" + candidate.url);
        progress("open_access", "正在下载并核对开放全文候选…", candidate.url);
        try {
          const result = await sourceRequest(candidate);
          check();
          if (result.challenge || [401,403,429].includes(result.status)) {
            sourceDiagnostics.push({ source: candidate.source, code: result.challenge ? "human_verification" : "download_restricted", message: "此来源下载受限；继续尝试其他来源或浏览器下载。" });
            return null;
          }
          if (result.status < 200 || result.status >= 300) return null;
          const imported = await importPDF(result.bytes, result.url, candidate.source, result.fulltextVersion || candidate.version || "unknown");
          if (imported) return imported;
          if (depth < 1 && !validPDF(result.bytes) && result.bytes.length <= 4 * 1024 * 1024 && !/application\/pdf/i.test(result.type)) {
            const parsed = sources.parsePage(decode(result.bytes, result.type), result.url, expectedDOI);
            if (parsed.code) sourceDiagnostics.push({ source: candidate.source, code: parsed.code, message: parsed.code === "human_verification" ? "此页面需要人工验证，已停止自动请求。" : "此页面未提供可核验的 PDF 入口。" });
            for (const nested of parsed.candidates.slice(0, MAX_CANDIDATES)) {
              const found = await trySource({ ...nested, source: candidate.source, version: candidate.version || "unknown" }, depth + 1);
              if (found) return found;
            }
          }
        } catch (error) {
          if (["AbortError", "AttachmentImportError"].includes(error.name)) throw error;
          sourceDiagnostics.push({ source: candidate.source, code: /^[a-z_]{1,60}$/.test(error.code || "") ? error.code : "download_failed", message: "此来源未完成下载，已继续其他获取方式。" });
        }
        return null;
      }
      function noteGate(result, url) {
        if (result.needsLogin) { needsLogin = true; loginURL ||= url; }
        const rank = { login_possible: 1, preview: 2, purchase: 3, institutional_hint: 4, institutional_access: 5 };
        if ((rank[result.accessReason] || 0) > (rank[accessReason] || 0)) accessReason = result.accessReason;
        const evidenceRank = { automatic_not_found: 0, article_mismatch: 0, request_restricted: 1, login_hint: 2, preview: 3, purchase: 4, institutional_hint: 5, institutional_entry: 6, human_verification: 7 };
        if ((evidenceRank[result.accessEvidence?.kind] || 0) > (evidenceRank[accessEvidence?.kind] || 0)) accessEvidence = result.accessEvidence;
        if (result.challenge) { challengeKind = result.challenge; rememberGate(url, result.challenge); }
      }
      function cachedGate(url) {
        const gate = gateFor(url);
        if (!gate) return false;
        needsLogin = true; loginURL ||= gate.url; challengeKind ||= gate.kind;
        accessEvidence = { ...evidence("human_verification", "explicit", gate.url), source: "cached_response" };
        return true;
      }
      function caughtGate(error) {
        if (error.name === "PublisherAccessGate") { needsLogin = true; loginURL ||= error.gate.url; challengeKind ||= error.gate.kind;
          accessEvidence = { ...evidence("human_verification", "explicit", error.gate.url), source: "cached_response" }; }
      }
      async function tryArticleRoutes(routes, source) {
        for (const route of routes || []) {
          if (articleRouteCount >= 4 || visitedPages.has(route)) continue;
          articleRouteCount++;
          const result = await visitPage(route, source);
          if (result) return result;
        }
        return null;
      }
      async function tryCandidates(candidates, source, depth = 0) {
        for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
          check();
          // JavaScript rendering can establish publisher cookies. A URL that
          // failed before rendering may be retried once with that new session.
          const attemptKey = source + ":" + candidate.url;
          if (triedDownloads.has(attemptKey) || triedDownloads.size >= 24) continue;
          if (cachedGate(candidate.url)) continue;
          triedDownloads.add(attemptKey);
          progress("downloading", "正在检查网页提供的 PDF 下载入口…", candidate.url);
          try {
            const result = await request(candidate.url, candidate.referrer);
            lastURL = result.url;
            if ([401,403,429].includes(result.response.status)) {
              noteRestriction(candidate.referrer || result.url);
              if (result.bytes.length <= MAX_PAGE_BYTES && /html/i.test(result.type)) noteGate(discover(parse(decode(result.bytes, result.type), result.url), result.url, expectedDOI), result.url);
              continue;
            }
            if (result.response.status < 200 || result.response.status >= 300) continue;
            const imported = await importPDF(result.bytes, result.url, source);
            if (imported) return imported;
            if (depth < 1 && result.bytes.length <= MAX_PAGE_BYTES && !/application\/pdf/i.test(result.type)) {
              const html = decode(result.bytes, result.type);
              if (/<(?:!doctype\s+html|html|head|body)\b/i.test(html)) {
                const discovered = discover(parse(html, result.url), result.url, expectedDOI);
                noteGate(discovered, result.url);
                const nested = await tryCandidates(discovered.candidates, source, depth + 1);
                if (nested) return nested;
              }
            }
          }
          catch (error) { if (["AbortError", "AttachmentImportError"].includes(error.name)) throw error; caughtGate(error); }
        }
        return null;
      }
      async function renderedPage(url, source) {
        check();
        if (cachedGate(url)) return null;
        progress("rendering", "正在用 Zotero 浏览器渲染网页并识别下载按钮…", url);
        const HiddenBrowser = BrowserClass || ChromeUtils.importESModule("chrome://zotero/content/HiddenBrowser.mjs").HiddenBrowser;
        const browser = new HiddenBrowser({ allowJavaScript: true });
        try {
          const loaded = await cancellable(browser.load(url), () => browser.destroy());
          if (!loaded) return null;
          let data = await cancellable(browser.getPageData(["documentHTML"], { timeout: 15000 }), () => browser.destroy());
          let pageURL = httpURL(browser.currentURI?.spec) || url;
          let result = discover(parse(data.documentHTML, pageURL), pageURL, expectedDOI);
          noteGate(result, pageURL);
          rememberPublisherURL(pageURL, source);
          const routed = await tryArticleRoutes(result.articleRoutes, source);
          if (routed) return routed;
          if (!result.candidates.length && !result.mismatch && !result.needsLogin) {
            await cancellable(Zotero.Promise.delay(1000), () => browser.destroy());
            data = await cancellable(browser.getPageData(["documentHTML"], { timeout: 10000 }), () => browser.destroy());
            pageURL = httpURL(browser.currentURI?.spec) || pageURL;
            result = discover(parse(data.documentHTML, pageURL), pageURL, expectedDOI);
            noteGate(result, pageURL);
            rememberPublisherURL(pageURL, source);
            const routed = await tryArticleRoutes(result.articleRoutes, source);
            if (routed) return routed;
          }
          return await tryCandidates(result.candidates, source);
        }
        catch (error) { if (["AbortError", "AttachmentImportError"].includes(error.name)) throw error; return null; }
        finally { browser.destroy(); }
      }
      async function visitPage(url, source = "publisher") {
        check();
        if (visitedPages.has(url)) return null;
        if (cachedGate(url)) return null;
        visitedPages.add(url);
        progress("discovering", "正在读取论文网页中的 PDF 元数据和下载链接…", url);
        let renderURL = url;
        try {
          const result = await request(url);
          renderURL = result.url;
          visitedPages.add(renderURL);
          lastURL = renderURL;
          rememberPublisherURL(renderURL, source);
          if ([401,403,429].includes(result.response.status)) {
            noteRestriction(renderURL);
            if (result.bytes.length <= MAX_PAGE_BYTES && /html/i.test(result.type)) noteGate(discover(parse(decode(result.bytes, result.type), result.url), result.url, expectedDOI), result.url);
          }
          if (result.response.status >= 200 && result.response.status < 300) {
            const direct = await importPDF(result.bytes, result.url, source);
            if (direct) return direct;
            if (result.bytes.length <= MAX_PAGE_BYTES) {
              const discovered = discover(parse(decode(result.bytes, result.type), result.url), result.url, expectedDOI);
              noteGate(discovered, result.url);
              const found = await tryCandidates(discovered.candidates, source);
              if (found) return found;
              if (discovered.mismatch) return null;
              const routed = await tryArticleRoutes(discovered.articleRoutes, source);
              if (routed) return routed;
            }
          }
        }
        catch (error) { if (["AbortError", "AttachmentImportError"].includes(error.name)) throw error; caughtGate(error); }
        return renderedPage(renderURL, source === "open_access" ? source : "rendered_publisher");
      }

      check();
      if (config().enabled?.openAccess !== false && expectedDOI && typeof Zotero.Attachments.getFileResolvers === "function") {
        progress("open_access", "正在尝试 Zotero 开放获取来源…", null);
        const resolvers = Zotero.Attachments.getFileResolvers(item, ["oa"]);
        for (const resolver of resolvers) {
          check();
          let entries;
          try { entries = typeof resolver === "function" ? await cancellable(Promise.resolve(resolver())) : resolver; }
          catch (error) { if (error.name === "AbortError") throw error; continue; }
          for (const entry of (Array.isArray(entries) ? entries : [entries]).slice(0, MAX_CANDIDATES)) {
            check();
            if (global.FulltextSources && !global.FulltextSources.acceptsVersion(entry?.version, config().versionPreference)) continue;
            const url = httpURL(typeof entry === "string" ? entry : entry?.url);
            const pageURL = httpURL(entry?.pageURL);
            if (url) {
              const found = sources ? await trySource({url,source:"open_access",version:entry?.version || "unknown",kind:"pdf"}) : await tryCandidates([{ url, referrer: pageURL }], "open_access");
              if (found) return found;
            }
            if (pageURL) {
              const found = sources ? await trySource({url:pageURL,source:"open_access",version:entry?.version || "unknown",kind:"page"}) : await visitPage(pageURL, "open_access");
              if (found) return found;
            }
          }
        }
      }
      check();
      if (sources && (expectedDOI || pmcid)) {
        let streamed = false;
        const found = await sources.discover({ doi: expectedDOI, pmcid }, { isCancelled, onProgress,
          async onCandidates(batch) {
            streamed = true;
            sourceDiagnostics.push(...batch.diagnostics);
            for (const candidate of batch.candidates) {
              const imported = await trySource(candidate);
              if (imported) return imported;
            }
            return null;
          },
        });
        if (found.accepted) return found.accepted;
        if (!streamed) sourceDiagnostics.push(...found.diagnostics);
        for (const candidate of found.candidates) {
          const imported = await trySource(candidate);
          if (imported) return imported;
        }
      }
      if (config().enabled?.publisher !== false) {
      for (const url of starts) {
        if (challengeKind && new URL(url).hostname === "doi.org") continue;
        const found = await visitPage(url);
        if (found) return found;
      }
      }
      check();
      if (pendingReview) return { ...pendingReview, sourceDiagnostics: sourceDiagnostics.slice(0, 24) };
      return needsLogin
        ? { state: "needs_login", sourceDiagnostics: sourceDiagnostics.slice(0, 24), challenge: challengeKind, accessReason, accessEvidence, publisherURL, message: challengeKind === "cloudflare"
          ? "该网站返回 Cloudflare 真人验证，同一站点已暂缓重复请求。请点击“浏览器下载并自动入库”，在日常使用的默认浏览器完成验证并点击 PDF 下载；保存到配置文件夹且确认匹配的新 PDF 会自动入库，也可使用科研通兜底。"
          : challengeKind ? "该网站要求人工验证，同一站点已暂缓重复请求。请点击“浏览器下载并自动入库”，在日常使用的默认浏览器完成验证并点击 PDF 下载；保存到配置文件夹且确认匹配的新 PDF 会自动入库，也可使用科研通兜底。"
          : accessReason === "institutional_access" ? "出版社页面提供机构访问入口，当前 Zotero 会话尚未取得全文。请点击“浏览器下载并自动入库”，在默认浏览器完成机构登录、确认本篇论文的订阅权限并点击 PDF 下载；保存到配置文件夹且确认匹配的新 PDF 会自动入库，也可使用科研通兜底。"
          : accessReason === "institutional_hint" ? "页面有检查访问权限或机构登录的迹象，但尚未确认本篇论文可通过机构获取。请点击“浏览器下载并自动入库”，在默认浏览器检查机构登录和本篇订阅权限，再点击 PDF 下载；保存到配置文件夹且确认匹配的新 PDF 会自动入库。"
          : accessReason === "purchase" ? "出版社页面显示购买或订阅入口，当前会话尚未取得全文。如有机构访问权限，请点击“浏览器下载并自动入库”，在默认浏览器完成机构登录、检查订阅并点击 PDF 下载；保存到配置文件夹且确认匹配的新 PDF 会自动入库，也可使用科研通兜底。"
          : accessReason === "preview" ? "当前仅取得 ScienceDirect 论文预览或摘要页，尚未取得全文。请点击“浏览器下载并自动入库”，在默认浏览器完成机构登录、确认全文访问权限并点击 PDF 下载；保存到配置文件夹且确认匹配的新 PDF 会自动入库，也可使用科研通兜底。"
          : "网页提示登录、访问验证或请求限制。请点击“浏览器下载并自动入库”，在默认浏览器完成出版社或机构登录、检查访问权限并点击 PDF 下载；保存到配置文件夹且确认匹配的新 PDF 会自动入库，也可使用科研通兜底。", url: loginURL || lastURL }
        : { state: "not_found", sourceDiagnostics: sourceDiagnostics.slice(0, 24), accessReason: "automatic_not_found", accessEvidence: evidence("automatic_not_found", "unknown", publisherURL || lastURL), publisherURL,
          message: "自动查找暂未取得有效 PDF；这不能判断你是否拥有机构访问权限。可先点击“浏览器下载并自动入库”，在日常浏览器查看这篇论文并尝试下载；仍无法获取时可使用科研通兜底。", url: publisherURL || lastURL };
    }
    return {
      clearAccessGate(url) { accessGates.delete(siteKey(url)); },
      acquire(item, options) {
        const key = item?.libraryID + ":" + item?.id;
        if (inFlight.has(key)) return inFlight.get(key);
        const site = siteKey(httpURL(item?.getField?.("url")) || "https://doi.org/");
        const previous = siteQueues.get(site) || Promise.resolve();
        let started = false, finished = false;
        const operation = previous.catch(() => {}).then(() => { started = true; return run(item, options); }).finally(() => {
          if (siteQueues.get(site) === operation) siteQueues.delete(site);
        });
        const waitingCancellation = (async () => {
          while (!started && !finished) {
            if (options?.isCancelled?.()) throw abort();
            await Zotero.Promise.delay(150);
          }
          return new Promise(() => {});
        })();
        const promise = Promise.race([operation, waitingCancellation]).finally(() => { finished = true; if (inFlight.get(key) === promise) inFlight.delete(key); });
        siteQueues.set(site, operation);
        inFlight.set(key, promise);
        return promise;
      },
    };
  }
  global.FulltextPublisher = { create, discover, validPDF, findExistingPDF, elsevierArticleRoutes };
})(globalThis);
