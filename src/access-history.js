/* Local access experience records are hints, never proof of a site's entitlement. */
(function (global) {
  "use strict";
  const SCHEMA_VERSION = 1;
  const MAX_ENTRIES = 200;
  const STALE_AFTER_MS = 180 * 24 * 60 * 60 * 1000;
  const SOURCES = new Set(["browser_download", "browser_import", "legacy_history"]);

  function clock(value) {
    const number = value instanceof Date ? value.getTime() : Number(value);
    return Number.isFinite(number) && number >= 0 ? number : Date.now();
  }
  function normalizeDOI(value) {
    let text = typeof value === "string" ? value.trim() : "";
    if (/^https?:\/\/(?:dx\.)?doi\.org\//i.test(text)) {
      try {
        const url = new URL(text);
        if (url.username || url.password || url.search || url.hash) return "";
        text = decodeURIComponent(url.pathname.slice(1));
      } catch (_) { return ""; }
    }
    return /^10\.\d{4,9}\/[^\s<>?#]+$/i.test(text) && text.length <= 512 ? text.toLowerCase() : "";
  }
  function publisherHost(value) {
    try {
      const url = new URL(String(value || ""));
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) return "";
      const host = url.hostname.toLowerCase().replace(/\.$/, "");
      if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(host)) return "";
      if (["doi.org", "dx.doi.org", "localhost"].includes(host)) return "";
      return host;
    } catch (_) { return ""; }
  }
  function normalizedEntry(value, now) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const host = publisherHost("https://" + (typeof value.host === "string" ? value.host : ""));
    const doi = normalizeDOI(value.doi);
    const time = typeof value.at === "string" ? Date.parse(value.at) : NaN;
    if (!host || host !== value.host || !doi || !Number.isFinite(time) || time < 0 || time > now + 300000) return null;
    if (value.kind === "institutional_confirmed") {
      if (value.source !== "user_confirmation" || value.confirmedByUser !== true) return null;
      return { host, doi, kind: value.kind, source: value.source, confidence: "confirmed", confirmedByUser: true, at: new Date(time).toISOString() };
    }
    if (value.kind !== "browser_success" || !SOURCES.has(value.source)) return null;
    return { host, doi, kind: value.kind, source: value.source, confidence: "observed", confirmedByUser: false, at: new Date(time).toISOString() };
  }
  function empty() { return { schemaVersion: SCHEMA_VERSION, entries: [] }; }
  function preferred(a, b) {
    if (!a) return b;
    // Ordinary browser success cannot manufacture or refresh a user's explicit
    // statement about the institution used for an earlier successful download.
    if (a.kind !== b.kind) return a.kind === "institutional_confirmed" ? a : b;
    return Date.parse(b.at) > Date.parse(a.at) ? b : a;
  }
  function normalize(raw, { now = Date.now() } = {}) {
    now = clock(now);
    if (!raw || raw.schemaVersion !== SCHEMA_VERSION || !Array.isArray(raw.entries)) return empty();
    const records = new Map();
    for (const value of raw.entries.slice(0, MAX_ENTRIES * 10)) {
      const entry = normalizedEntry(value, now);
      if (!entry) continue;
      const key = entry.host + "\n" + entry.doi;
      records.set(key, preferred(records.get(key), entry));
    }
    return { schemaVersion: SCHEMA_VERSION, entries: [...records.values()]
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.host + a.doi).localeCompare(b.host + b.doi)).slice(0, MAX_ENTRIES) };
  }
  function record(state, event, { now = Date.now() } = {}) {
    now = clock(now);
    const host = publisherHost(event?.url), doi = normalizeDOI(event?.doi);
    const entry = normalizedEntry({ host, doi, kind: event?.kind, source: event?.source,
      confirmedByUser: event?.confirmedByUser === true, at: event?.at ?? new Date(now).toISOString() }, now);
    if (!entry) throw new Error("访问经验必须包含有效的出版社地址、DOI、来源及时间；机构下载必须由用户明确确认。");
    const result = normalize(state, { now });
    const key = result.entries.findIndex(value => value.host === host && value.doi === doi);
    if (key < 0) result.entries.unshift(entry);
    else result.entries[key] = preferred(result.entries[key], entry);
    return normalize(result, { now });
  }
  function createLookup(state, { now = Date.now() } = {}) {
    now = clock(now);
    const articles = new Map(), hosts = new Map();
    // Normalize once per snapshot. Entries are detached from the mutable input
    // and already sorted newest first, preserving the existing host-hint rule.
    for (const entry of normalize(state, { now }).entries) {
      articles.set(entry.host + "\n" + entry.doi, entry);
      if (!hosts.has(entry.host)) hosts.set(entry.host, entry);
    }
    return function lookupPrepared({ url, doi } = {}) {
      const host = publisherHost(url), expectedDOI = normalizeDOI(doi);
      const base = { scope: "none", kind: null, confidence: "none", source: null, at: null,
        host, doi: expectedDOI, stale: false, institutionalConfirmed: false, message: "" };
      if (!host) return base;
      const article = expectedDOI && articles.get(host + "\n" + expectedDOI);
      const entry = article || hosts.get(host);
      if (!entry) return base;
      const stale = now - Date.parse(entry.at) > STALE_AFTER_MS;
      const scope = article ? "article" : "host_hint";
      const confirmed = !!article && !stale && entry.kind === "institutional_confirmed";
      const message = article
        ? entry.kind === "institutional_confirmed"
          ? "你曾明确确认这篇论文通过机构下载。可优先在日常浏览器重试；历史记录不保证当前订阅仍有效。"
          : "这篇论文曾通过浏览器成功获取，访问方式未确认。可在日常浏览器重试。"
        : "这个网站的其他论文曾通过浏览器成功获取，仅作尝试提示；未确认本篇论文的机构权限。";
      return { ...base, scope, kind: entry.kind, confidence: scope === "host_hint" || stale ? "hint" : confirmed ? "confirmed" : "observed",
        source: entry.source, at: entry.at, stale, institutionalConfirmed: confirmed,
        message: (stale ? "这条访问经验已超过 180 天。" : "") + message };
    };
  }
  function lookup(state, { url, doi, now = Date.now() } = {}) {
    return createLookup(state, { now })({ url, doi });
  }
  function forget(state, { url, doi, now = Date.now() } = {}) {
    const host = publisherHost(url), expectedDOI = normalizeDOI(doi);
    const result = normalize(state, { now });
    result.entries = result.entries.filter(entry => entry.host !== host || entry.doi !== expectedDOI);
    return result;
  }
  const api = Object.freeze({ SCHEMA_VERSION, MAX_ENTRIES, STALE_AFTER_MS, empty, normalize, record, lookup, createLookup, forget, publisherHost, normalizeDOI });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.FulltextAccessHistory = api;
})(globalThis);
