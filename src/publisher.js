/* Publisher DOM discovery uses Zotero's default cookie context, never external browsers. */
(function (global) {
  "use strict";
  const MAX_PDF_BYTES = 100 * 1024 * 1024;
  const MIN_PDF_BYTES = 1024;
  const MAX_PAGE_BYTES = 10 * 1024 * 1024;
  const MAX_CANDIDATES = 8;

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
  function discover(doc, pageURL, expectedDOI) {
    const documentDOI = doi(doc.querySelector('meta[name="citation_doi"],meta[name="dc.identifier"],meta[name="DC.Identifier"]')?.getAttribute("content"));
    if (expectedDOI && documentDOI && expectedDOI !== documentDOI) return { candidates: [], needsLogin: false, mismatch: true };
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
    // Work only on a detached copy; script strings are not login/captcha evidence.
    for (const node of doc.querySelectorAll("script,style,template,noscript")) node.remove();
    const text = (doc.body?.textContent || "").replace(/\s+/g, " ").slice(0, 120000);
    const password = [...doc.querySelectorAll('input[type="password"]')].some(node => !node.closest('[hidden],[aria-hidden="true"]'));
    const challenge = /verify (?:that )?you are human|verifying you are human|checking your browser|performing security verification|unusual traffic|complete the captcha|验证您是真人|请输入验证码|安全验证/i.test(text);
    const cloudflare = challenge && (!!doc.querySelector('[id^="cf-chl"],#challenge-running,#challenge-stage,.cf-turnstile,iframe[src*="challenges.cloudflare.com"]') || /cloudflare|ray id/i.test(text));
    const loginGate = /(?:sign|log)\s*in to (?:access|download|view)|access through your institution|institutional login|登录后(?:下载|查看)|请先登录/i.test(text);
    return { candidates: candidates.slice(0, MAX_CANDIDATES), needsLogin: password || challenge || loginGate,
      challenge: challenge ? (cloudflare ? "cloudflare" : "verification") : null, mismatch: false };
  }

  function create({ Zotero, Services, IOUtils, PathUtils, parseHTML, HiddenBrowser: BrowserClass, publisherSession }) {
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
    async function existingPDF(item) {
      for (const id of item.getAttachments?.() || []) {
        const attachment = await Zotero.Items.getAsync(id);
        if (!attachment || attachment.deleted || (attachment.attachmentContentType !== "application/pdf" && !/\.pdf$/i.test(attachment.attachmentFilename || ""))) continue;
        const file = await attachment.getFilePathAsync?.();
        if (file && await IOUtils.exists(file)) return attachment.id;
      }
      return null;
    }
    async function run(item, { onProgress = () => {}, isCancelled = () => false } = {}) {
      if (!item?.id || !item.isRegularItem?.()) throw new Error("请选择已保存的普通文献条目。");
      const check = () => { if (isCancelled()) throw abort(); };
      const progress = (stage, message, url) => { check(); onProgress({ stage, message, url: url || null }); };
      async function cancellable(operation, cancel = () => {}) {
        check();
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
      const expectedDOI = doi(item.getField("DOI"));
      const articleURL = httpURL(item.getField("url"));
      const starts = [...new Set([articleURL, expectedDOI ? "https://doi.org/" + expectedDOI : null].filter(Boolean))];
      const triedDownloads = new Set();
      const visitedPages = new Set();
      let needsLogin = false;
      let loginURL = null;
      let challengeKind = null;
      let lastURL = articleURL || starts[0] || null;

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
        const result = { response, bytes, url: httpURL(response.responseURL) || url, type: response.getResponseHeader?.("Content-Type") || "" };
        if (response.getResponseHeader?.("cf-mitigated") === "challenge") {
          challengeKind = "cloudflare"; needsLogin = true; loginURL ||= result.url; rememberGate(result.url, challengeKind);
        }
        return result;
      }
      async function importPDF(bytes, sourceURL, source) {
        check();
        if (!validPDF(bytes)) return null;
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
          const lateDuplicate = await existingPDF(item);
          check();
          if (lateDuplicate) return { attachmentID: lateDuplicate, source: "existing", sourceURL: null };
          const attachment = await Zotero.Attachments.importFromFile({ file, parentItemID: item.id, libraryID: item.libraryID, title: "全文", contentType: "application/pdf" });
          // The import has committed. Cancellation now must not misreport it as absent.
          try { attachment.setField("url", sourceURL); await attachment.saveTx(); } catch (_) {}
          return { attachmentID: attachment.id, source, sourceURL };
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
      function noteGate(result, url) {
        if (result.needsLogin) { needsLogin = true; loginURL ||= url; }
        if (result.challenge) { challengeKind = result.challenge; rememberGate(url, result.challenge); }
      }
      function cachedGate(url) {
        const gate = gateFor(url);
        if (!gate) return false;
        needsLogin = true; loginURL ||= gate.url; challengeKind ||= gate.kind;
        return true;
      }
      function caughtGate(error) {
        if (error.name === "PublisherAccessGate") { needsLogin = true; loginURL ||= error.gate.url; challengeKind ||= error.gate.kind; }
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
              needsLogin = true; loginURL ||= candidate.referrer || result.url;
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
          if (!result.candidates.length && !result.mismatch && !result.needsLogin) {
            await cancellable(Zotero.Promise.delay(1000), () => browser.destroy());
            data = await cancellable(browser.getPageData(["documentHTML"], { timeout: 10000 }), () => browser.destroy());
            pageURL = httpURL(browser.currentURI?.spec) || pageURL;
            result = discover(parse(data.documentHTML, pageURL), pageURL, expectedDOI);
            noteGate(result, pageURL);
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
          if ([401,403,429].includes(result.response.status)) {
            needsLogin = true; loginURL ||= renderURL;
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
            }
          }
        }
        catch (error) { if (["AbortError", "AttachmentImportError"].includes(error.name)) throw error; caughtGate(error); }
        return renderedPage(renderURL, source === "open_access" ? source : "rendered_publisher");
      }

      for (const url of starts) {
        if (challengeKind && new URL(url).hostname === "doi.org") continue;
        const found = await visitPage(url);
        if (found) return found;
      }
      check();
      if (expectedDOI && typeof Zotero.Attachments.getFileResolvers === "function") {
        progress("open_access", "正在尝试 Zotero 开放获取来源…", null);
        const resolvers = Zotero.Attachments.getFileResolvers(item, ["oa"]);
        for (const resolver of resolvers) {
          check();
          let entries;
          try { entries = typeof resolver === "function" ? await cancellable(Promise.resolve(resolver())) : resolver; }
          catch (error) { if (error.name === "AbortError") throw error; continue; }
          for (const entry of (Array.isArray(entries) ? entries : [entries]).slice(0, MAX_CANDIDATES)) {
            check();
            const url = httpURL(typeof entry === "string" ? entry : entry?.url);
            const pageURL = httpURL(entry?.pageURL);
            if (url) {
              const found = await tryCandidates([{ url, referrer: pageURL }], "open_access");
              if (found) return found;
            }
            if (pageURL) {
              const found = await visitPage(pageURL, "open_access");
              if (found) return found;
            }
          }
        }
      }
      check();
      return needsLogin
        ? { state: "needs_login", challenge: challengeKind, message: challengeKind === "cloudflare"
          ? "该网站返回 Cloudflare 真人验证。Zotero 内嵌浏览器可能不被支持；若手动验证仍循环，请使用系统浏览器下载 PDF 后选择“导入本地 PDF”。同一站点已暂缓重复请求，也可继续科研通兜底。"
          : challengeKind ? "该网站要求人工验证，同一站点已暂缓重复请求。请在网页窗口完成后手动重试；无法完成时可用系统浏览器下载后导入 PDF。"
          : "网页提示登录、访问验证或请求限制。请在 Zotero 网页窗口完成后重试；仍不可得的条目可进入科研通兜底。", url: loginURL || lastURL }
        : { state: "not_found", message: "网页、渲染后的下载入口和开放获取来源均未取得有效 PDF，可进入科研通兜底。", url: lastURL };
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
  global.FulltextPublisher = { create, discover, validPDF };
})(globalThis);
