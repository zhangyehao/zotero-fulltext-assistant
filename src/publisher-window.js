/* A publisher/SSO window using Zotero's default cookie context. No secrets are read. */
(function (scope) {
  "use strict";
  const GROUP = "fulltext-publisher-browser";
  const WINDOW_URL = "chrome://fulltext-assistant/content/ui/publisher-browser.xhtml";
  function onChromeDocumentEvent(win, type, handler, once = false) {
    const listener = event => {
      // Embedded browsers may forward their document events to the chrome
      // window. Also ignore the openDialog window's initial about:blank.
      if (event.target !== win.document || event.target.documentURI !== WINDOW_URL) return;
      if (once) win.removeEventListener(type, listener);
      handler(event);
    };
    win.addEventListener(type, listener);
    return () => win.removeEventListener(type, listener);
  }
  function httpURL(value, allowBlank = false) {
    const url = new URL(String(value));
    if (allowBlank && url.href === "about:blank") return url.href;
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("出版社窗口仅支持普通 HTTP(S) 网页地址。");
    return url.href;
  }
  function create({ Zotero, Services, rootURI, publisherSession }) {
    if (!Zotero || !Services || !rootURI) throw new Error("出版社窗口缺少 Zotero 运行环境。");
    const windows = new Set();
    let destroyed = false;
    return {
      open({ url, taskId = null, app = null }) {
        if (destroyed) throw new Error("出版社窗口管理器已停止。");
        const checked = httpURL(url);
        for (const entry of windows) {
          if (entry.win.closed) { windows.delete(entry); continue; }
          if ((taskId && entry.taskId === taskId) || (!taskId && entry.url === checked)) { entry.win.focus(); return entry.win; }
        }
        const args = { url: checked, taskId, app, publisherSession }; args.wrappedJSObject = args;
        const win = Zotero.getMainWindow().openDialog(WINDOW_URL, "", "chrome,centerscreen,resizable,dialog=no,width=1160,height=850", args);
        const entry = { win, url: checked, taskId }; windows.add(entry);
        onChromeDocumentEvent(win, "unload", () => windows.delete(entry), true);
        return win;
      },
      destroy() { destroyed = true; for (const {win} of windows) if (!win.closed) win.close(); windows.clear(); },
    };
  }

  // Implement both nsIBrowserDOMWindow families: non-remote callers expect a
  // BrowsingContext, remote frame callers expect a <browser>. Returning a new
  // visible in-window tab preserves window.open's opener and SSO POST semantics.
  function createBrowserAccess({ win, Services, Components, ChromeUtils, createBrowser, nativeAccess }) {
    const Ci = Components.interfaces;
    const constants = Ci.nsIBrowserDOMWindow;
    function referrer(info, flags) {
      const ReferrerInfo = Components.Constructor("@mozilla.org/referrer-info;1", "nsIReferrerInfo", "init");
      if (flags & constants.OPEN_NO_REFERRER) return new ReferrerInfo(Ci.nsIReferrerInfo.EMPTY, false, null);
      try {
        const parent = info?.parent?.window;
        if (parent) return new ReferrerInfo(parent.document.referrerInfo.referrerPolicy, true, Services.io.newURI(parent.location.href));
      } catch (_) { /* Remote callers pass their explicit referrerInfo below. */ }
      return new ReferrerInfo(Ci.nsIReferrerInfo.EMPTY, true, null);
    }
    function open(uri, options) {
      if (uri) httpURL(uri.spec, true);
      const browser = createBrowser({ openWindowInfo: options.openWindowInfo, remoteType: options.remoteType, openerBrowser: options.openerBrowser });
      if (!browser?.browsingContext) throw new Error("出版社登录弹窗尚未就绪，请重试链接。");
      if (!options.skipLoad && uri) browser.loadURI(uri, {
        triggeringPrincipal: options.triggeringPrincipal || Services.scriptSecurityManager.getSystemPrincipal(),
        referrerInfo: options.referrerInfo, csp: options.csp,
      });
      return browser;
    }
    function nonRemote(method, uri, info, where, flags, principal, csp, skipLoad) {
      if (where === constants.OPEN_PRINT_BROWSER && nativeAccess?.[method]) return nativeAccess[method](uri, info, where, flags, principal, csp);
      return open(uri, {openWindowInfo: info, triggeringPrincipal: principal, csp, skipLoad, referrerInfo: referrer(info, flags), openerBrowser: info?.openerBrowser}).browsingContext;
    }
    function remote(method, uri, params, where, flags, name, skipLoad) {
      if (where === constants.OPEN_PRINT_BROWSER && nativeAccess?.[method]) return nativeAccess[method](uri, params, where, flags, name);
      return open(uri, {openWindowInfo: params?.openWindowInfo, triggeringPrincipal: params?.triggeringPrincipal, csp: params?.csp, skipLoad,
        referrerInfo: flags & constants.OPEN_NO_REFERRER ? referrer(null, flags) : params?.referrerInfo,
        remoteType: params?.remoteType, openerBrowser: params?.openerBrowser});
    }
    return {
      QueryInterface: ChromeUtils.generateQI(["nsIBrowserDOMWindow"]),
      createContentWindow(uri, info, where, flags, principal, csp) { return nonRemote("createContentWindow", uri, info, where, flags, principal, csp, true); },
      openURI(uri, info, where, flags, principal, csp) { if (!uri) throw new Error("缺少目标网页地址。"); return nonRemote("openURI", uri, info, where, flags, principal, csp, false); },
      createContentWindowInFrame(uri, params, where, flags, name) { return remote("createContentWindowInFrame", uri, params, where, flags, name, true); },
      openURIInFrame(uri, params, where, flags, name) { if (!uri) throw new Error("缺少目标网页地址。"); return remote("openURIInFrame", uri, params, where, flags, name, false); },
      canClose() { return true; },
      get tabCount() { return win.document.querySelectorAll("browser[data-publisher-tab]").length; },
    };
  }
  scope.FulltextPublisherWindow = Object.freeze({ create, createBrowserAccess, httpURL, onChromeDocumentEvent, GROUP, WINDOW_URL });
})(globalThis);
