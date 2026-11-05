/* Reads article metadata and PDF bytes only from the plugin's own Edge session. */
(function (global) {
  "use strict";
  const MAX_PDF_BYTES = 100 * 1024 * 1024;
  const MAX_WAIT_MS = 15 * 60 * 1000;
  const MAX_CANDIDATES = 8;
  const POLL_MS = 1000;

  function failure(name, message) { const error = new Error(message); error.name = name; return error; }
  function normalizedDOI(value) {
    const input = String(value || "").trim().replace(/^doi\s*:\s*/i, "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
    return /^10\.\d{4,9}\/\S+$/i.test(input) ? input.replace(/[.,;]+$/, "").toLowerCase() : "";
  }
  function httpURL(value, base) {
    try {
      const url = new URL(String(value || ""), base);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
      url.hash = ""; return url.href;
    } catch (_) { return null; }
  }
  function publicURL(value, base) {
    try {
      const checked = httpURL(value, base);
      if (!checked) return null;
      const url = new URL(checked);
      const name = url.hostname.toLowerCase().replace(/\.$/, "");
      // A publisher page must not turn its PDF link into a local service request.
      if (name === "localhost" || /\.(?:localhost|local|internal)$/.test(name) || name === "[::1]" || name === "[::]"
        || /^\[(?:f[cd]|fe[89ab])/i.test(name) || /^\[::ffff:/i.test(name)) return null;
      if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) {
        const parts = name.split(".").map(Number);
        if ([0, 10, 127].includes(parts[0]) || parts[0] >= 224 || (parts[0] === 169 && parts[1] === 254)
          || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168)
          || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)) return null;
      }
      url.hash = "";
      return url.href;
    } catch (_) { return null; }
  }
  function titleKey(value) {
    return String(value || "").normalize("NFKC").replace(/<[^>]*>/g, " ").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  }
  function strongTitle(value) {
    const key = titleKey(value);
    return key.length >= 32 && (key.split(" ").length >= 5 || (key.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length >= 16) ? key : "";
  }

  // This exact read-only function runs in Edge. It returns no cookies, storage,
  // form values, whole HTML, account names, or arbitrary body text.
  function snapshotDocument(doc, address, documentTime) {
    const compact = (value, max = 1500) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
    const head = doc.head || doc;
    const meta = selectors => [...head.querySelectorAll(selectors)].slice(0, 12).map(node => compact(node.getAttribute("content")));
    const resolve = raw => {
      try {
        const base = /^https?:/i.test(doc.baseURI || "") ? doc.baseURI : address;
        const url = new URL(String(raw || ""), base);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password) return "";
        url.hash = ""; return url.href;
      } catch (_) { return ""; }
    };
    const links = [];
    const add = (raw, source) => {
      const url = resolve(raw);
      if (url && links.length < 8 && !links.some(link => link.url === url)) links.push({ url, source });
    };
    for (const node of head.querySelectorAll('meta[name="citation_pdf_url"],meta[name="eprints.document_url"],meta[property="citation_pdf_url"]')) add(node.getAttribute("content"), "citation_pdf_url");
    for (const node of head.querySelectorAll('link[type="application/pdf"][href]')) add(node.getAttribute("href"), "pdf-link");
    for (const anchor of doc.querySelectorAll("a[href]")) {
      if (links.length >= 8) break;
      if (anchor.closest('[hidden],[aria-hidden="true"],#references,.references,.bibliography,[id*="reference"],[class*="reference"],.related-articles,[class*="related"],[id*="related"]')) continue;
      const raw = anchor.getAttribute("href") || "";
      const label = compact([anchor.textContent, anchor.getAttribute("aria-label"), anchor.getAttribute("title")].join(" "), 300);
      if (/supplement|supporting\s+(?:information|material)|correction|erratum|补充|勘误/i.test(raw + " " + label)) continue;
      if (anchor.getAttribute("type") === "application/pdf" || /\.pdf(?:[?#]|$)/i.test(raw)
        || /\b(?:download|view|full\s*text)\b.{0,35}\bpdf\b|^\s*pdf\s*$|下载全文|全文下载|PDF下载|下载PDF/i.test(label)) add(raw, "article-pdf-anchor");
    }
    const titles = meta('meta[name="citation_title"],meta[name="dc.title"],meta[name="DC.Title"],meta[property="og:title"]');
    for (const node of [...doc.querySelectorAll("h1")].slice(0, 3)) titles.push(compact(node.textContent));
    titles.push(compact(doc.title));
    // Only the following non-personal gate classifications leave the page.
    const body = (doc.body?.innerText || doc.body?.textContent || "").slice(0, 120000);
    const challengeNodes = [...doc.querySelectorAll('#challenge-running,#challenge-stage,#challenge-form,[id^="cf-chl"],.cf-turnstile,iframe[src*="challenges.cloudflare.com"]')];
    const challengeWidget = challengeNodes.some(node => !node.closest('[hidden],[aria-hidden="true"]')
      && (typeof node.getClientRects !== "function" || node.getClientRects().length > 0));
    const pending = body.length < 4000 && /\bplease wait\b|\bverifying\b|\bchecking (?:your browser|the connection)\b|正在验证|正在检查/i.test(body)
      || /^(?:just a moment|checking your browser|please wait)(?:\b|\.{0,3}$)/i.test(compact(doc.title));
    const challenge = challengeWidget || /verify (?:that )?you are human|verifying you are human|checking your browser|performing security verification|unusual traffic|complete the captcha|验证您是真人|请输入验证码|安全验证/i.test(body);
    const login = /(?:sign|log)\s*in to (?:access|download|view)|access through your institution|登录后(?:下载|查看)|请先登录/i.test(body);
    const access = /you (?:currently )?have (?:full )?access|full access|access (?:is )?provided by|已获得访问权限/i.test(body);
    return {
      url: compact(address, 12000), documentTime: Number(documentTime) || 0,
      canonicalURL: resolve(head.querySelector('link[rel="canonical"]')?.getAttribute("href")),
      dois: meta('meta[name="citation_doi"],meta[name="dc.identifier"],meta[name="DC.Identifier"],meta[name="dc.identifier.doi"],meta[name="prism.doi"],meta[name="doi"]'),
      titles, links, gate: challenge ? "verification" : login && !access ? "login" : "", access,
      contentType: compact(doc.contentType, 100), readyState: compact(doc.readyState, 20), pending: !!pending
    };
  }
  const READ_PAGE_EXPRESSION = "(" + snapshotDocument.toString() + ")(document, location.href, performance.timeOrigin)";

  function articleIdentity(snapshot, expectedDOI, expectedTitle) {
    const found = [...new Set((snapshot.dois || []).map(normalizedDOI).filter(Boolean))];
    if (expectedDOI && found.length) return found.every(value => value === expectedDOI) ? "doi" : "mismatch";
    if (expectedTitle && (snapshot.titles || []).some(value => titleKey(value) === expectedTitle)) return "title";
    return "unknown";
  }
  function decodeChunk(result, remaining, Encoder) {
    const data = String(result.data || "");
    if (result.base64Encoded) {
      if (data.length > Math.ceil(remaining / 3) * 4 + 4 || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw failure("EdgePDFSizeError", "PDF 数据无效或超过 100 MiB 限制。");
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      const length = data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
      if (length > remaining) throw failure("EdgePDFSizeError", "PDF 超过 100 MiB 限制，已停止下载。");
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (let index = 0; index < data.length; index += 4) {
        const bits = alphabet.indexOf(data[index]) << 18 | alphabet.indexOf(data[index + 1]) << 12
          | Math.max(0, alphabet.indexOf(data[index + 2])) << 6 | Math.max(0, alphabet.indexOf(data[index + 3]));
        if (offset < length) bytes[offset++] = bits >>> 16 & 255;
        if (offset < length) bytes[offset++] = bits >>> 8 & 255;
        if (offset < length) bytes[offset++] = bits & 255;
      }
      return bytes;
    }
    if (data.length > remaining) throw failure("EdgePDFSizeError", "PDF 超过 100 MiB 限制，已停止下载。");
    const bytes = new Encoder().encode(data);
    if (bytes.length > remaining) throw failure("EdgePDFSizeError", "PDF 超过 100 MiB 限制，已停止下载。");
    return bytes;
  }

  function create({ host, parseHTML, validPDF, Zotero }) {
    if (!host || typeof host.open !== "function" || typeof host.send !== "function" || typeof host.pages !== "function" || typeof validPDF !== "function" || !Zotero?.Promise?.delay) throw new Error("Edge 全文获取模块缺少运行依赖。");
    const Encoder = global.TextEncoder || Zotero.getMainWindow?.()?.TextEncoder;
    const Decoder = global.TextDecoder || Zotero.getMainWindow?.()?.TextDecoder;
    const tasks = new Map();
    const delay = ms => Zotero.Promise.delay(ms);

    function acquire(input, { isCancelled = () => false, onProgress = async () => {} } = {}) {
      if (!input?.id) return Promise.reject(new Error("Edge 获取全文缺少原任务标识。"));
      if (tasks.get(input.id)?.running) return tasks.get(input.id).promise;
      const record = { id: input.id, root: null, pages: new Map(), cancelled: false, running: true, promise: null };
      tasks.set(input.id, record);
      record.promise = run({ ...input }, record, isCancelled, onProgress).finally(() => { record.running = false; });
      return record.promise;
    }

    async function run(task, record, isCancelled, onProgress) {
      if (task.requestID) throw new Error("已有科研通求助请使用求助下载流程。");
      const expectedDOI = normalizedDOI(task.doi), expectedTitle = strongTitle(task.title);
      const explicitURL = httpURL(task.officialURL);
      const startURL = explicitURL || (expectedDOI ? "https://doi.org/" + expectedDOI : null);
      if (!startURL || (!expectedDOI && !expectedTitle)) throw new Error("请先为原条目补全有效 DOI，或明确的论文标题与网页地址。");
      const explicitOrigin = explicitURL ? new URL(explicitURL).origin : "";
      function allowedURL(value, base) {
        const checked = publicURL(value, base);
        if (checked) return checked;
        const explicit = httpURL(value, base);
        // An explicitly selected local institution proxy may serve its own PDF;
        // public publisher links never gain access to unrelated local origins.
        return explicit && explicitOrigin && new URL(explicit).origin === explicitOrigin ? explicit : null;
      }
      const started = Date.now(), attempts = new Set(), streams = new Map(), temporaryPages = new Map(), usedCompletionProofs = new Set();
      let lastProgress = "", unsubscribe = null, lastIssue = "", knownTargetIDs = new Set(), verificationHold = null, requestEpoch = 0;
      const HOLD_MESSAGE = "请在专用 Edge 窗口手动完成验证码或登录；插件已暂停所有 PDF 请求，确认返回原论文或 PDF 后再继续。";
      function check() {
        if (record.cancelled || isCancelled()) throw failure("AbortError", "已取消 Edge 全文获取。");
        if ([...record.pages.values()].some(page => page.detached && !page.closed)) throw failure("EdgeSessionError", "Edge 页面连接已失效，已停止获取；请重新打开论文页面后重试。");
        if (Date.now() - started >= MAX_WAIT_MS) throw failure("EdgeWaitTimeout", "等待 Edge 中的人工验证或可下载 PDF 已超过 15 分钟，请完成网页操作后重试。");
      }
      async function progress(state, message) {
        check();
        const key = state + "|" + message;
        if (lastProgress === key) return;
        lastProgress = key;
        await onProgress({ state, message });
        check();
      }
      function closeStream(handle, sessionId = streams.get(handle)) {
        streams.delete(handle);
        // Browser-side stream handles are not filesystem paths.
        return Promise.resolve(host.send("IO.close", { handle }, sessionId, 2000)).catch(() => {});
      }
      async function guarded(operation, lateResult) {
        let done = false, abandoned = false, settled = false, settledValue, cleaned = false;
        const work = Promise.resolve(operation);
        // Subscribe before checking cancellation: the CDP call may already be
        // in flight, and a late stream still needs its matching IO.close.
        work.catch(() => {});
        const releaseLate = value => {
          if (lateResult && !cleaned) { cleaned = true; Promise.resolve().then(() => lateResult(value)).catch(() => {}); }
        };
        work.then(value => { settled = true; settledValue = value; if (abandoned) releaseLate(value); }).catch(() => {});
        const monitor = (async () => {
          while (!done) { await delay(100); if (!done) check(); }
          return new Promise(() => {});
        })();
        try { check(); const result = await Promise.race([work, monitor]); check(); return result; }
        catch (error) { abandoned = true; if (settled) releaseLate(settledValue); throw error; }
        finally { done = true; }
      }
      function sessionFailure(error) {
        if (error?.name === "EdgeProtocolError") return failure("EdgeSessionError", "Edge 页面连接或协议调用已失效，已停止获取；请重新打开论文页面后重试。");
        if (error?.name === "EdgeTimeoutError") return failure("EdgeSessionError", "Edge 页面响应超时，已停止获取；请确认页面可正常打开后重试。");
        return error;
      }
      async function command(method, params, page, allowNavigationRace = false) {
        check();
        try { return await guarded(host.send(method, params || {}, page?.sessionId)); }
        catch (error) {
          if (allowNavigationRace && error?.name === "EdgeProtocolError") throw error;
          throw sessionFailure(error);
        }
      }
      function terminal(error) { return ["AbortError", "EdgeWaitTimeout", "EdgeConnectionError", "EdgeSessionError", "EdgeProtocolError", "EdgeTimeoutError", "EdgePDFSizeError"].includes(error?.name); }
      async function inspect(page) {
        const before = await command("Page.getFrameTree", {}, page);
        const frame = before?.frameTree?.frame;
        if (!frame?.id) return null;
        page.mainFrameID = frame.id;
        const navigationBefore = page.navigation || 0;
        let evaluated;
        try {
          evaluated = await command("Runtime.evaluate", { expression: READ_PAGE_EXPRESSION, returnByValue: true, awaitPromise: false }, page, true);
        } catch (error) {
          if (error?.name !== "EdgeProtocolError") throw error;
          // A destroyed execution context can be a normal navigation race.
          // Probe once without evaluating or navigating again. A stable frame
          // or a failed/detached session remains an explicit error.
          const afterError = await command("Page.getFrameTree", {}, page);
          const next = afterError?.frameTree?.frame;
          if (next && (next.id !== frame.id || next.loaderId !== frame.loaderId
            || allowedURL(next.url) !== allowedURL(frame.url) || (page.navigation || 0) !== navigationBefore)) return null;
          throw sessionFailure(error);
        }
        if (evaluated?.exceptionDetails || !evaluated?.result?.value) return null;
        const snapshot = evaluated.result.value;
        const after = await command("Page.getFrameTree", {}, page);
        const latest = after?.frameTree?.frame;
        if (!latest || latest.id !== frame.id || latest.loaderId !== frame.loaderId || allowedURL(latest.url) !== allowedURL(frame.url) || allowedURL(snapshot.url) !== allowedURL(latest.url)) return null;
        snapshot.url = allowedURL(snapshot.url);
        if (!snapshot.url) return null;
        snapshot.links = (Array.isArray(snapshot.links) ? snapshot.links : []).slice(0, MAX_CANDIDATES).map(link => ({ url: allowedURL(link.url, snapshot.url), source: String(link.source || "") })).filter(link => link.url);
        snapshot.dois = Array.isArray(snapshot.dois) ? snapshot.dois.slice(0, 12) : [];
        snapshot.titles = Array.isArray(snapshot.titles) ? snapshot.titles.slice(0, 16) : [];
        snapshot.identity = articleIdentity(snapshot, expectedDOI, expectedTitle);
        snapshot.frameId = latest.id;
        snapshot.loaderId = latest.loaderId || "";
        snapshot.navigation = page.navigation || 0;
        const authorization = JSON.stringify([snapshot.gate, !!snapshot.access]);
        if (page.authorization !== undefined && page.authorization !== authorization) page.authorizationEpoch = (page.authorizationEpoch || 0) + 1;
        page.authorization = authorization;
        snapshot.signature = JSON.stringify([snapshot.url, snapshot.loaderId, snapshot.documentTime, page.authorizationEpoch || 0]);
        return snapshot;
      }
      function sameDocument(one, two) {
        return !!one && !!two && one.url === two.url && one.loaderId === two.loaderId && one.documentTime === two.documentTime && one.navigation === two.navigation;
      }
      function beginHold(page, candidateURL = null) {
        if (!verificationHold) verificationHold = { sourceID: page.id, targetID: page.id, candidateURL, evidence: null };
        return verificationHold;
      }
      function descendantOf(page, id) {
        for (let depth = 0, current = page; current && depth < 32; depth++, current = record.pages.get(current.parentId)) if (current.id === id) return true;
        return false;
      }
      function completionProof(page, snapshot) {
        if (!verificationHold || snapshot.gate === "verification" || snapshot.pending || snapshot.readyState !== "complete" || snapshot.identity === "mismatch") return null;
        const hold = verificationHold;
        const exactPDF = !snapshot.gate && !!hold.candidateURL && snapshot.url === hold.candidateURL && /^application\/pdf(?:;|$)/i.test(snapshot.contentType || "");
        const article = descendantOf(page, hold.targetID) && ["doi", "title"].includes(snapshot.identity) && snapshot.links.length;
        if (!exactPDF && !article) return null;
        // A reload is not new authorization evidence. Reusing the same positive
        // page after another denial must not start a new request loop.
        return JSON.stringify([page.id, snapshot.url, exactPDF ? "pdf" : snapshot.identity, snapshot.links.map(link => link.url), !!snapshot.access]);
      }
      function settleHold(observed) {
        if (!verificationHold) return null;
        let found = null;
        for (const entry of observed) {
          const proof = completionProof(entry.page, entry.snapshot);
          if (proof && !usedCompletionProofs.has(proof)) { found = { ...entry, proof }; break; }
        }
        if (!found) { verificationHold.evidence = null; return null; }
        const evidence = verificationHold.evidence;
        if (!evidence || evidence.proof !== found.proof || !sameDocument(evidence.snapshot, found.snapshot)) {
          verificationHold.evidence = { proof: found.proof, snapshot: found.snapshot, at: Date.now() };
          return null;
        }
        if (Date.now() - evidence.at < POLL_MS) return null;
        usedCompletionProofs.add(found.proof);
        verificationHold = null;
        requestEpoch++;
        lastIssue = "";
        return found.page.id;
      }
      async function stillBound(page, original, directPDF = false) {
        if (page.closed) return false;
        const current = await inspect(page);
        if (current?.gate === "verification" || current?.pending) { beginHold(page, page.verificationURL || null); return false; }
        if (!sameDocument(original, current) || current.identity === "mismatch") return false;
        if (!directPDF) return ["doi", "title"].includes(current.identity);
        if (page.directSourceID) {
          const source = record.pages.get(page.directSourceID);
          if (!source || source.closed) return false;
          const sourceSnapshot = await inspect(source);
          if (!sourceSnapshot || !["doi", "title"].includes(sourceSnapshot.identity) || sourceSnapshot.gate === "verification" || sourceSnapshot.pending
            || !sourceSnapshot.links.some(link => link.url === original.url)) return false;
        }
        return true;
      }
      async function showPDFVerification(page, snapshot, candidate) {
        // One visible candidate page per run. Do not navigate to an address
        // scraped from a CAPTCHA response, or repeatedly reopen a closed tab.
        if (!await stillBound(page, snapshot)) return;
        const url = allowedURL(candidate.url, snapshot.url);
        if (!url || !snapshot.links.some(link => link.url === url)) return;
        const hold = beginHold(page, url);
        if (temporaryPages.size) {
          const existing = [...temporaryPages.values()].find(value => value.verificationURL === url && !value.closed);
          hold.targetID = existing ? existing.id : null;
          return;
        }
        await progress("browser_waiting", "正在打开该论文的 PDF 入口，请在新标签页核对访问权限并手动完成需要的登录或验证。 ");
        const opened = await guarded(host.open(url), value => host.closePage?.(value));
        if (!opened?.id || !opened.sessionId) throw failure("EdgeConnectionError", "无法打开此论文的 PDF 验证页面。");
        const temporary = { ...opened, parentId: page.id, navigation: 0, approved: new Set(),
          verificationSourceID: page.id, verificationURL: url };
        temporaryPages.set(temporary.id, temporary);
        record.pages.set(temporary.id, temporary);
        knownTargetIDs.add(temporary.id);
        record.verificationPageID = temporary.id;
        hold.targetID = temporary.id;
        await command("Page.enable", {}, temporary);
        if (typeof host.focus === "function") await guarded(host.focus(temporary));
      }
      async function readResource(page, snapshot, url) {
        check();
        if (verificationHold) return null;
        let reply;
        try {
          reply = await guarded(host.send("Network.loadNetworkResource", { frameId: snapshot.frameId, url, options: { disableCache: false, includeCredentials: true } }, page.sessionId, 180000), value => {
            if (value?.resource?.stream) return closeStream(value.resource.stream, page.sessionId);
          });
        } catch (error) { throw sessionFailure(error); }
        const resource = reply?.resource;
        const handle = resource?.stream;
        if (handle) streams.set(handle, page.sessionId);
        try {
          const status = Number(resource?.httpStatusCode || 200);
          const ok = !!resource?.success && status >= 200 && status < 300;
          if (!ok || !handle) {
            lastIssue = [401, 403, 429].includes(Number(resource?.httpStatusCode)) ? "网页尚未允许下载，请在 Edge 中完成验证或登录。" : "当前 PDF 链接暂不可用，请在 Edge 中确认全文下载入口。";
            if (!handle) return { bytes: null, ok: false, status };
          }
          // A 403 may still provide a small verification HTML body. It may
          // trigger a visible candidate page, but never a successful PDF.
          const limit = ok ? MAX_PDF_BYTES : 1024 * 1024;
          const headers = resource.headers || {};
          const lengthName = Object.keys(headers).find(key => key.toLowerCase() === "content-length");
          if (Number(headers[lengthName]) > limit) {
            if (!ok) return null;
            throw failure("EdgePDFSizeError", "PDF 超过 100 MiB 限制，已停止下载。");
          }
          const chunks = []; let length = 0, emptyReads = 0;
          while (true) {
            check();
            if (page.closed || (page.navigation || 0) !== snapshot.navigation) return null;
            const chunk = await command("IO.read", { handle, size: 65536 }, page);
            let bytes;
            try { bytes = decodeChunk(chunk || {}, limit - length, Encoder); }
            catch (error) { if (!ok && error.name === "EdgePDFSizeError") return null; throw error; }
            if (bytes.length) { chunks.push(bytes); length += bytes.length; emptyReads = 0; }
            else if (!chunk?.eof && ++emptyReads > 5) throw failure("EdgePDFReadError", "Edge 文件流没有返回完整内容，请重试。");
            if (chunk?.eof) break;
          }
          const bytes = new Uint8Array(length); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          return { bytes, ok, status };
        } finally { if (handle) await Promise.race([closeStream(handle), delay(1000)]); }
      }
      async function tryCandidate(page, snapshot, candidate, directPDF = false) {
        if (verificationHold) return null;
        const attempt = page.id + "|" + requestEpoch + "|" + candidate.url;
        if (attempts.has(attempt)) return null;
        if (!await stillBound(page, snapshot, directPDF) || verificationHold) return null;
        attempts.add(attempt);
        await progress("browser_downloading", "已确认当前论文，正在通过 Edge 会话读取 PDF…");
        const response = await readResource(page, snapshot, candidate.url);
        const bytes = response?.bytes;
        check();
        if ([401, 403].includes(response?.status)) {
          lastIssue = "请在新打开的 PDF 标签页核对访问权限，完成登录或验证后插件会继续读取原论文。";
          if (directPDF) beginHold(page, candidate.url);
          else await showPDFVerification(page, snapshot, candidate);
          return null;
        }
        if (!bytes || !await stillBound(page, snapshot, directPDF)) return null;
        if (response.ok && validPDF(bytes)) return { bytes, source: "edge_browser" };
        // Some legitimate PDF links return an article-specific intermediary.
        // Follow one HTML layer only, and require its own DOI/title evidence.
        if (typeof parseHTML === "function" && bytes.length <= 1024 * 1024) {
          const html = new Decoder().decode(bytes);
          if (/^\s*(?:<!doctype\s+html|<html|<head)/i.test(html)) {
            const parsed = parseHTML(html, candidate.url), doc = parsed?.document || parsed;
            if (doc?.querySelectorAll) {
              const nested = snapshotDocument(doc, candidate.url, 0);
              const nestedIdentity = articleIdentity(nested, expectedDOI, expectedTitle);
              if (nestedIdentity === "mismatch") { lastIssue = "PDF 入口返回了另一篇论文的信息，已停止读取此链接。"; return null; }
              if (nested.gate === "verification" || nested.pending) {
                lastIssue = "请在新打开的 PDF 标签页手动完成验证，插件随后会重新读取原论文的 PDF。";
                if (directPDF) beginHold(page, candidate.url);
                else await showPDFVerification(page, snapshot, candidate);
                return null;
              }
              if (!response.ok || directPDF) return null;
              if (nested.gate === "login" && !(["doi", "title"].includes(nestedIdentity) && nested.links.length)) {
                lastIssue = "PDF 入口仍需要人工登录，请在 Edge 中完成后重试。"; return null;
              }
              if (["doi", "title"].includes(nestedIdentity)) {
                for (const link of nested.links.slice(0, MAX_CANDIDATES)) {
                  const url = allowedURL(link.url, candidate.url);
                  if (!url || url === candidate.url) continue;
                  const nestedAttempt = attempt + "|" + url;
                  if (attempts.has(nestedAttempt)) continue;
                  attempts.add(nestedAttempt);
                  const nestedResponse = await readResource(page, snapshot, url);
                  if (nestedResponse?.ok && validPDF(nestedResponse.bytes) && await stillBound(page, snapshot)) return { bytes: nestedResponse.bytes, source: "edge_browser" };
                }
              }
            }
          }
        }
        lastIssue = "下载响应不是完整 PDF，请在 Edge 中确认访问权限或下载入口。";
        return null;
      }

      try {
        await progress("browser_waiting", "正在打开专用 Edge 会话；如出现验证或登录，请在该窗口手动完成。 ");
        record.root = await guarded(host.open(startURL), page => host.closePage?.(page));
        if (!record.root?.id || !record.root.sessionId) throw failure("EdgeConnectionError", "未能连接专用 Edge 论文页面。");
        record.pages.set(record.root.id, { ...record.root, parentId: null, navigation: 0, approved: new Set() });
        knownTargetIDs.add(record.root.id);
        if (typeof host.onEvent === "function") unsubscribe = host.onEvent(event => {
          for (const page of record.pages.values()) {
            if (event.method === "Target.targetDestroyed" && event.params?.targetId === page.id) page.closed = true;
            if (event.method === "Target.detachedFromTarget" && event.params?.sessionId === page.sessionId) page.detached = true;
            if (event.sessionId !== page.sessionId) continue;
            if (event.method === "Page.frameNavigated" && !event.params?.frame?.parentId
              || event.method === "Page.navigatedWithinDocument" && event.params?.frameId === page.mainFrameID) page.navigation = (page.navigation || 0) + 1;
          }
        });
        await command("Page.enable", {}, record.root);
        while (true) {
          check();
          const targets = await guarded(host.pages());
          if (!Array.isArray(targets)) throw failure("EdgeConnectionError", "无法读取专用 Edge 页面状态。");
          const live = new Map(targets.filter(info => info.type === "page").map(info => [info.targetId || info.id, info]));
          let added = true;
          while (added) {
            added = false;
            for (const [id, info] of live) if (!knownTargetIDs.has(id) && info.openerId && knownTargetIDs.has(info.openerId)) { knownTargetIDs.add(id); added = true; }
          }
          const owned = [...live].filter(([id]) => knownTargetIDs.has(id));
          if (!owned.length) throw failure("EdgeBrowserClosedError", "专用 Edge 论文页面已关闭；重新打开页面即可重试。");
          for (const page of record.pages.values()) page.closed = !live.has(page.id);
          const observed = [];
          for (const [id, info] of owned) {
            check();
            let page = record.pages.get(id);
            if (!page) {
              try {
                const attached = await guarded(host.attach(id));
                page = { ...attached, id, parentId: info.openerId || null, navigation: 0, approved: new Set() };
                record.pages.set(id, page);
                await command("Page.enable", {}, page);
              } catch (error) { if (terminal(error)) throw error; continue; }
            }
            page.closed = false;
            let snapshot;
            try { snapshot = await inspect(page); }
            catch (error) { if (terminal(error)) throw error; continue; }
            if (!snapshot) continue;
            observed.push({ page, snapshot });
            if (snapshot.gate === "verification" || snapshot.pending) beginHold(page, page.verificationURL || null);
            if (["doi", "title"].includes(snapshot.identity) && snapshot.gate !== "verification" && !snapshot.pending) {
              page.approved = new Set(snapshot.links.map(link => link.url));
              page.articleURL = snapshot.url;
            } else if (snapshot.identity === "mismatch" || snapshot.gate === "verification" || snapshot.pending) page.approved.clear();
          }
          // Observe every owned page before sending another resource request.
          // A challenge in a sibling tab pauses the whole task, including its
          // already-authorized article page and remaining candidate loop.
          const priorityID = settleHold(observed);
          if (verificationHold) {
            await progress("browser_waiting", HOLD_MESSAGE);
            await guarded(delay(POLL_MS));
            continue;
          }
          if (priorityID) observed.sort((one, two) => Number(two.page.id === priorityID) - Number(one.page.id === priorityID));
          let sawGate = false, sawIdentity = false, sawMismatch = false;
          for (const { page, snapshot } of observed) {
            check();
            if (verificationHold) break;
            if (snapshot.gate === "verification" || snapshot.pending || snapshot.gate === "login" && !(["doi", "title"].includes(snapshot.identity) && snapshot.links.length)) {
              sawGate = true; page.approved.clear(); continue;
            }
            if (["doi", "title"].includes(snapshot.identity)) {
              sawIdentity = true;
              page.approved = new Set(snapshot.links.map(link => link.url));
              page.articleURL = snapshot.url;
              const scanKey = snapshot.signature + "|" + snapshot.links.map(link => link.url).join("|");
              if (page.lastScan !== scanKey) {
                page.lastScan = scanKey;
                await progress("browser_scanning", "已核对论文身份，正在识别该页面的全文入口…");
              }
              for (const candidate of snapshot.links) {
                try { const result = await tryCandidate(page, snapshot, candidate); if (result) { check(); return result; } }
                catch (error) { if (terminal(error)) throw error; lastIssue = "Edge 文件读取未完成，请在页面确认 PDF 可以下载后重试。"; }
                if (verificationHold || page.closed || (page.navigation || 0) !== snapshot.navigation) break;
              }
            } else {
              if (snapshot.identity === "mismatch") sawMismatch = true;
              let ancestor = page, approvedURL = false;
              for (let depth = 0; ancestor && depth < 32; depth++) {
                if (ancestor.approved.has(snapshot.url)) { approvedURL = true; break; }
                ancestor = ancestor.parentId ? record.pages.get(ancestor.parentId) : null;
              }
              const approvedPDF = snapshot.identity !== "mismatch" && approvedURL;
              if (approvedPDF) {
                sawIdentity = true;
                page.directSourceID = ancestor && ancestor.id !== page.id ? ancestor.id : null;
                try { const result = await tryCandidate(page, snapshot, { url: snapshot.url }, true); if (result) { check(); return result; } }
                catch (error) { if (terminal(error)) throw error; lastIssue = "Edge PDF 页面暂时无法读取，请回到文章页后重试。"; }
              } else page.approved.clear();
            }
          }
          const message = verificationHold ? HOLD_MESSAGE : sawGate ? "请在专用 Edge 窗口手动完成验证码或登录；完成后插件会继续识别全文。"
            : sawMismatch ? "当前页面 DOI 与原条目不同，请在 Edge 中返回该条目的论文页面。"
              : sawIdentity ? lastIssue || "已确认论文，正在等待页面出现可读取的 PDF 链接。"
                : "正在等待原论文页面；请在 Edge 中完成登录，并返回该条目的文章页。";
          await progress("browser_waiting", message);
          await guarded(delay(POLL_MS));
        }
      } finally {
        if (typeof unsubscribe === "function") unsubscribe();
        await Promise.all([...streams.keys()].map(handle => Promise.race([closeStream(handle), delay(1000)])));
        await Promise.all([...temporaryPages.values()].map(async page => {
          page.closed = true;
          if (typeof host.closePage === "function") await Promise.race([Promise.resolve(host.closePage(page)).catch(() => {}), delay(1000)]);
        }));
        record.verificationPageID = null;
      }
    }
    return {
      acquire,
      async focus(taskId) {
        const record = tasks.get(taskId);
        if (!record) return false;
        const verification = record.pages.get(record.verificationPageID);
        const root = record.pages.get(record.root?.id);
        const page = verification && !verification.closed ? verification : root && !root.closed ? root : [...record.pages.values()].find(value => !value.closed);
        if (!page || page.closed) return false;
        await host.focus(page); return true;
      },
      cancel(taskId) { const record = tasks.get(taskId); if (record) record.cancelled = true; }
    };
  }
  global.FulltextEdgeAcquire = { create };
})(this);
