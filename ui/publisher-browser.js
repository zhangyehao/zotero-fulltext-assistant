"use strict";
FulltextPublisherWindow.onChromeDocumentEvent(window, "load", async () => {
  const {url, taskId, app, publisherSession} = window.arguments[0].wrappedJSObject;
  const status = document.getElementById("publisher-status");
  const address = document.getElementById("publisher-address");
  const pages = document.getElementById("publisher-pages");
  const tabBar = document.getElementById("publisher-tabs");
  const retry = document.getElementById("publisher-retry");
  const remember = document.getElementById("publisher-remember");
  const rememberedHosts = document.getElementById("publisher-remembered-hosts");
  const visitedHosts = new Set();
  const entries = [];
  let selected, closing = false;
  window.FulltextPublisherOriginalURL = url;
  window.FulltextPublisherTaskID = taskId;
  function errorText(error) { return String(error?.message || error).replace(/https?:\/\/\S+/g, "[网页地址]").slice(0, 350); }
  function observeLocation(browser) {
    try {
      const location = new URL(browser.currentURI?.spec);
      if (["https:", "http:"].includes(location.protocol)) visitedHosts.add(location.hostname);
      rememberedHosts.textContent = [...visitedHosts].join("、");
    } catch (_) {}
  }
  function showCompatibility(browser) {
    let text = browser.contentTitle || "";
    try { text += " " + (browser.contentDocument?.body?.innerText || "").slice(0, 4000); } catch (_) {}
    if (/just a moment|verify (?:that )?you are human|verifying you are human|performing security verification|checking your browser|验证您是真人/i.test(text)) {
      status.textContent = "网站正在进行真人验证。若验证反复出现，可选择“专用 Edge 自动获取”，或用“默认浏览器手动下载”后导入本地 PDF。专用 Edge 与日常浏览器登录独立；插件不会自动操作验证码，验证能否通过由网站决定。";
    }
  }
  function updateAddress() {
    if (!selected || closing) return;
    const browser = selected.browser;
    address.value = browser.currentURI?.spec || "about:blank";
    document.getElementById("publisher-back").disabled = !browser.canGoBack;
    document.getElementById("publisher-forward").disabled = !browser.canGoForward;
    const title = browser.contentTitle || (() => {try {return new URL(address.value).hostname;} catch (_) {return "机构登录";}})();
    selected.title.textContent = title || "机构登录";
    window.document.title = (title || "出版社与机构登录") + " · 全文助手";
    showCompatibility(browser);
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
      onLocationChange(progress) {if (progress.isTopLevel) {observeLocation(browser);if (selected === entry) updateAddress();}},
      onStateChange(progress, request, flags) {if (progress.isTopLevel && flags & Components.interfaces.nsIWebProgressListener.STATE_STOP) {observeLocation(browser);if (selected === entry) showCompatibility(browser);}}, onProgressChange() {}, onStatusChange() {}, onSecurityChange() {},
    };
    browser.addProgressListener(entry.listener, Components.interfaces.nsIWebProgress.NOTIFY_LOCATION | Components.interfaces.nsIWebProgress.NOTIFY_STATE_WINDOW);
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
  remember.disabled = !publisherSession;
  const externalButton = document.getElementById("publisher-external");
  externalButton.disabled = !taskId || typeof app?.openExternalTask !== "function";
  externalButton.addEventListener("click", async () => {
    if (externalButton.disabled) return;
    externalButton.disabled = true;
    try {
      await app.openExternalTask(taskId);
      status.textContent = "已启动全文助手专用 Edge 窗口。请在该窗口登录或完成网站验证；插件会自动等待可下载的 PDF 并保存到原文献。可在任务列表暂停或继续获取。";
    } catch (error) {status.textContent = errorText(error);}
    finally {if (!closing) externalButton.disabled = !taskId || typeof app?.openExternalTask !== "function";}
  });
  const systemButton = document.getElementById("publisher-system");
  systemButton.disabled = Boolean(taskId) && typeof app?.openSystemBrowserTask !== "function";
  systemButton.addEventListener("click", async () => {
    if (systemButton.disabled) return;
    systemButton.disabled = true;
    try {
      if (taskId) {
        const result = await app.openSystemBrowserTask(taskId);
        if (result?.alreadyImported) {
          status.textContent = "PDF 已保存到原文献，无需再次下载。请在全文助手的“已获取”中打开全文。";
          return;
        }
      } else await Zotero.launchURL(FulltextPublisherWindow.httpURL(url));
      status.textContent = taskId
        ? "已在默认浏览器打开论文。请自行下载 PDF，再点击本窗口的“导入本地 PDF”或任务中的“选择已下载的PDF”保存到原文献；插件不会监测默认浏览器的下载。"
        : "已在默认浏览器打开论文。请自行下载 PDF；此页面未关联文献，请回到对应 Zotero 条目添加附件。插件不会监测默认浏览器的下载。";
    } catch (error) {status.textContent = errorText(error);}
    finally {if (!closing) systemButton.disabled = Boolean(taskId) && typeof app?.openSystemBrowserTask !== "function";}
  });
  const importButton = document.getElementById("publisher-import");
  importButton.disabled = !taskId || !app?.importLocalPDF;
  importButton.addEventListener("click", async () => {
    importButton.disabled = true;
    try {const result = await app.importLocalPDF(taskId);if (result && !result.cancelled) status.textContent = "PDF 已导入原文献，请在全文助手任务列表查看结果。";}
    catch (error) {status.textContent = errorText(error);}
    finally {if (!closing) importButton.disabled = false;}
  });
  retry.disabled = !taskId || !app?.retryTask;
  retry.addEventListener("click", async () => {
    retry.disabled = true;
    try {
      let storageWarning = "";
      if (remember.checked && publisherSession) {
        try {await publisherSession.grantHosts([...visitedHosts]);}
        catch (error) {storageWarning = " " + errorText(error);}
      }
      await app.retryTask(taskId);status.textContent = "已重新开始获取此文献，请在全文助手任务列表查看结果。" + storageWarning;
    }
    catch (error) {status.textContent = errorText(error);}
    finally {if (!closing) retry.disabled = false;}
  });
}, true);
