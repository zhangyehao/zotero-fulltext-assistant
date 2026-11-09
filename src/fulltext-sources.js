/* Anonymous, bounded discovery only. PDF identity and import remain the caller's job.
 * Official contracts checked 2026-11-09:
 * https://developers.openalex.org/guides/authentication
 * https://developers.openalex.org/guides/content
 * https://pmc-oa-opendata.s3.amazonaws.com/README.txt
 * https://www.ebi.ac.uk/europepmc/webservices/rest/
 * https://core.ac.uk/documentation/api
 * https://www.semanticscholar.org/product/api
 * PMC's retired oa.fcgi service is deliberately not used.
 */
(function (global) {
  "use strict";
  const DEFAULT_LIMITS = Object.freeze({ timeoutMs: 15000, providerTimeoutMs: 35000, maxMetadataBytes: 2 * 1024 * 1024,
    maxPageBytes: 4 * 1024 * 1024, maxCandidates: 24, maxPerSource: 8, maxTemplates: 8, maxPDFBytes: 100 * 1024 * 1024,
    authBackoffMs: 10 * 60 * 1000, rateBackoffMs: 30000, maxBackoffMs: 60 * 60 * 1000, maxEndpointStates: 128 });
  const PROVIDERS = ["openalex", "pmc", "core", "semanticScholar", "custom"];
  const API = Object.freeze({ openalex: "https://api.openalex.org", content: "https://content.openalex.org",
    pmc: "https://pmc-oa-opendata.s3.amazonaws.com", europepmc: "https://www.ebi.ac.uk/europepmc/webservices/rest",
    converter: "https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/", core: "https://api.core.ac.uk/v3",
    semanticScholar: "https://api.semanticscholar.org/graph/v1" });
  const SECRET_PARAMETER = /^(?:api[_-]?key|access[_-]?token|authorization|auth|password|cookie|token|key|secret|session|sessionid|sid)$/i;
  const CODES = Object.freeze({ invalid_doi: "A valid DOI or PMCID is required.", no_result: "No downloadable candidate was reported.",
    no_pdf: "The record does not report an available PDF.", metadata_only: "This source reports links, not a verified hosted PDF.",
    key_required: "This operation requires a configured API key.", content_disabled: "Cached content downloads are disabled.",
    daily_limit: "The configured cached-download allowance is unavailable or exhausted.", version_filtered: "A candidate below the requested manuscript version was excluded.",
    unknown_version: "The manuscript version is not identified by this source.", doi_mismatch: "The source record has a different DOI.",
    unsafe_url: "A non-public or unsupported URL was rejected.", dns_unavailable: "The destination could not be verified as a public address.",
    private_address: "The destination resolves to a private or reserved address.", invalid_template: "A template must be a public HTTPS URL with {doi} outside its hostname.",
    template_limit: "Only the first eight distinct templates are used.", human_verification: "The page requires human verification; no automated challenge handling was attempted.",
    login_required: "The anonymous request requires website authentication.", response_too_large: "The response exceeded the bounded discovery size.",
    invalid_response: "The source returned an unsupported response.", unexpected_redirect: "An unverified redirect was rejected.",
    rate_limited: "The source requested a delay beyond this lookup's retry budget.", timeout: "The source lookup reached its time limit.",
    endpoint_backoff: "This endpoint is temporarily paused after an authentication or rate-limit response; other sources remain available.",
    network_error: "The source request failed.", disabled: "This source is disabled.", key_storage: "The configured API key could not be read.",
    source_not_enabled: "The candidate's source is no longer enabled.", untrusted_candidate: "The candidate does not have a recognized source.",
    credentials_in_url: "A URL containing credentials was rejected.", retracted: "The source marks this article version as retracted." });
  function failure(code) { const error = new Error(CODES[code] || "The source request could not be completed."); error.code = code; return error; }
  function abort() { const error = new Error("Full-text discovery was cancelled."); error.name = "AbortError"; return error; }
  function normalizeDOI(value) {
    let text = String(value || "").trim().replace(/^doi\s*:\s*/i, "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
    try { text = decodeURIComponent(text); } catch (_) {}
    return /^10\.\d{4,9}\/[^\s<>\x00-\x1f]{1,1800}$/i.test(text) ? text.replace(/[.,;]+$/, "").toLowerCase() : "";
  }
  function normalizePMCID(value) { return /^PMC[1-9]\d{0,11}$/i.test(String(value || "").trim()) ? String(value).trim().toUpperCase() : ""; }
  function version(value) {
    const name = String(value || "").replace(/[-_\s]/g, "").toLowerCase();
    if (["published", "publishedversion", "versionofrecord"].includes(name)) return "published";
    if (["accepted", "acceptedversion", "acceptedmanuscript", "authormanuscript"].includes(name)) return "accepted";
    if (["submitted", "submittedversion", "preprint"].includes(name)) return "submitted";
    return "unknown";
  }
  function acceptsVersion(candidate, preference) {
    const rank = { published: 3, accepted: 2, submitted: 1, unknown: 0 };
    const known = version(candidate);
    return known === "unknown" || preference === "any" || rank[known] >= (preference === "published" ? 3 : 2);
  }
  function publicIP(value) {
    const ip = String(value || "").replace(/^\[|\]$/g, "").toLowerCase();
    if (ip.includes(":")) {
      if (!/^[0-9a-f:]+$/.test(ip) || !/^[23][0-9a-f]{3}:/.test(ip)) return false;
      return !/^2001:db8(?::|$)/.test(ip);
    }
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return false;
    const [a,b,c,d] = ip.split(".").map(Number);
    if ([a,b,c,d].some(number => number > 255)) return false;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
      || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19)
      || a === 192 && b === 0 && (c === 0 || c === 2) || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113);
  }
  // This is the synchronous syntax/literal guard. validateURL also checks DNS.
  function safePublicURL(value, base) {
    try {
      const url = new URL(String(value || ""), base);
      if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" || url.href.length > 4096) return null;
      const host = url.hostname.toLowerCase().replace(/\.$/, "");
      if (!host || !host.includes(".") && !host.includes(":") || /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|invalid|onion)$/.test(host)) return null;
      if (/^[\d.]+$/.test(host) || host.startsWith("[")) { if (!publicIP(host)) return null; }
      for (const name of url.searchParams.keys()) if (SECRET_PARAMETER.test(name)) return null;
      url.hostname = host; url.hash = "";
      return url.href;
    } catch (_) { return null; }
  }
  function parseTemplates(value, maximum = DEFAULT_LIMITS.maxTemplates) {
    const raw = (Array.isArray(value) ? value : String(value || "").split(/[;\r\n]+/)).map(value => String(value || "").trim()).filter(Boolean);
    const templates = [], diagnostics = [];
    for (const entry of raw) {
      const expanded = entry.replaceAll("{doi}", "10.5555%2Ftemplate-check");
      // Fragments never reach the HTTP server and safePublicURL removes them.
      // Require a DOI placeholder in the transmitted portion of the template.
      let valid = entry.split("#", 1)[0].includes("{doi}") && !/\{(?!doi\})[^}]*\}/.test(entry) && !!safePublicURL(expanded);
      try { valid &&= !new URL(entry).host.includes("{doi}") && !/^https:\/\/[^/]*\{doi\}/i.test(entry); } catch (_) { valid = false; }
      if (!valid) { diagnostics.push({ source: "custom", code: "invalid_template", message: CODES.invalid_template }); continue; }
      if (templates.includes(entry)) continue;
      if (templates.length >= maximum) { if (!diagnostics.some(row => row.code === "template_limit")) diagnostics.push({ source: "custom", code: "template_limit", message: CODES.template_limit }); continue; }
      templates.push(entry);
    }
    return { templates, diagnostics };
  }
  function expandTemplate(template, doi) {
    const normalized = normalizeDOI(doi);
    if (!normalized || !parseTemplates([template]).templates.length) return null;
    return safePublicURL(template.replaceAll("{doi}", encodeURIComponent(normalized)));
  }
  function normalizeSettings(value = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)) value = {};
    const defaults = { publisher: true, openAccess: true, openalex: true, pmc: true, core: true, semanticScholar: true, custom: false };
    const enabled = Object.fromEntries(Object.entries(defaults).map(([name, fallback]) => [name, typeof value.enabled?.[name] === "boolean" ? value.enabled[name] : fallback]));
    return { enabled, versionPreference: ["published", "accepted", "any"].includes(value.versionPreference) ? value.versionPreference : "accepted",
      customTemplates: parseTemplates(value.customTemplates || []).templates,
      openalexContentEnabled: value.openalexContentEnabled === true,
      openalexDailyLimit: Number.isInteger(value.openalexDailyLimit) && value.openalexDailyLimit >= 1 && value.openalexDailyLimit <= 1000 ? value.openalexDailyLimit : 100,
      coreContentEnabled: value.coreContentEnabled === true,
      coreDailyLimit: Number.isInteger(value.coreDailyLimit) && value.coreDailyLimit >= 1 && value.coreDailyLimit <= 1000 ? value.coreDailyLimit : 20 };
  }
  function bytesOf(value) {
    if (typeof value === "string") return new TextEncoder().encode(value);
    if (value instanceof Uint8Array) return value;
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return value && typeof value.byteLength === "number" ? new Uint8Array(value) : new Uint8Array();
  }
  function create({ Zotero, Services = global.Services, parseHTML, getSettings = () => ({}), getAPIKey = async () => "",
    reserveDownloadSlot, resolveHost, request: injectedRequest, delay, now = () => Date.now(), limits: overrides = {} } = {}) {
    const limits = { ...DEFAULT_LIMITS, ...overrides };
    const sleep = delay || (milliseconds => Zotero?.Promise?.delay ? Zotero.Promise.delay(milliseconds) : new Promise(resolve => setTimeout(resolve, milliseconds)));
    const secrets = new Set(), rateQueues = new Map(), nextRequest = new Map(), endpointStates = new Map();
    const settings = () => normalizeSettings(getSettings());
    const check = context => { if (context?.isCancelled?.()) throw abort(); if (context?.deadline && now() >= context.deadline) throw failure("timeout"); };
    async function bounded(operation, context, cancel = () => {}) {
      check(context); let finished = false;
      const watcher = (async () => { while (!finished) { try { check(context); } catch (error) { try { cancel(); } catch (_) {} throw error; } await sleep(40); } return new Promise(() => {}); })();
      try { const value = await Promise.race([operation, watcher]); check(context); return value; } finally { finished = true; }
    }
    async function keyFor(provider, context) {
      try {
        const value = await bounded(Promise.resolve().then(() => getAPIKey(provider)), context);
        if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\r\n\x00]/.test(value)) return "";
        const key = value.trim(); secrets.add(key); return key;
      } catch (error) { if (error.name === "AbortError" || error.code === "timeout") throw error; throw failure("key_storage"); }
    }
    const containsSecret = value => [...secrets].some(secret => String(value).includes(secret) || String(value).includes(encodeURIComponent(secret)));
    const safe = (value, base) => { const result = safePublicURL(value, base); return result && !containsSecret(result) ? result : null; };
    async function nativeResolve(host) {
      if (!Services?.dns?.asyncResolve) throw failure("dns_unavailable");
      return new Promise((resolve, reject) => {
        const listener = { onLookupComplete(_request, record, status) {
          if (status !== 0 || !record) { reject(failure("dns_unavailable")); return; }
          try {
            if (record.QueryInterface && global.Components?.interfaces?.nsIDNSAddrRecord) record = record.QueryInterface(global.Components.interfaces.nsIDNSAddrRecord);
            const addresses = [];
            while (record.hasMore() && addresses.length < 64) addresses.push(record.getNextAddrAsString());
            resolve(addresses);
          } catch (_) { reject(failure("dns_unavailable")); }
        } };
        if (global.ChromeUtils?.generateQI) listener.QueryInterface = global.ChromeUtils.generateQI(["nsIDNSListener"]);
        try { Services.dns.asyncResolve(host, 0, 0, null, listener, Services.tm?.currentThread || null, {}); }
        catch (_) { reject(failure("dns_unavailable")); }
      });
    }
    async function validateURL(value, { isCancelled = () => false, deadline = now() + limits.timeoutMs } = {}) {
      const url = safe(value); if (!url) throw failure("unsafe_url");
      const host = new URL(url).hostname, context = { isCancelled, deadline };
      if (/^[\d.]+$/.test(host) || host.startsWith("[")) return url;
      let addresses;
      try { addresses = await bounded(Promise.resolve().then(() => (resolveHost || nativeResolve)(host)), context); }
      catch (error) { if (error.name === "AbortError" || error.code === "timeout") throw error; throw failure("dns_unavailable"); }
      if (!Array.isArray(addresses) || !addresses.length) throw failure("dns_unavailable");
      if (addresses.some(value => !publicIP(value))) throw failure("private_address");
      return url;
    }
    async function throttle(source, context) {
      const previous = rateQueues.get(source) || Promise.resolve();
      const operation = previous.catch(() => {}).then(async () => {
        check(context);
        const wait = Math.max(0, (nextRequest.get(source) || 0) - now());
        if (wait) await bounded(sleep(wait), context);
        check(context); nextRequest.set(source, now() + (source === "semanticScholar" || source === "core" ? 1050 : 200));
      });
      rateQueues.set(source, operation);
      try { await bounded(operation, context); } finally { if (rateQueues.get(source) === operation) rateQueues.delete(source); }
    }
    function responseHeader(response, name) {
      // Native Zotero redirect responses throw when a channel header is absent.
      try { return response?.getResponseHeader?.(name) || response?.headers?.get?.(name) || response?.headers?.[name.toLowerCase()] || response?.headers?.[name] || ""; }
      catch (_) { return ""; }
    }
    function endpointKey(url, source, headers = {}) {
      // Authentication is kept only in this bounded in-memory map, never in
      // returned candidates, diagnostics, history, progress or persisted state.
      const auth = Object.entries(headers).filter(([name]) => /^(?:authorization|x-api-key)$/i.test(name)).map(([name,value]) => name.toLowerCase() + ":" + value).sort().join("\n");
      return source + "|" + new URL(url).origin + "|" + auth;
    }
    function checkEndpoint(url, source, headers = {}) {
      const state = endpointStates.get(endpointKey(url, source, headers));
      if (state?.until > now()) throw failure("endpoint_backoff");
    }
    function retryDelay(raw, fallback) {
      const value = /^\d+(?:\.\d+)?$/.test(String(raw)) ? Number(raw) * 1000 : raw ? Date.parse(raw) - now() : fallback;
      return Number.isFinite(value) ? Math.max(0, value) : fallback;
    }
    function recordResponse(url, { source, headers = {}, status, retryAfter = "" } = {}) {
      const key = endpointKey(url, source, headers), previous = endpointStates.get(key);
      if (status >= 200 && status < 300) { endpointStates.delete(key); return; }
      if (![401,403,429,503].includes(Number(status))) return;
      const strikes = Math.min(8, (previous?.strikes || 0) + 1);
      const base = [401,403].includes(Number(status)) ? limits.authBackoffMs : limits.rateBackoffMs;
      const duration = Math.min(limits.maxBackoffMs, Math.max(base * 2 ** (strikes - 1), retryDelay(retryAfter, 0)));
      endpointStates.delete(key); endpointStates.set(key, { until: now() + duration, strikes });
      while (endpointStates.size > limits.maxEndpointStates) endpointStates.delete(endpointStates.keys().next().value);
    }
    async function beforeRequest(url, { source, headers = {}, isCancelled = () => false, deadline = now() + limits.timeoutMs } = {}) {
      const context = { isCancelled, deadline }; check(context); checkEndpoint(url, source, headers);
      await throttle(source, context); check(context); checkEndpoint(url, source, headers);
    }
    async function send(address, { source, headers = {}, maxBytes = limits.maxMetadataBytes, context, detectPDF = false, allowRedirects = false } = {}) {
      checkEndpoint(address, source, headers);
      let url = await validateURL(address, context);
      const initialOrigin = new URL(url).origin;
      for (let hop = 0; hop < 4; hop++) {
        check(context); let response;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (!attempt) await beforeRequest(url, { source, headers, ...context });
          else await throttle(source, context);
          check(context);
          let cancel = () => {}, oversized = false, directPDF = false;
          const options = { responseType: "arraybuffer", successCodes: false, timeout: Math.max(1, Math.min(limits.timeoutMs, context.deadline - now())),
            anon: true, followRedirects: false, headers: { Accept: detectPDF ? "application/pdf,text/html;q=0.9" : "application/json,application/xml;q=0.9", ...headers },
            debug: false, logBodyLength: 0, errorDelayMax: 0, noRetryOnThrottle: true,
            cancellerReceiver(value) { cancel = value; }, requestObserver(xhr) {
              xhr.addEventListener?.("progress", event => { if (event.loaded > maxBytes) { oversized = true; xhr.abort(); } });
              if (detectPDF) xhr.addEventListener?.("readystatechange", () => {
                if (xhr.readyState >= 2 && xhr.status >= 200 && xhr.status < 300 && /application\/pdf/i.test(xhr.getResponseHeader?.("Content-Type") || "")) { directPDF = true; xhr.abort(); }
              });
            } };
          try {
            const operation = injectedRequest ? injectedRequest({ url, method: "GET", ...options, maxBytes }) : Zotero.HTTP.request("GET", url, options);
            response = await bounded(Promise.resolve(operation), { ...context, deadline: Math.min(context.deadline, now() + limits.timeoutMs) }, () => cancel());
          } catch (error) {
            check(context);
            if (error.name === "AbortError" || error.code === "timeout") throw error;
            if (directPDF) return { url, bytes: new Uint8Array(), status: 200, type: "application/pdf", directPDF: true };
            if (oversized) throw failure("response_too_large");
            throw failure("network_error");
          }
          if (directPDF) return { url, bytes: new Uint8Array(), status: 200, type: "application/pdf", directPDF: true };
          if (oversized) throw failure("response_too_large");
          const finalURL = response.responseURL || response.url;
          if (finalURL && finalURL !== url) throw failure("unexpected_redirect");
          const status = Number(response.status);
          recordResponse(url, { source, headers, status, retryAfter: responseHeader(response, "Retry-After") });
          if (![429, 503].includes(status)) break;
          const raw = responseHeader(response, "Retry-After");
          const retryMs = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 1000 : raw ? Date.parse(raw) - now() : 1000;
          if (attempt || !Number.isFinite(retryMs) || retryMs > 5000 || now() + Math.max(0, retryMs) >= context.deadline) throw failure("rate_limited");
          await bounded(sleep(Math.max(0, retryMs)), context);
        }
        const status = Number(response.status);
        if (status >= 300 && status < 400) {
          const target = safe(responseHeader(response, "Location"), url);
          if (!allowRedirects || !target || hop >= 3) throw failure("unexpected_redirect");
          // Custom requests are always anonymous. API requests never follow a redirect.
          if (Object.keys(headers).some(name => /authorization|key|cookie/i.test(name)) && new URL(target).origin !== initialOrigin) throw failure("unexpected_redirect");
          url = await validateURL(target, context); continue;
        }
        if (/challenge/i.test(responseHeader(response, "cf-mitigated"))) throw failure("human_verification");
        if (status === 401) throw failure(detectPDF ? "login_required" : "key_required");
        if (status === 403) throw failure("login_required");
        if (status === 404) throw failure("no_result");
        if (status < 200 || status >= 300) throw failure("network_error");
        const bytes = bytesOf(response.response ?? response.bytes ?? response.body);
        if (bytes.length > maxBytes || Number(responseHeader(response, "Content-Length")) > maxBytes) throw failure("response_too_large");
        return { url, bytes, status, type: responseHeader(response, "Content-Type"), directPDF: false };
      }
      throw failure("unexpected_redirect");
    }
    const decode = bytes => new TextDecoder("utf-8").decode(bytes);
    async function json(url, options) {
      const result = await send(url, options);
      try { return JSON.parse(decode(result.bytes)); } catch (_) { throw failure("invalid_response"); }
    }
    function parsePage(html, pageURL, expectedDOI = "") {
      if (typeof html !== "string" || html.length > limits.maxPageBytes || !safe(pageURL)) return { candidates: [], code: "invalid_response" };
      if (/cf-chl-|challenge-platform|g-recaptcha|h-captcha|hcaptcha|verify (?:that )?you are human|checking your browser|captcha-container/i.test(html)) return { candidates: [], code: "human_verification" };
      if (!parseHTML) return { candidates: [], code: "invalid_response" };
      let doc;
      try { const parsed = parseHTML(html); doc = parsed.document || parsed; } catch (_) { return { candidates: [], code: "invalid_response" }; }
      if (doc.querySelector('input[type="password"]')) return { candidates: [], code: "login_required" };
      const statedDOI = normalizeDOI(doc.querySelector('meta[name="citation_doi"],meta[name="dc.Identifier"],meta[name="dc.identifier"]')?.getAttribute("content"));
      if (statedDOI && expectedDOI && statedDOI !== normalizeDOI(expectedDOI)) return { candidates: [], code: "doi_mismatch" };
      const candidates = [], seen = new Set();
      function add(value, kind, evidence) {
        const url = safe(value, pageURL);
        if (!url || seen.has(url) || candidates.length >= limits.maxPerSource) return;
        seen.add(url); candidates.push({ url, kind, source: "custom", version: "unknown", license: "", evidence, referrer: null });
      }
      for (const meta of doc.querySelectorAll('meta[name="citation_pdf_url"],meta[name="wkhealth_pdf_url"],meta[name="eprints.document_url"]')) add(meta.getAttribute("content"), "pdf", "page_pdf_metadata");
      for (const node of doc.querySelectorAll("iframe[src],embed[src],object[data]")) {
        const target = node.getAttribute("src") || node.getAttribute("data");
        add(target, /\.pdf(?:[?#]|$)/i.test(target || "") || /pdf/i.test(node.getAttribute("type") || "") ? "pdf" : "page", "page_embedded_resource");
      }
      for (const link of doc.querySelectorAll('a[href],link[href][type="application/pdf"]')) {
        const target = link.getAttribute("href") || "";
        if (/\.pdf(?:[?#]|$)/i.test(target) || /pdf/i.test(link.getAttribute("type") || "") || /\bpdf\b|下载全文|下載全文/i.test(link.textContent || "")) add(target, "pdf", "page_pdf_link");
      }
      return { candidates, code: candidates.length ? null : "no_pdf" };
    }
    async function discover(input, { isCancelled = () => false, onProgress = () => {}, onCandidates } = {}) {
      const config = settings(), doi = normalizeDOI(typeof input === "string" ? input : input?.doi || input?.DOI || input?.getField?.("DOI"));
      const pmcid = normalizePMCID(input?.pmcid);
      if (isCancelled()) throw abort();
      if (!doi && !pmcid) return { candidates: [], diagnostics: [{ source: "sources", code: "invalid_doi", message: CODES.invalid_doi }] };
      const enabled = PROVIDERS.filter(name => config.enabled[name] && (doi || name === "pmc"));
      let stopped = false, accepted = null, callbackError = null, delivery = Promise.resolve();
      const cancelled = () => stopped || isCancelled();
      const results = [], delivered = new Set(), pending = [], pendingDiagnostics = [];
      let draining = false;
      const priority = candidate => candidate.fallbackOnly ? 4 : candidate.evidence === "pmc_article_dataset_pdf" ? 0 : candidate.kind === "pdf" ? 1 : 2;
      const rank = candidates => candidates.sort((a,b) => priority(a) - priority(b));
      async function runProvider(provider, suppliedKey) {
        const context = { isCancelled: cancelled, deadline: now() + limits.providerTimeoutMs }, candidates = [], diagnostics = [];
        function note(code) { if (!diagnostics.some(row => row.code === code)) diagnostics.push({ source: provider, code, message: CODES[code] || CODES.network_error }); }
        function add(candidate) {
          const url = safe(candidate.url); if (!url) { note("unsafe_url"); return; }
          const candidateVersion = version(candidate.version);
          if (!acceptsVersion(candidateVersion, config.versionPreference)) { note("version_filtered"); return; }
          if (candidates.length >= limits.maxPerSource || candidates.some(row => row.url === url)) return;
          if (candidateVersion === "unknown") note("unknown_version");
          candidates.push({ ...candidate, url, version: candidateVersion, source: candidate.source || provider, license: typeof candidate.license === "string" && !containsSecret(candidate.license) ? candidate.license.slice(0, 120) : "" });
        }
        try {
          check(context); onProgress({ stage: "source_lookup", source: provider, message: "Querying a configured full-text source." });
          if (provider === "openalex") {
            const key = await keyFor("openalex", context), headers = key ? { Authorization: "Bearer " + key } : {};
            const address = API.openalex + "/works/https://doi.org/" + encodeURIComponent(doi) + "?select=id,doi,primary_location,best_oa_location,locations,has_content,content_urls";
            const work = await json(address, { source: provider, headers, context });
            if (normalizeDOI(work.doi) !== doi) throw failure("doi_mismatch");
            if (work.has_content?.pdf === true && work.content_urls?.pdf) {
              if (!config.openalexContentEnabled) note("content_disabled");
              else if (!key) note("key_required");
              else {
                const contentURL = safe(work.content_urls.pdf), workID = /^https:\/\/openalex\.org\/(W\d+)$/i.exec(work.id || "")?.[1];
                if (contentURL && workID && contentURL === API.content + "/works/" + workID + ".pdf") add({ url: contentURL, kind: "pdf", source: "openalex", evidence: "openalex_cached_pdf", version: "unknown", requiresKey: true, credentialScope: "openalex", workID });
                else note("unsafe_url");
              }
            }
            for (const location of [work.best_oa_location, work.primary_location, ...(Array.isArray(work.locations) ? work.locations.slice(0, 50) : [])]) {
              if (!location || location.is_oa !== true) continue;
              add({ url: location.pdf_url || location.landing_page_url, kind: location.pdf_url ? "pdf" : "page", evidence: "openalex_oa_location", version: location.version, license: location.license || "" });
            }
            note("metadata_only");
          } else if (provider === "pmc") {
            let identifier = pmcid;
            const query = doi ? 'DOI:"' + doi.replace(/["\\]/g, "") + '"' : 'EXT_ID:"' + pmcid + '" AND SRC:PMC';
            const address = API.europepmc + "/search?query=" + encodeURIComponent(query) + "&format=json&resultType=core&pageSize=3";
            let records = [];
            try { const result = await json(address, { source: provider, context }); records = result.resultList?.result || []; }
            catch (error) { if (error.name === "AbortError" || error.code === "timeout") throw error; note(error.code || "network_error"); }
            for (const record of records.slice(0, 3)) {
              if (doi && normalizeDOI(record.doi) !== doi || pmcid && normalizePMCID(record.pmcid) !== pmcid) { note("doi_mismatch"); continue; }
              identifier ||= normalizePMCID(record.pmcid);
              for (const link of record.fullTextUrlList?.fullTextUrl || []) {
                if (link.availabilityCode !== "OA" && link.availability !== "Open access") continue;
                if (!["pdf", "html"].includes(String(link.documentStyle).toLowerCase())) continue;
                add({ url: link.url, kind: link.documentStyle.toLowerCase() === "pdf" ? "pdf" : "page", source: "pmc", evidence: "europepmc_fulltext_link", version: record.isPreprint === "Y" ? "submitted" : "unknown", pmcid: identifier });
              }
            }
            if (!identifier && doi) {
              const mapped = await json(API.converter + "?ids=" + encodeURIComponent(doi) + "&format=json&tool=zotero_fulltext_assistant", { source: provider, context });
              identifier = normalizePMCID((mapped.records || []).find(row => normalizeDOI(row.doi || row.requestedId) === doi)?.pmcid);
            }
            if (identifier) {
              const listing = await send(API.pmc + "/?list-type=2&prefix=" + encodeURIComponent("metadata/" + identifier + ".") + "&max-keys=10", { source: provider, context });
              const keys = [...decode(listing.bytes).matchAll(/<Key>([^<]+)<\/Key>/g)].map(match => match[1]).filter(key => new RegExp("^metadata/" + identifier + "\\.[1-9]\\d*\\.json$").test(key)).sort((a,b) => Number(b.match(/\.(\d+)\.json$/)[1]) - Number(a.match(/\.(\d+)\.json$/)[1])).slice(0, 3);
              for (const path of keys) {
                const metadata = await json(API.pmc + "/" + path, { source: provider, context });
                if (normalizePMCID(metadata.pmcid) !== identifier || doi && normalizeDOI(metadata.doi) !== doi) { note("doi_mismatch"); continue; }
                if (metadata.is_retracted === true) { note("retracted"); continue; }
                let pdf = metadata.pdf_url;
                if (typeof pdf === "string" && pdf.startsWith("s3://pmc-oa-opendata/")) pdf = API.pmc + "/" + pdf.slice("s3://pmc-oa-opendata/".length);
                const address = safe(pdf);
                if (address && new URL(address).origin === API.pmc) add({ url: address, kind: "pdf", source: "pmc", evidence: "pmc_article_dataset_pdf", version: metadata.is_manuscript === true ? "accepted" : metadata.is_manuscript === false ? "published" : "unknown", license: metadata.license_code || "", pmcid: identifier, articleVersion: String(metadata.version || "") });
                else if (pdf) note("unsafe_url"); else note("no_pdf");
              }
            }
          } else if (provider === "core") {
            const key = suppliedKey === undefined ? await keyFor("core", context) : suppliedKey, headers = key ? { Authorization: "Bearer " + key } : {};
            const result = await json(API.core + "/search/works/?q=" + encodeURIComponent('doi:"' + doi.replace(/["\\]/g, "") + '"') + "&limit=5", { source: provider, headers, context });
            const outputIDs = new Set();
            for (const record of (result.results || []).slice(0, 5)) {
              if (normalizeDOI(record.doi) !== doi) { note("doi_mismatch"); continue; }
              const url = record.downloadUrl;
              if (url) {
                const parsed = safe(url), isAPI = parsed && new URL(parsed).origin === "https://api.core.ac.uk";
                if (isAPI) {
                  const id = /^https:\/\/api\.core\.ac\.uk\/v3\/outputs\/([1-9]\d{0,19})\/download\/?$/.exec(parsed)?.[1];
                  if (id) outputIDs.add(id); else note("unsafe_url");
                } else add({ url, kind: "pdf", source: "core", evidence: "core_download_url", version: "unknown", license: record.license || "" });
              }
              for (const address of (Array.isArray(record.outputs) ? record.outputs : []).slice(0, 8)) {
                // These are output references supplied by a DOI-matching work.
                // A work's own id is never an output id or a download locator.
                const id = typeof address === "string" && /^https:\/\/api\.core\.ac\.uk\/v3\/outputs\/([1-9]\d{0,19})$/.exec(address)?.[1];
                if (id) outputIDs.add(id); else note("unsafe_url");
              }
            }
            if (outputIDs.size && !config.coreContentEnabled) note("content_disabled");
            else if (outputIDs.size && !key) note("key_required");
            else for (const outputID of [...outputIDs].slice(0, 3)) add({
              url: API.core + "/outputs/" + outputID + "/download", kind: "pdf", source: "core", evidence: "core_output_reference",
              doi, outputID, credentialScope: "core", requiresKey: true, fallbackOnly: true, version: "unknown",
            });
            note("metadata_only");
          } else if (provider === "semanticScholar") {
            const key = await keyFor("semanticScholar", context), headers = key ? { "x-api-key": key } : {};
            const result = await json(API.semanticScholar + "/paper/" + encodeURIComponent("DOI:" + doi) + "?fields=title,externalIds,openAccessPdf,isOpenAccess", { source: provider, headers, context });
            if (result.externalIds?.DOI && normalizeDOI(result.externalIds.DOI) !== doi) throw failure("doi_mismatch");
            if (result.openAccessPdf?.url) add({ url: result.openAccessPdf.url, kind: "pdf", source: "semanticScholar", evidence: "semantic_scholar_open_access_link", version: "unknown", license: result.openAccessPdf.license || "" });
            note("metadata_only");
          } else {
            const parsed = parseTemplates(config.customTemplates || [], limits.maxTemplates); diagnostics.push(...parsed.diagnostics);
            for (const template of parsed.templates) {
              check(context);
              const url = expandTemplate(template, doi); if (!url) { note("invalid_template"); continue; }
              try {
                const result = await send(url, { source: "custom:" + new URL(url).origin, context, maxBytes: limits.maxPageBytes, detectPDF: true, allowRedirects: true });
                if (result.directPDF || /^%PDF-\d\.\d/.test(decode(result.bytes.subarray(0, 32)).trimStart())) add({ url: result.url, kind: "pdf", source: "custom", evidence: "custom_http_pdf", version: "unknown" });
                else {
                  const page = parsePage(decode(result.bytes), result.url, doi);
                  for (const candidate of page.candidates) add(candidate);
                  if (page.code) note(page.code);
                }
              } catch (error) { if (error.name === "AbortError" || error.code === "timeout") throw error; note(error.code || "network_error"); }
            }
          }
        } catch (error) { if (error.name === "AbortError") throw error; note(error.code || "network_error"); }
        if (!candidates.length && !diagnostics.length) note("no_result");
        check({ isCancelled: cancelled }); return { provider, candidates: rank(candidates), diagnostics };
      }
      function deliver(result, { includeFallback = false, collect = true } = {}) {
        if (collect) results.push(result);
        if (typeof onCandidates !== "function") return Promise.resolve();
        pendingDiagnostics.push(...result.diagnostics);
        for (const candidate of result.candidates) {
          if (candidate.fallbackOnly && !includeFallback || delivered.has(candidate.url) || delivered.size >= limits.maxCandidates) continue;
          delivered.add(candidate.url); pending.push(candidate);
        }
        if (!draining) {
          draining = true;
          delivery = (async () => {
            try {
              while (!stopped && (pending.length || pendingDiagnostics.length)) {
                check({ isCancelled });
                // Re-rank at every completed download boundary. A ready PMC
                // dataset PDF need not wait behind another provider's batch.
                const candidate = rank(pending).shift();
                const value = await onCandidates({ candidates: candidate ? [candidate] : [], diagnostics: pendingDiagnostics.splice(0) });
                // The caller only accepts after download and identity checks.
                if (value) { accepted = value; stopped = true; }
              }
            } catch (error) { callbackError ||= error; stopped = true; }
            finally { draining = false; }
          })();
        }
        return delivery;
      }
      async function job(provider, suppliedKey) {
        try { if (!stopped) await deliver(await runProvider(provider, suppliedKey)); }
        catch (error) { if (error.name !== "AbortError" || !stopped) throw error; }
      }
      async function phase(jobs) {
        const completed = await Promise.allSettled(jobs);
        await delivery;
        if (callbackError) throw callbackError;
        const failed = completed.find(result => result.status === "rejected");
        // A committed import wins over a cancellation arriving during cleanup.
        if (!accepted) { if (failed) throw failed.reason; check({ isCancelled }); }
      }
      let deferredCore = false;
      const primary = enabled.filter(name => name !== "core" && name !== "custom").map(name => job(name));
      if (enabled.includes("core")) primary.push((async () => {
        try {
          const key = await keyFor("core", { isCancelled: cancelled, deadline: now() + limits.providerTimeoutMs });
          if (key) await job("core", key); else deferredCore = true;
        } catch (error) {
          if (error.name === "AbortError") { if (!stopped) throw error; }
          else await deliver({ provider: "core", candidates: [], diagnostics: [{ source: "core", code: error.code || "key_storage", message: CODES[error.code] || CODES.key_storage }] });
        }
      })());
      await phase(primary);
      if (!stopped) await phase([
        ...(deferredCore ? [job("core", "")] : []),
        ...(enabled.includes("custom") ? [job("custom")] : []),
      ]);
      if (!stopped && typeof onCandidates === "function") {
        // Hosted CORE PDFs can consume the provider's allowance. All ordinary
        // source candidates must have had their chance before this fallback.
        await deliver({ provider: "core", candidates: results.flatMap(result => result.candidates).filter(candidate => candidate.fallbackOnly), diagnostics: [] }, { includeFallback: true, collect: false });
        if (callbackError) throw callbackError;
        if (!accepted) check({ isCancelled });
      }
      // The non-streaming contract remains deterministic for existing callers.
      results.sort((a,b) => PROVIDERS.indexOf(a.provider) - PROVIDERS.indexOf(b.provider));
      const all = [], seen = new Set();
      for (const result of results) for (const candidate of result.candidates) if (!seen.has(candidate.url)) { seen.add(candidate.url); all.push(candidate); }
      rank(all);
      return { candidates: all.slice(0, limits.maxCandidates), diagnostics: results.flatMap(result => result.diagnostics), ...(accepted ? { accepted } : {}) };
    }
    async function prepareRequest(candidate, { isCancelled = () => false } = {}) {
      const context = { isCancelled, deadline: now() + limits.timeoutMs }, config = settings(); check(context);
      if (!candidate || !PROVIDERS.includes(candidate.source)) throw failure("untrusted_candidate");
      if (!config.enabled[candidate.source]) throw failure("source_not_enabled");
      if (!acceptsVersion(candidate.version, config.versionPreference)) throw failure("version_filtered");
      const url = await validateURL(candidate.url, context), parsed = new URL(url), headers = { Accept: "application/pdf,text/html;q=0.9" };
      let fulltextVersion = version(candidate.version);
      if (candidate.credentialScope === "openalex" || parsed.origin === API.content) {
        if (candidate.source !== "openalex" || candidate.evidence !== "openalex_cached_pdf" || parsed.origin !== API.content || !/^\/works\/W\d+\.pdf$/.test(parsed.pathname) || parsed.search) throw failure("unsafe_url");
        if (!config.openalexContentEnabled) throw failure("content_disabled");
        const key = await keyFor("openalex", context); if (!key) throw failure("key_required");
        headers.Authorization = "Bearer " + key;
        checkEndpoint(url, candidate.source, headers);
        if (!reserveDownloadSlot || !config.openalexDailyLimit) throw failure("daily_limit");
        let reserved;
        try { reserved = await bounded(Promise.resolve().then(() => reserveDownloadSlot({ provider: "openalex", limit: config.openalexDailyLimit, key })), context); }
        catch (error) { if (error.name === "AbortError" || error.code === "timeout") throw error; throw failure("daily_limit"); }
        if (!(reserved === true || reserved?.allowed === true)) throw failure("daily_limit");
      } else if (candidate.credentialScope === "core" || parsed.origin === "https://api.core.ac.uk") {
        const outputID = /^\/v3\/outputs\/([1-9]\d{0,19})\/download$/.exec(parsed.pathname)?.[1];
        if (candidate.source !== "core" || candidate.evidence !== "core_output_reference" || candidate.fallbackOnly !== true || candidate.outputID !== outputID || !outputID || parsed.origin !== "https://api.core.ac.uk" || parsed.search) throw failure("unsafe_url");
        if (!config.coreContentEnabled) throw failure("content_disabled");
        const key = await keyFor("core", context); if (!key) throw failure("key_required");
        headers.Authorization = "Bearer " + key;
        checkEndpoint(url, candidate.source, headers);
        const expectedDOI = normalizeDOI(candidate.doi); if (!expectedDOI) throw failure("invalid_doi");
        const output = await json(API.core + "/outputs/" + outputID, { source: "core", headers: { Accept: "application/json", Authorization: headers.Authorization }, context });
        if (String(output.id) !== outputID) throw failure("invalid_response");
        if (normalizeDOI(output.doi) !== expectedDOI) throw failure("doi_mismatch");
        if (![undefined,null,false,0].includes(output.disabled) || ![undefined,null,false,0,"ALLOWED"].includes(output.deleted)
          || (output.fulltextStatus ?? output.fulltext_status) !== "enabled") throw failure("no_pdf");
        const versions = [output.version, ...(Array.isArray(output.versions) ? output.versions : [])].map(version);
        fulltextVersion = versions.includes("published") ? "published" : versions.includes("accepted") ? "accepted" : versions.includes("submitted") ? "submitted" : "unknown";
        // Output metadata may take time. Revoked hosted consent or stricter
        // settings must take effect before a PDF allowance is reserved.
        const current = settings();
        if (!current.enabled.core) throw failure("source_not_enabled");
        if (!current.coreContentEnabled) throw failure("content_disabled");
        if (!acceptsVersion(fulltextVersion, current.versionPreference)) throw failure("version_filtered");
        if (!reserveDownloadSlot || !current.coreDailyLimit) throw failure("daily_limit");
        let reserved;
        try { reserved = await bounded(Promise.resolve().then(() => reserveDownloadSlot({ provider: "core", limit: current.coreDailyLimit, key })), context); }
        catch (error) { if (error.name === "AbortError" || error.code === "timeout") throw error; throw failure("daily_limit"); }
        if (!(reserved === true || reserved?.allowed === true)) throw failure("daily_limit");
      } else if (candidate.credentialScope) throw failure("unsafe_url");
      checkEndpoint(url, candidate.source, headers);
      check(context);
      return { url, method: "GET", responseType: "arraybuffer", anon: true, followRedirects: false, timeout: limits.timeoutMs, maxBytes: limits.maxPDFBytes,
        debug: false, logBodyLength: 0, errorDelayMax: 0, noRetryOnThrottle: true, headers, allowedRedirectOrigins: [parsed.origin],
        source: candidate.source, credentialScope: candidate.credentialScope || null, fulltextVersion };
    }
    return Object.freeze({ discover, prepareRequest, validateURL, parsePage, beforeRequest, recordResponse });
  }
  global.FulltextSources = Object.freeze({ create, normalizeSettings, normalizeDOI, normalizePMCID, safePublicURL, publicIP, parseTemplates, expandTemplate, version, acceptsVersion, DEFAULT_LIMITS });
})(globalThis);
