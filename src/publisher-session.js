/* Remember only explicitly confirmed publisher/SSO hosts in Zotero's default jar. */
(function (scope) {
  "use strict";
  const ORIGIN = "chrome://fulltext-assistant";
  const REALM = "Publisher session cookies";
  const USERNAME = "publisher-session-v1";
  const HOSTS_PREF = "extensions.fulltext-assistant.publisherSessionHosts";
  const MAX_HOSTS = 60;
  const MAX_COOKIES = 500;
  const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
  function normalizeHost(value) {
    try {
      if (typeof value !== "string" || !value || /[\s/:@?#]/.test(value)) return null;
      const host = new URL("https://" + value).hostname.toLowerCase();
      return host === "localhost" || !host.includes(".") ? null : host;
    } catch (_) { return null; }
  }
  function matchesHost(cookieHost, host) {
    if (typeof cookieHost !== "string") return false;
    const clean = cookieHost.replace(/^\./, "").toLowerCase();
    return clean === host || (cookieHost.startsWith(".") && host.endsWith("." + clean));
  }
  function create({ Zotero, Services, makeLogin }) {
    if (!Services?.logins || !Services?.cookies || !Services?.prefs || !Services?.obs) throw new Error("出版社登录的安全存储不可用。");
    let hosts = [];
    try { hosts = [...new Set(JSON.parse(Services.prefs.getStringPref(HOSTS_PREF, "[]")).map(normalizeHost).filter(Boolean))].slice(0, MAX_HOSTS); } catch (_) {}
    let initialized = false, initialization, destroyed = false, clearing = false, observerAdded = false;
    let writes = Promise.resolve(), generation = 0, ticket = 0, savedAt = null, hasBackup = false, storageError = null;
    const active = () => { if (destroyed) throw new Error("出版社会话已关闭。"); };
    const own = cookie => cookie && (cookie.originAttributes?.userContextId || 0) === 0
      && (cookie.originAttributes?.privateBrowsingId || 0) === 0
      && !cookie.originAttributes?.partitionKey && !cookie.originAttributes?.firstPartyDomain
      && hosts.some(host => matchesHost(cookie.host, host));
    // Zotero 10.0.7 uses Gecko ESR 140, whose nsICookie.expiry/add use seconds.
    // Keep that expiry unchanged; a session cookie can still have an earlier expiry.
    const unexpired = cookie => Number.isFinite(cookie.expiry) && cookie.expiry > Date.now() / 1000;
    function restorableExpiry(cookie) {
      // Gecko's no-expiry session sentinel is INT64_MAX, which JS cannot round-trip
      // as a signed 64-bit integer. Shorten only that unsafe sentinel to our local
      // retention limit; never extend an explicit, representable site expiry.
      return Number.isSafeInteger(cookie.expiry) ? cookie.expiry : Math.min(cookie.expiry, Math.floor(Date.now() / 1000) + MAX_AGE / 1000);
    }
    function cookies() {
      const result = new Map();
      for (const host of hosts) for (const cookie of Services.cookies.getCookiesFromHost(host, { userContextId: 0, privateBrowsingId: 0 })) {
        if (own(cookie)) result.set([cookie.host, cookie.path, cookie.name].join("\n"), cookie);
      }
      return [...result.values()];
    }
    function record(cookie) {
      return { host: cookie.host, path: cookie.path, name: cookie.name, value: cookie.value,
        isSecure: cookie.isSecure, isHttpOnly: cookie.isHttpOnly, isSession: true,
        expiry: restorableExpiry(cookie), sameSite: cookie.sameSite, schemeMap: cookie.schemeMap };
    }
    const ready = async () => { if (Services.logins.initializationPromise) await Services.logins.initializationPromise; };
    const stored = () => Services.logins.findLogins(ORIGIN, null, REALM);
    function login(password) {
      if (makeLogin) return makeLogin(ORIGIN, REALM, USERNAME, password);
      const value = Components.classes["@mozilla.org/login-manager/loginInfo;1"].createInstance(Components.interfaces.nsILoginInfo);
      value.init(ORIGIN, null, REALM, USERNAME, password, "", ""); return value;
    }
    async function write(value) {
      await ready();
      const previous = stored();
      if (value) {
        const next = login(JSON.stringify(value));
        if (previous.length) Services.logins.modifyLogin(previous[0], next);
        else await Services.logins.addLoginAsync(next);
        for (const duplicate of previous.slice(1)) Services.logins.removeLogin(duplicate);
      } else for (const previousLogin of previous) Services.logins.removeLogin(previousLogin);
    }
    async function flush() {
      active();
      if (!initialized || clearing || !hosts.length) return getStatus();
      const expected = generation;
      const value = { version: 1, savedAt: new Date().toISOString(), cookies: cookies().filter(cookie => cookie.isSession && unexpired(cookie)).slice(0, MAX_COOKIES).map(record) };
      const operation = writes.catch(() => {}).then(async () => {
        if (expected !== generation || clearing) return;
        await write(value.cookies.length ? value : null);
        savedAt = value.cookies.length ? value.savedAt : null; hasBackup = value.cookies.length > 0; storageError = null;
      });
      writes = operation;
      try { await operation; return getStatus(); }
      catch (_) { storageError = "机构登录会话未能加密保存，请解锁 Zotero 凭据存储后重试。"; throw new Error(storageError); }
    }
    const observer = { observe() {
      if (!initialized || destroyed || clearing || !hosts.length) return;
      const current = ++ticket;
      Zotero.Promise.delay(350).then(() => {
        if (current === ticket && !destroyed && !clearing) return flush();
      }).catch(() => {});
    } };
    function initialize() {
      active();
      if (initialization) return initialization;
      initialization = (async () => {
        await ready(); active();
        let backup;
        try { backup = JSON.parse(stored()[0]?.password || "null"); } catch (_) {}
        const fresh = backup?.version === 1 && Array.isArray(backup.cookies)
          && Date.now() - Date.parse(backup.savedAt) >= 0 && Date.now() - Date.parse(backup.savedAt) <= MAX_AGE;
        const existing = new Set(cookies().map(cookie => [cookie.host, cookie.path, cookie.name].join("\n")));
        let retained = 0;
        if (fresh && !clearing) for (const cookie of backup.cookies.slice(0, MAX_COOKIES)) {
          if (!own(cookie) || cookie.isSession !== true || typeof cookie.name !== "string" || typeof cookie.value !== "string"
              || typeof cookie.path !== "string" || !cookie.path.startsWith("/") || !unexpired(cookie)) continue;
          retained++;
          const key = [cookie.host, cookie.path, cookie.name].join("\n");
          if (existing.has(key)) continue;
          Services.cookies.add(cookie.host, cookie.path, cookie.name, cookie.value, !!cookie.isSecure, !!cookie.isHttpOnly,
            true, restorableExpiry(cookie), { userContextId: 0, privateBrowsingId: 0 }, Number.isInteger(cookie.sameSite) ? cookie.sameSite : 0,
            Number.isInteger(cookie.schemeMap) ? cookie.schemeMap : 2, false);
          existing.add(key);
        }
        savedAt = retained ? backup.savedAt : null; hasBackup = retained > 0;
        if (backup && !retained) await write(null);
        initialized = true; storageError = null;
        Services.obs.addObserver(observer, "cookie-changed"); observerAdded = true;
        return getStatus();
      })().catch(() => {
        initialization = null; storageError = "机构登录会话无法恢复，请解锁 Zotero 凭据存储后重试。"; throw new Error(storageError);
      });
      return initialization;
    }
    function getStatus() { return { enabled: hosts.length > 0, initialized, hosts: [...hosts], savedAt, hasBackup, error: storageError }; }
    async function grantHosts(values) {
      active(); await initialize();
      const clean = [...new Set((Array.isArray(values) ? values : []).map(normalizeHost).filter(Boolean))];
      if (!clean.length) throw new Error("请先在窗口中打开出版社或机构登录网页。");
      hosts = [...new Set([...hosts, ...clean])].slice(-MAX_HOSTS);
      Services.prefs.setStringPref(HOSTS_PREF, JSON.stringify(hosts));
      return flush();
    }
    async function clear() {
      active(); clearing = true; generation++; ticket++;
      try {
        if (initialization) await initialization.catch(() => {});
        await writes.catch(() => {}); await write(null);
        hosts = []; Services.prefs.setStringPref(HOSTS_PREF, "[]"); savedAt = null; hasBackup = false; storageError = null;
        return getStatus();
      } finally { clearing = false; }
    }
    async function destroy() {
      if (destroyed) return;
      ticket++;
      if (observerAdded) Services.obs.removeObserver(observer, "cookie-changed"); observerAdded = false;
      try { await flush(); } finally { destroyed = true; }
    }
    return { initialize, grantHosts, flush, getStatus, clear, destroy };
  }
  scope.FulltextPublisherSession = Object.freeze({ create, normalizeHost, matchesHost });
})(globalThis);
