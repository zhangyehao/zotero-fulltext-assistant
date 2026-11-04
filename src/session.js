/* A dedicated persistent Gecko container for AbleSci; secrets use Login Manager. */
(function (global) {
  "use strict";

  const ACTOR_NAME = "FulltextConnectionInspection";
  const MESSAGE_GROUP = "fulltext-connection-validation";
  const ALLOWED_ORIGIN = "https://www.ablesci.com";
  const CONTEXT_PREF = "extensions.fulltext-assistant.ablesciContextId";
  const CONTEXT_NAME = "Zotero Fulltext Assistant · AbleSci";
  let registered = false;
  let sessions = 0;

  function allowedURL(value) {
    const url = new URL(String(value));
    if (url.origin !== ALLOWED_ORIGIN || url.username || url.password) {
      throw new Error("账号会话只允许访问 https://www.ablesci.com 内的页面。");
    }
    return url.href;
  }

  function register() {
    if (registered) return;
    ChromeUtils.registerWindowActor(ACTOR_NAME, {
      // JSWindowActor system modules require a trusted chrome/resource scheme.
      // bootstrap registers this chrome mapping before creating the session.
      child: { esModuleURI: "chrome://fulltext-assistant/content/actors/FulltextConnectionInspectionChild.mjs" },
      matches: [ALLOWED_ORIGIN + "/*"],
      messageManagerGroups: [MESSAGE_GROUP],
      allFrames: false,
      includeChrome: false,
    });
    registered = true;
  }

  function create({ Zotero, Services, rootURI, credentials, contextualIdentityService }) {
    if (!Zotero || !Services || !rootURI) throw new Error("缺少 Zotero、Services 或 rootURI。");
    credentials ||= global.FulltextCredentials?.create({ Services });
    if (!credentials) throw new Error("请先加载全文助手安全凭据模块。");
    const identities = contextualIdentityService || ChromeUtils.importESModule(
      "resource://gre/modules/ContextualIdentityService.sys.mjs"
    ).ContextualIdentityService;
    function newContext() {
      const value = identities.create(CONTEXT_NAME, "fingerprint", "blue");
      if (!value || !Number.isSafeInteger(value.userContextId) || value.userContextId <= 0 || value.userContextId > 2147483647) {
        throw new Error("Zotero 未返回有效的独立登录上下文编号。");
      }
      Services.prefs.setIntPref(CONTEXT_PREF, value.userContextId);
      return value.userContextId;
    }
    const savedID = Services.prefs.getIntPref(CONTEXT_PREF, 0);
    const savedIdentity = savedID > 0 ? identities.getPublicIdentityFromId(savedID) : null;
    let contextID = savedIdentity?.name === CONTEXT_NAME ? savedID : newContext();
    register();
    sessions++;
    let destroyed = false;
    let initialized = false;
    let initialization;
    let clearing = false;
    let generation = 0;
    let queuedSave = 0;
    let writes = Promise.resolve();
    let observerAdded = false;
    let storageError = null;
    let lastSavedAt = null;
    const activeRequests = new Set();
    const ownCookies = () => [...Services.cookies.getCookiesFromHost("www.ablesci.com", { userContextId: contextID })]
      .filter(cookie => cookie.originAttributes.userContextId === contextID && /(^|\.)ablesci\.com$/i.test(cookie.host.replace(/^\./, "")));

    function cookieRecord(cookie) {
      return {
        host: cookie.host, path: cookie.path, name: cookie.name, value: cookie.value,
        isSecure: cookie.isSecure, isHttpOnly: cookie.isHttpOnly, isSession: cookie.isSession,
        expiry: cookie.expiry, sameSite: cookie.sameSite, schemeMap: cookie.schemeMap,
        originAttributes: { firstPartyDomain: cookie.originAttributes.firstPartyDomain || "", partitionKey: cookie.originAttributes.partitionKey || "" },
      };
    }
    async function flush() {
      ensureActive();
      if (!initialized || clearing) return;
      const expectedGeneration = generation;
      const value = { version: 1, savedAt: new Date().toISOString(), cookies: ownCookies().filter(cookie => cookie.isSession).map(cookieRecord) };
      const operation = writes.catch(() => {}).then(async () => {
        if (expectedGeneration !== generation || clearing) return;
        if (value.cookies.length) await credentials.writeSession(value);
        else await credentials.clearSession();
        lastSavedAt = value.cookies.length ? value.savedAt : null;
        storageError = null;
      });
      writes = operation;
      try { await operation; }
      catch (_) { storageError = "登录会话的安全备份未能保存，请解锁 Zotero 凭据存储后重试。"; throw new Error(storageError); }
    }
    const cookieObserver = {
      observe() {
        if (!initialized || destroyed || clearing) return;
        const ticket = ++queuedSave;
        Zotero.Promise.delay(300).then(() => {
          if (ticket === queuedSave && !destroyed && !clearing) return flush();
        }).catch(() => { /* The settings status exposes a sanitized storage error. */ });
      },
    };
    function initialize() {
      ensureActive();
      if (initialization) return initialization;
      initialization = (async () => {
        const backup = await credentials.readSession();
        ensureActive();
        const existing = new Set(ownCookies().map(cookie => [cookie.host, cookie.path, cookie.name, cookie.originAttributes.partitionKey || ""].join("\n")));
        for (const cookie of (backup?.cookies || []).slice(0, 200)) {
          if (!cookie || cookie.isSession !== true || typeof cookie.host !== "string"
              || !/(^|\.)ablesci\.com$/i.test(cookie.host.replace(/^\./, ""))
              || typeof cookie.name !== "string" || typeof cookie.value !== "string"
              || typeof cookie.path !== "string" || !cookie.path.startsWith("/")) continue;
          const partitionKey = cookie.originAttributes?.partitionKey || "";
          if (existing.has([cookie.host, cookie.path, cookie.name, partitionKey].join("\n"))) continue;
          const attrs = { userContextId: contextID, privateBrowsingId: 0, firstPartyDomain: cookie.originAttributes?.firstPartyDomain || "", partitionKey };
          Services.cookies.add(cookie.host, cookie.path, cookie.name, cookie.value, !!cookie.isSecure,
            !!cookie.isHttpOnly, true, Number.isFinite(cookie.expiry) ? cookie.expiry : 0, attrs,
            Number.isInteger(cookie.sameSite) ? cookie.sameSite : 0,
            Number.isInteger(cookie.schemeMap) ? cookie.schemeMap : 2, !!partitionKey);
        }
        lastSavedAt = backup?.savedAt || null;
        initialized = true;
        Services.obs.addObserver(cookieObserver, "cookie-changed");
        observerAdded = true;
        return getStatus();
      })().catch(() => {
        initialization = null;
        storageError = "登录会话无法恢复，请解锁 Zotero 凭据存储后重试。";
        throw new Error(storageError);
      });
      return initialization;
    }
    function getStatus() {
      return { persistent: true, initialized, storage: "zotero-login-manager", hasCookies: initialized && ownCookies().length > 0, lastSavedAt, error: storageError };
    }

    function ensureActive() {
      if (destroyed) throw new Error("插件会话已关闭，请重新打开插件。");
    }

    function configureBrowser(browser) {
      ensureActive();
      if (!initialized) throw new Error("请等待已保存的登录会话恢复完成。");
      if (browser.isConnected) {
        throw new Error("请在 browser 插入窗口之前配置其登录上下文。");
      }
      browser.setAttribute("type", "content");
      // Match Zotero's visible basicViewer: a freshly appended remote=true browser
      // may not have a remoteTab yet when loadURI is called synchronously.
      browser.setAttribute("remote", "false");
      browser.setAttribute("maychangeremoteness", "true");
      browser.setAttribute("disableglobalhistory", "true");
      browser.setAttribute("messagemanagergroup", MESSAGE_GROUP);
      browser.setAttribute("usercontextid", String(contextID));
      return browser;
    }

    function ensureOwnBrowser(browser) {
      ensureActive();
      if (clearing || browser.getAttribute("usercontextid") !== String(contextID)
          || browser.getAttribute("messagemanagergroup") !== MESSAGE_GROUP) {
        throw new Error("当前网页不属于此插件登录会话，请重新打开登录窗口。");
      }
    }

    // Starts a visible navigation. The user initiates inspection after the page loads.
    function load(browser, url) {
      ensureOwnBrowser(browser);
      const href = allowedURL(url);
      browser.loadURI(Services.io.newURI(href), {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      return href;
    }

    async function inspect(browser) {
      ensureOwnBrowser(browser);
      const url = allowedURL(browser.currentURI && browser.currentURI.spec);
      const windowGlobal = browser.browsingContext && browser.browsingContext.currentWindowGlobal;
      if (!windowGlobal) throw new Error("网页尚未就绪，请等待加载后再读取。");
      const actor = windowGlobal.getActor(ACTOR_NAME);
      const query = actor.sendQuery("Fulltext:ReadOnlySnapshot");
      const timeout = Zotero.Promise.delay(10000).then(() => {
        throw new Error("读取页面超时；没有执行提交或下载，请等页面加载后重试。");
      });
      const result = await Promise.race([query, timeout]);
      // Clearing/unloading the session while a read is pending must not revive old login evidence.
      ensureOwnBrowser(browser);
      const resultURL = allowedURL(result.url);
      if (resultURL !== url || browser.currentURI.spec !== resultURL) {
        throw new Error("页面在读取时发生跳转，请在跳转结束后重新读取。");
      }
      if (result.error) throw new Error(result.error);
      return {
        ...result,
        sessionScope: "persistent-zotero-profile",
        inspectedAt: new Date().toISOString(),
        readOnly: true,
      };
    }

    async function clearSession() {
      ensureActive();
      await initialize();
      clearing = true;
      generation++;
      queuedSave++;
      for (const cancel of activeRequests) { try { cancel(); } catch (_) {} }
      try {
        await writes.catch(() => {});
        await credentials.clearSession();
        await new Promise((resolve, reject) => Services.clearData.deleteDataFromOriginAttributesPattern(
          { userContextId: contextID },
          { onDataDeleted(flags) { if (flags) reject(new Error("部分登录数据未能清除，请重新启动 Zotero 后重试。")); else resolve(); } }
        ));
        identities.remove(contextID);
        contextID = newContext();
        lastSavedAt = null;
        storageError = null;
        return contextID;
      }
      finally { clearing = false; }
    }

    async function request(method, url, options = {}) {
      ensureActive();
      await initialize();
      if (clearing) throw new Error("正在退出登录，请稍后再试。");
      const expectedGeneration = generation;
      const href = allowedURL(url);
      method = String(method).toUpperCase();
      if (!["GET", "HEAD", "POST"].includes(method)) throw new Error("不支持此请求方法。");
      if (options.username || options.password || options.cookieSandbox || options.anon) throw new Error("请求必须使用插件的独立登录会话。");
      let cancelRequest;
      let response;
      try {
        response = await Zotero.HTTP.request(method, href, {
          ...options, userContextId: contextID, debug: false, logBodyLength: 0,
          errorDelayMax: 0, noRetryOnThrottle: true,
          cancellerReceiver(cancel) {
            cancelRequest = cancel;
            activeRequests.add(cancel);
            if (typeof options.cancellerReceiver === "function") options.cancellerReceiver(cancel);
          },
        });
      }
      finally { if (cancelRequest) activeRequests.delete(cancelRequest); }
      ensureActive();
      if (expectedGeneration !== generation) throw new Error("登录会话已切换，此请求结果已丢弃。");
      // A backup failure must not turn an accepted POST into an apparent failed
      // submission that a caller could accidentally repeat. getStatus exposes it.
      await flush().catch(() => {});
      // Logout may start while the encrypted backup is awaiting its write queue.
      // Do not return old account data after the container generation changed.
      ensureActive();
      if (expectedGeneration !== generation) throw new Error("登录会话已切换，此请求结果已丢弃。");
      return response;
    }

    async function fillSavedLogin(browser) {
      ensureOwnBrowser(browser);
      const current = new URL(allowedURL(browser.currentURI?.spec));
      if (current.pathname !== "/site/login") throw new Error("请先打开科研通的账号登录页。");
      const secret = await credentials.getForLogin();
      if (!secret) throw new Error("尚未保存科研通账号密码。");
      ensureOwnBrowser(browser);
      const actor = browser.browsingContext?.currentWindowGlobal?.getActor(ACTOR_NAME);
      if (!actor) throw new Error("登录页尚未就绪。");
      try { return await actor.sendQuery("Fulltext:FillSavedLogin", secret); }
      finally { secret.password = ""; }
    }

    async function destroy() {
      if (destroyed) return;
      queuedSave++;
      for (const cancel of activeRequests) { try { cancel(); } catch (_) {} }
      if (observerAdded) Services.obs.removeObserver(cookieObserver, "cookie-changed");
      observerAdded = false;
      try { await flush(); }
      finally {
        destroyed = true;
        sessions--;
        if (sessions === 0 && registered) {
          ChromeUtils.unregisterWindowActor(ACTOR_NAME);
          registered = false;
        }
      }
    }

    return {
      get userContextId() { return contextID; },
      initialize,
      getStatus,
      flush,
      request,
      fillSavedLogin,
      configureBrowser,
      load,
      inspect,
      clearSession,
      destroy,
    };
  }

  global.FulltextSession = { create };
})(globalThis);
