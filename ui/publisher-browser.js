"use strict";
FulltextPublisherWindow.onChromeDocumentEvent(window, "load", async () => {
  const {url, taskId, app} = window.arguments[0].wrappedJSObject;
  const status = document.getElementById("publisher-status");
  const address = document.getElementById("publisher-address");
  const pages = document.getElementById("publisher-pages");
  const tabBar = document.getElementById("publisher-tabs");
  const retry = document.getElementById("publisher-retry");
  const entries = [];
  let selected, closing = false;
  window.FulltextPublisherOriginalURL = url;
  window.FulltextPublisherTaskID = taskId;
  function errorText(error) { return String(error?.message || error).replace(/https?:\/\/\S+/g, "[网页地址]").slice(0, 350); }
  function updateAddress() {
    if (!selected || closing) return;
    const browser = selected.browser;
    address.value = browser.currentURI?.spec || "about:blank";
    document.getElementById("publisher-back").disabled = !browser.canGoBack;
    document.getElementById("publisher-forward").disabled = !browser.canGoForward;
    const title = browser.contentTitle || (() => {try {return new URL(address.value).hostname;} catch (_) {return "机构登录";}})();
    selected.title.textContent = title || "机构登录";
    window.document.title = (title || "出版社与机构登录") + " · 全文助手";
  }
  function select(entry) {
    selected = entry;
    for (const other of entries) {other.browser.hidden = other !== entry;other.tab.classList.toggle("selected", other === entry);other.title.setAttribute("aria-selected", String(other === entry));}
    window.gBrowser = entry.browser;
    updateAddress();
  }
  function close(entry) {
    if (entries.length === 1) {window.close();return;}
    const index = entries.indexOf(entry);entries.splice(index, 1);
    try {entry.browser.removeProgressListener(entry.listener);} catch (_) {}
    entry.browser.remove();entry.tab.remove();
    if (selected === entry) select(entries[Math.max(0, index - 1)]);
  }
  function register(browser) {
    const tab = document.createElementNS("http://www.w3.org/1999/xhtml", "div");tab.className = "publisher-tab";
    const title = document.createElementNS("http://www.w3.org/1999/xhtml", "button");title.type = "button";title.className = "publisher-tab-title";title.textContent = "正在打开…";title.setAttribute("role", "tab");
    const remove = document.createElementNS("http://www.w3.org/1999/xhtml", "button");remove.type = "button";remove.textContent = "×";remove.setAttribute("aria-label", "关闭此网页");
    tab.append(title, remove);tabBar.appendChild(tab);
    const entry = {browser, tab, title};entries.push(entry);
    title.addEventListener("click", () => select(entry));remove.addEventListener("click", () => close(entry));
    browser.addEventListener("pagetitlechanged", () => {entry.title.textContent = browser.contentTitle || "机构登录";if (selected === entry) updateAddress();});
    browser.addEventListener("DOMWindowClose", event => {event.preventDefault();close(entry);});
    entry.listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
      onLocationChange(progress) {if (progress.isTopLevel && selected === entry) updateAddress();},
      onStateChange() {}, onProgressChange() {}, onStatusChange() {}, onSecurityChange() {},
    };
    browser.addProgressListener(entry.listener, Components.interfaces.nsIWebProgress.NOTIFY_LOCATION);
    select(entry);return browser;
  }
  function createBrowser({openWindowInfo, remoteType} = {}) {
    const browser = document.createXULElement("browser");
    for (const [key, value] of Object.entries({type: "content", flex: "1", remote: "false", maychangeremoteness: "true", disableglobalhistory: "true", usercontextid: "0", messagemanagergroup: FulltextPublisherWindow.GROUP, "data-publisher-tab": "true"})) browser.setAttribute(key, value);
    // Gecko receives the originating opener/principal through this object. Set it
    // before insertion; recreating or manually constructing a browser here loses SSO state.
    if (openWindowInfo) browser.openWindowInfo = openWindowInfo;
    if (remoteType) {browser.setAttribute("remote", "true");browser.setAttribute("remoteType", remoteType);}
    pages.appendChild(browser);
    return register(browser);
  }
  async function ready(browser) {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      if (closing) throw new Error("网页窗口已关闭。");
      try {if (browser.frameLoader && browser.browsingContext && browser.webNavigation && browser.contentDocument?.readyState === "complete") {await new Promise(resolve => window.setTimeout(resolve, 0));return;}} catch (_) {}
      await new Promise(resolve => window.setTimeout(resolve, 30));
    }
    throw new Error("出版社浏览器初始化超时，请关闭后重试。");
  }
  function navigate(browser, target) {
    const checked = FulltextPublisherWindow.httpURL(target);
    browser.loadURI(Services.io.newURI(checked), {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()});
  }
  FulltextPublisherWindow.onChromeDocumentEvent(window, "unload", () => {closing = true;for (const entry of entries) try {entry.browser.removeProgressListener(entry.listener);} catch (_) {}}, true);
  try {
    const initial = document.getElementById("publisher-main-browser");await ready(initial);register(initial);
    window.browserDOMWindow = FulltextPublisherWindow.createBrowserAccess({win: window, Services, Components, ChromeUtils, createBrowser, nativeAccess: window.browserDOMWindow});
    // Kept as an inspection seam for isolated native tests; no credential data.
    window.FulltextPublisherBrowsers = () => entries.map(entry => entry.browser);
    navigate(initial, url);
  } catch (error) {status.textContent = errorText(error);return;}
  document.getElementById("publisher-back").addEventListener("click", () => {if (selected.browser.canGoBack) selected.browser.goBack();});
  document.getElementById("publisher-forward").addEventListener("click", () => {if (selected.browser.canGoForward) selected.browser.goForward();});
  document.getElementById("publisher-reload").addEventListener("click", () => selected.browser.reload());
  document.getElementById("publisher-home").addEventListener("click", () => navigate(selected.browser, url));
  retry.disabled = !taskId || !app?.retryTask;
  retry.addEventListener("click", async () => {
    retry.disabled = true;
    try {await app.retryTask(taskId);status.textContent = "已重新开始获取此文献，请在全文助手任务列表查看结果。";}
    catch (error) {status.textContent = errorText(error);}
    finally {if (!closing) retry.disabled = false;}
  });
}, true);
