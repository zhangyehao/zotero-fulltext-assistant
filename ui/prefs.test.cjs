"use strict";
const fs = require("node:fs");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = require("node:path");
const { parseHTML } = require("linkedom");
const source = fs.readFileSync(path.join(__dirname, "preferences.xhtml"), "utf8");
const script = fs.readFileSync(path.join(__dirname, "prefs.js"), "utf8");
const i18nContext = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/i18n-backend-data.js"), "utf8"), i18nContext);
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/i18n.js"), "utf8"), i18nContext);
const i18n = i18nContext.FulltextI18n;
new vm.Script(script);
const { document, window } = parseHTML("<html><body><div id='preference-container'></div></body></html>");
let renderListener;
let subscriptions = 0;
const calls = [];
let bindingCandidates = [];
let cancelLocalImport = false;
let reviewLocalImport = false;
let cancelDirectory = false;
const model = {
  version: "0.7.0", settings: { language: "zh-CN", points: 10, pollSeconds: 60, autoDownload: true, downloadDirectories: ["D:\\Downloads"], downloadDirectory: "D:\\Downloads" },
  session: { status: "signed_out", username: "", hasSavedPassword: false, message: "尚未登录" },
  tasks: [], messages: [], messagesStatus: { state: "idle" }
};
const app = {
  getSnapshot: () => { const value = structuredClone(model);if (model.currentBatch === undefined) value.currentBatch = { id: "ui-test-batch", createdAt: "2026-11-05T08:00:00Z", taskIDs: model.tasks.map(task => task.id), summary: model.captureSummary || null };return value; },
  translate: (text, params) => i18n.translate(text, model.settings.language, params),
  localize: root => i18n.apply(root, model.settings.language),
  copyText: async value => { calls.push(["copy", value]); },
  subscribe: fn => { renderListener = fn; subscriptions++; return () => { subscriptions--; }; },
  saveCredentialsAndLogin: async account => {
    calls.push(["login", { ...account }]);
    model.session = { status: "pending_login", username: account.username, hasSavedPassword: true, message: "请在网页完成登录" };
    renderListener();
  },
  openLogin: async () => calls.push(["web"]),
  logout: async () => { calls.push(["logout"]); model.session.status = "signed_out"; renderListener(); },
  saveSettings: async settings => { calls.push(["save", { ...settings }]); model.settings = { ...model.settings, ...settings }; renderListener(); },
  chooseDownloadDirectory: async () => {
    calls.push(["chooseDirectory"]);
    if (cancelDirectory) return { cancelled: true };
    model.settings.downloadDirectories.push("D:\\Research"); renderListener();
    return { cancelled: false, directory: "D:\\Research" };
  },
  removeDownloadDirectory: async directory => {
    calls.push(["removeDirectory", directory]);
    model.settings.downloadDirectories = model.settings.downloadDirectories.filter(value => value !== directory);
    model.settings.downloadDirectory = model.settings.downloadDirectories[0] || ""; renderListener();
  },
  detectDownloadDirectories: async () => {
    calls.push(["detectDirectories"]);
    const added = model.settings.downloadDirectories.includes("D:\\BrowserDownloads") ? 0 : 1;
    if (added) model.settings.downloadDirectories.push("D:\\BrowserDownloads");
    renderListener(); return { added, directories: model.settings.downloadDirectories };
  },
  checkTask: async id => calls.push(["check", id]),
  retryAssistCompletion: async id => calls.push(["assistCompletion", id]),
  verifyAssistCompletion: async id => { calls.push(["verifyAssistCompletion", id]); return { completed: false, message: "原文件核验结果已更新。" }; },
  openRequest: async id => calls.push(["open", id]),
  pauseTask: async id => { calls.push(["pause", id]); model.tasks.find(task => task.id === id).state = "paused"; renderListener(); },
  retryTask: async (id, options) => { calls.push(["retry", id, options ? { ...options } : null]); const task = model.tasks.find(task => task.id === id); task.state = "waiting"; if (options?.points) task.requestedPoints = options.points; renderListener(); },
  requestAssist: async (ids, options) => {
    const requested = Array.from(ids);
    calls.push(["assist", requested, options ? { ...options } : null]);
    const acceptedIDs = [], skippedIDs = [];
    for (const id of requested) {
      const task = model.tasks.find(value => value.id === id);
      if (!task?.doi || task.requestID || task.requestURL || task.attachmentID || !["not_found", "needs_login", "pending_login", "paused", "error", "failed", "needs_review", "captcha", "manual_waiting", "manual_review", "browser_waiting", "browser_scanning", "browser_downloading"].includes(task.state)) { skippedIDs.push(id); continue; }
      task.state = "submitting";
      task.acquisitionMode = "";
      if (options?.points) task.requestedPoints = options.points;
      acceptedIDs.push(id);
    }
    renderListener();
    return { accepted: acceptedIDs.length, skipped: skippedIDs.length, acceptedIDs, skippedIDs };
  },
  downloadTask: async id => { calls.push(["download", id]); const task = model.tasks.find(value => value.id === id); task.state = "imported"; task.attachmentID = 100; renderListener(); },
  addExistingRequest: async (url, target) => calls.push(["add", url, target]),
  getBindingCandidates: async id => { calls.push(["bindingCandidates", id]); return structuredClone(bindingCandidates); },
  bindExistingTask: async (id, itemID) => {
    calls.push(["bind", id, itemID]);
    const task = model.tasks.find(value => value.id === id);
    task.itemID = itemID;
    if (model.settings.autoDownload) { task.state = "imported"; task.attachmentID = 501; task.completedAt = "2026-11-04T14:00:00Z"; task.source = "ablesci"; }
    renderListener();
  },
  openExternalTask: async () => { throw new Error("Removed dedicated Edge API must not be called"); },
  focusExternalTask: async () => { throw new Error("Removed dedicated Edge API must not be called"); },
  openSystemBrowserTask: async id => {
    calls.push(["systemBrowser", id]);
    const task = model.tasks.find(value => value.id === id);
    Object.assign(task, { state: "manual_waiting", acquisitionMode: "manual" });
    renderListener();
    return { opened: true, watching: true };
  },
  importLocalPDF: async id => {
    calls.push(["localPDF", id]);
    if (cancelLocalImport) return { cancelled: true };
    const task = model.tasks.find(value => value.id === id);
    if (reviewLocalImport) {
      Object.assign(task, { state: "manual_review", acquisitionMode: "manual", pendingFilename: "<img src=x onerror=bad>.pdf", pendingTitle: "<b>PDF title</b>", pendingSummary: "身份仍不确定，请核对。" });
      renderListener(); return { needsReview: true, identity: { status: "unknown" } };
    }
    Object.assign(task, { state: "imported", attachmentID: 600, completedAt: "2026-11-04T13:00:00Z", source: "local_file" });
    renderListener();
    return { cancelled: false, attachmentID: 600 };
  },
  previewDownloadedPDF: async id => calls.push(["previewPDF", id]),
  confirmDownloadedPDF: async id => {
    calls.push(["confirmPDF", id]);
    Object.assign(model.tasks.find(value => value.id === id), { state: "imported", attachmentID: 601, source: "local_file", pendingFilename: "" });
    renderListener(); return { cancelled: false, attachmentID: 601 };
  },
  dismissDownloadedPDF: async id => {
    calls.push(["dismissPDF", id]);
    Object.assign(model.tasks.find(value => value.id === id), { state: "paused", pendingFilename: "" }); renderListener();
  },
  refreshMessages: async () => { calls.push(["messages"]); model.messagesStatus = { state: "loaded", lastCheckedAt: "2026-11-04T13:00:00Z" }; renderListener(); },
  openMessage: async id => calls.push(["message", id])
};
window.Zotero = { FulltextAssistant: app };
const context = { window, document, Zotero: window.Zotero, console, Date, String, Number, Array, Object };
vm.runInNewContext(script, context);
assert.equal(subscriptions, 0, "scripts execute before pane markup without prematurely subscribing");
const markup = source.replace(/html:/g, "");
const parsed = parseHTML("<html><body>" + markup + "</body></html>");
const root = document.importNode(parsed.document.getElementById("fta-preferences"), true);
document.getElementById("preference-container").append(root);
// Zotero dispatches a non-bubbling load at the root after importing its fragment.
// LinkeDOM has no capture-phase traversal for that event, so invoke the exposed
// same mount callback used by the real window's capture listener.
context.FulltextPreferences.mount(root);
context.FulltextPreferences.mount(root);
assert.equal(subscriptions, 1, "mount is idempotent");
const get = id => document.getElementById(id);
const pageTab = page => get("fta-pref-tab-" + page);
const pagePanel = page => get("fta-pref-panel-" + page);
let focusedTab = "";
for (const tab of get("fta-pref-tabs").querySelectorAll('[role="tab"]')) tab.focus = () => { focusedTab = tab.id; };
const tabKey = (page, key, modifiers = {}) => {
  const event = new window.Event("keydown", { bubbles: true, cancelable: true });
  Object.assign(event, { key, ...modifiers }); pageTab(page).dispatchEvent(event); return event;
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const submit = id => get(id).dispatchEvent(new window.Event("submit", { cancelable: true }));
const input = (id, value) => { get(id).value = value; get(id).dispatchEvent(new window.Event("input")); };
const rowButton = label => [...get("fta-pref-task-list").querySelectorAll("button")].find(b => b.textContent === label);
const assistButton = () => [...get("fta-pref-task-list").querySelectorAll("button")].find(b => b.textContent.startsWith("科研通求助"));
const filterButton = filter => get("fta-pref-task-filters").querySelector('[data-filter="' + filter + '"]');
const taskCheckbox = id => get("fta-pref-task-list").querySelector('[data-task-id="' + id + '"] input[type="checkbox"]');
const taskRow = id => get("fta-pref-task-list").querySelector('[data-task-id="' + id + '"]');
const changeChecked = (node, checked) => { node.checked = checked; node.dispatchEvent(new window.Event("change")); };
const chooseTarget = id => {
  const select = get("fta-pref-request-target");
  for (const option of select.querySelectorAll("option")) option.removeAttribute("selected");
  select.querySelector('option[value="' + id + '"]').setAttribute("selected", "selected");
  select.dispatchEvent(new window.Event("change"));
};
const chooseBindingTarget = itemID => {
  const select = get("fta-pref-binding-target");
  for (const option of select.querySelectorAll("option")) option.removeAttribute("selected");
  select.querySelector('option[value="' + itemID + '"]').setAttribute("selected", "selected");
  select.dispatchEvent(new window.Event("change"));
};
async function publisherControls(taskId = "publisher-task", overrides = {}) {
  const markup = fs.readFileSync(path.join(__dirname, "publisher-browser.xhtml"), "utf8").replace(/html:/g, "").replace(/<script([^>]*?)\s*\/>/g, "<script$1></script>");
  const { document, window } = parseHTML("<html><body>" + markup + "</body></html>");
  const calls = [], handlers = {};
  let language = "zh-CN";const languageListeners = new Set();
  const app = {
    localize: root => i18n.apply(root, language),
    translate: text => i18n.translate(text, language),
    subscribe: listener => { languageListeners.add(listener);return () => languageListeners.delete(listener); },
    async openExternalTask() { throw new Error("Removed dedicated Edge API must not be called"); },
    async openSystemBrowserTask(id) { calls.push(["systemBrowser", id]); return { opened: true, watching: true }; },
    async importLocalPDF(id) { calls.push(["localPDF", id]); return { cancelled: false }; },
    async retryTask(id) { calls.push(["retry", id]); },
    ...overrides
  };
  const url = "https://publisher.example/article";
  window.arguments = [{ wrappedJSObject: { url, taskId, app } }];
  window.setTimeout = setTimeout;
  const browser = document.getElementById("publisher-main-browser");
  Object.assign(browser, {
    frameLoader: {}, browsingContext: {}, webNavigation: {}, currentURI: { spec: url }, contentTitle: "Verify you are human",
    contentDocument: { readyState: "complete", body: { innerText: "Verify you are human" } },
    addProgressListener() {}, removeProgressListener() {}, loadURI(uri) { this.currentURI = { spec: uri }; }
  });
  const scope = {
    window, document, URL, Date, Set, Promise,
    Zotero: { async launchURL(value) { calls.push(["launchURL", value]); } },
    FulltextPublisherWindow: {
      onChromeDocumentEvent(win, type, callback) { handlers[type] = callback; },
      httpURL: value => value, createBrowserAccess: () => ({})
    },
    Services: { io: { newURI: value => value }, scriptSecurityManager: { getSystemPrincipal: () => ({}) } },
    ChromeUtils: { generateQI: () => () => {} },
    Components: { interfaces: { nsIWebProgressListener: { STATE_STOP: 1 }, nsIWebProgress: { NOTIFY_LOCATION: 1, NOTIFY_STATE_WINDOW: 2 } } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "publisher-browser.js"), "utf8"), scope);
  await handlers.load();
  return { app, calls, get: id => document.getElementById(id), close: () => handlers.unload(), languageSubscriptions: () => languageListeners.size,
    setLanguage(value) { language = value;for (const listener of languageListeners) listener(); }, document, browser };
}
async function siteControls() {
  const markup = fs.readFileSync(path.join(__dirname, "browser.xhtml"), "utf8").replace(/html:/g, "").replace(/<script([^>]*?)\s*\/>/g, "<script$1></script>");
  const { document, window } = parseHTML("<html><body>" + markup + "</body></html>");
  const handlers = {}, listeners = new Set();let language = "zh-CN", detached = false;
  const app = { localize: root => i18n.apply(root, language), subscribe: listener => { listeners.add(listener);return () => listeners.delete(listener); },
    attachBrowser: async () => ({ currentURI: { spec: "https://www.ablesci.com/assist/detail?id=LocalOnly" } }), detachBrowser: () => { detached = true; }, inspectActivePage: async () => {} };
  const chromeWindow = { document, MutationObserver: window.MutationObserver,
    arguments: [{ wrappedJSObject: { app, url: "https://www.ablesci.com/assist/detail?id=LocalOnly", mode: "request" } }],
    addEventListener(type, callback) { handlers[type] = callback; }, setInterval: () => 1, clearInterval() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "browser.js"), "utf8"), { window: chromeWindow, document, Date });
  await handlers.load();await flush();
  return { get: id => document.getElementById(id), setLanguage(value) { language = value;for (const listener of listeners) listener(); }, close: () => handlers.unload(), detached: () => detached, languageSubscriptions: () => listeners.size };
}
(async () => {
  assert.equal(root.dataset.activePage, "tasks");
  assert.equal(get("fta-pref-tabs").getAttribute("role"), "tablist");
  assert.equal(get("fta-pref-tabs").getAttribute("aria-orientation"), "horizontal");
  const pages = ["tasks", "settings", "account", "messages"];
  for (const page of pages) {
    assert.equal(pageTab(page).getAttribute("aria-controls"), pagePanel(page).id);
    assert.equal(pagePanel(page).getAttribute("aria-labelledby"), pageTab(page).id);
    assert.equal(pagePanel(page).getAttribute("role"), "tabpanel");
    assert.equal(pagePanel(page).hidden, page !== "tasks");
    assert.equal(pageTab(page).getAttribute("aria-selected"), String(page === "tasks"));
    assert.equal(pageTab(page).getAttribute("tabindex"), page === "tasks" ? "0" : "-1");
  }
  const beforeNavigation = calls.length;
  pageTab("settings").click();
  assert.equal(root.dataset.activePage, "settings");
  assert.equal(pagePanel("tasks").hidden, true);
  assert.equal(pagePanel("settings").hidden, false);
  assert.equal(tabKey("settings", "ArrowRight").defaultPrevented, true);
  assert.equal(root.dataset.activePage, "account");
  assert.equal(focusedTab, "fta-pref-tab-account");
  tabKey("account", "End"); assert.equal(root.dataset.activePage, "messages");
  tabKey("messages", "ArrowRight"); assert.equal(root.dataset.activePage, "tasks", "right arrow wraps to first tab");
  tabKey("tasks", "ArrowLeft"); assert.equal(root.dataset.activePage, "messages", "left arrow wraps to last tab");
  tabKey("messages", "Home"); assert.equal(root.dataset.activePage, "tasks");
  assert.equal(tabKey("tasks", "ArrowDown").defaultPrevented, false, "vertical arrows keep normal scrolling behavior");
  tabKey("tasks", "ArrowRight", { ctrlKey: true });
  assert.equal(root.dataset.activePage, "tasks", "modified shortcuts are not intercepted");
  assert.equal(calls.length, beforeNavigation, "tab navigation does not perform backend actions");
  assert.equal(get("fta-pref-batch-summary").hidden, true);
  pageTab("account").click();
  model.captureSummary = { id: "capture-1", at: "2026-11-05T12:30:00Z", selected: 4, queued: 1, skippedExistingPDF: 2, ignored: 1, message: "加入 1 项；已有 PDF 跳过 2 项。<img src=x onerror=bad>" };
  renderListener();
  assert.equal(root.dataset.activePage, "tasks", "a new batch summary opens the task tab");
  assert.equal(get("fta-pref-batch-summary").hidden, false);
  assert.match(get("fta-pref-batch-message").textContent, /加入 1 项；已有 PDF 跳过 2 项/);
  assert.equal(get("fta-pref-batch-summary").querySelector("img"), null);
  assert.ok(get("fta-pref-batch-time").textContent);
  pageTab("settings").click(); renderListener();
  assert.equal(root.dataset.activePage, "settings", "an ordinary snapshot update does not steal the selected tab");
  model.captureSummary = { ...model.captureSummary, at: "2026-11-05T12:31:00Z" }; renderListener();
  assert.equal(root.dataset.activePage, "settings", "a stable batch ID takes precedence over timestamp changes");
  model.captureSummary = { ...model.captureSummary, id: "capture-2", failed: 1, message: "加入 0 项，检查失败 1 项。" }; renderListener();
  assert.equal(root.dataset.activePage, "tasks");
  assert.equal(get("fta-pref-batch-summary").dataset.tone, "warning");
  model.captureSummary = null; renderListener();
  assert.equal(get("fta-pref-batch-summary").hidden, true);
  assert.equal(get("fta-pref-bulk-actions").hidden, true, "an empty task page does not show unusable paid actions");
  assert.equal(get("fta-pref-bulk-note").hidden, true);
  assert.equal(get("fta-pref-task-count").textContent, "0");
  assert.equal(get("fta-pref-task-empty").hidden, false);
  assert.equal(get("fta-pref-account-state").textContent, "未登录");
  assert.equal(get("fta-pref-auto-download").checked, true);
  assert.equal(root.textContent.includes("QxRqAb"), false);
  assert.equal(root.textContent.includes("打开全文助手"), false);
  assert.match(root.textContent, /在文库多选文献/);
  assert.match(root.textContent, /全文助手 → 批量获取全文/);
  assert.equal(get("fta-pref-poll").getAttribute("max"), "3600");
  assert.match(get("fta-pref-poll").parentElement.textContent, /科研通应助检查间隔（秒）/);
  assert.equal(get("fta-pref-bulk-assist").disabled, true);
  assert.equal(get("fta-pref-select-tasks").disabled, true);
  assert.equal(get("fta-pref-save-login").textContent, "保存并打开登录");
  assert.equal(filterButton("unfinished").getAttribute("aria-pressed"), "true", "a new settings view defaults to unfinished tasks");
  assert.match(root.textContent, /任务和已获取记录保存在本机/);
  assert.match(root.textContent, /可继续从文库追加，排队按加入顺序处理/);
  assert.match(root.textContent, /关闭 Zotero 后停止检查/);
  assert.match(root.textContent, /优先使用账号当前的免积分高速权益，否则使用普通免费线路/);
  assert.match(root.textContent, /不自动购买高速下载/);
  assert.match(root.textContent, /只将该文件对应的上传消息标记已读，不会将所有消息标为已读/);
  assert.doesNotMatch(root.textContent, /专用 Edge|继续专用 Edge/);
  assert.match(root.textContent, /“浏览器下载并自动入库”使用平常的默认浏览器/);
  assert.match(root.textContent, /不递归扫描子目录/);
  assert.match(root.textContent, /最多等待 30 分钟/);
  assert.match(root.textContent, /不代你操作浏览器/);
  const directories = () => [...get("fta-pref-download-directories").querySelectorAll("input")].map(node => node.value);
  assert.deepEqual(directories(), ["D:\\Downloads"]);
  assert.equal(get("fta-pref-download-directories").querySelector("input").readOnly, true);
  assert.equal(calls.some(call => call[0] === "detectDirectories"), false, "rendering never silently redetects removed folders");
  cancelDirectory = true;
  get("fta-pref-choose-directory").click(); await flush();
  assert.deepEqual(directories(), ["D:\\Downloads"]);
  assert.match(get("fta-pref-status").textContent, /已取消添加/);
  cancelDirectory = false;
  get("fta-pref-choose-directory").click(); await flush();
  assert.deepEqual(directories(), ["D:\\Downloads", "D:\\Research"], "the picker appends without replacing existing directories");
  get("fta-pref-download-directories").querySelector("button").click(); await flush();
  assert.deepEqual(calls.at(-1), ["removeDirectory", "D:\\Downloads"]);
  assert.deepEqual(directories(), ["D:\\Research"]);
  renderListener();
  assert.deepEqual(directories(), ["D:\\Research"]);
  get("fta-pref-detect-directories").click(); await flush();
  assert.deepEqual(directories(), ["D:\\Research", "D:\\BrowserDownloads"]);
  assert.match(get("fta-pref-status").textContent, /添加了 1 个新下载目录/);
  get("fta-pref-detect-directories").click(); await flush();
  assert.match(get("fta-pref-status").textContent, /未发现新的下载目录/);
  for (const [method, id] of [["chooseDownloadDirectory", "fta-pref-choose-directory"], ["detectDownloadDirectories", "fta-pref-detect-directories"]]) {
    const original = app[method]; delete app[method]; renderListener();
    assert.equal(get(id).disabled, true); app[method] = original;
  }
  const removeDownloadDirectory = app.removeDownloadDirectory;
  delete app.removeDownloadDirectory; renderListener();
  assert.equal(get("fta-pref-download-directories").querySelector("button").disabled, true);
  app.removeDownloadDirectory = removeDownloadDirectory;
  delete model.settings.downloadDirectories;
  model.settings.downloadDirectory = "D:\\Legacy"; renderListener();
  assert.deepEqual(directories(), ["D:\\Legacy"], "old one-directory settings still display");
  model.settings.downloadDirectories = []; renderListener();
  assert.deepEqual(directories(), [], "an explicit empty list wins over legacy settings");
  assert.match(get("fta-pref-download-directories").textContent, /尚未配置/);
  model.settings.downloadDirectories = ["D:\\Research", "D:\\Research", "<b>folder</b>", null, ""];
  renderListener();
  assert.deepEqual(directories(), ["D:\\Research", "<b>folder</b>"]);
  assert.equal(get("fta-pref-download-directories").querySelector("b"), null);
  model.settings.downloadDirectories = ["D:\\Downloads"]; model.settings.downloadDirectory = "D:\\Downloads"; renderListener();
  for (const [method, control] of [["chooseDownloadDirectory", () => get("fta-pref-choose-directory")], ["removeDownloadDirectory", () => get("fta-pref-download-directories").querySelector("button")], ["detectDownloadDirectories", () => get("fta-pref-detect-directories")]]) {
    const original = app[method];
    app[method] = async () => ({ cancelled: false, changed: true, added: 1, paused: 2 }); renderListener();
    control().click(); await flush();
    assert.match(get("fta-pref-status").textContent, /已暂停 2 个等待下载的任务/);
    assert.match(get("fta-pref-status").textContent, /浏览器下载并自动入库.*按新目录重新开始检查/);
    app[method] = async () => ({ cancelled: false, changed: false, added: 0, paused: 0 }); renderListener();
    control().click(); await flush();
    assert.doesNotMatch(get("fta-pref-status").textContent, /已暂停/);
    app[method] = original;
  }
  renderListener();
  assert.equal(get("fta-pref-message-count"), null, "the message heading has no unexplained numeric badge");
  assert.equal(get("fta-pref-publisher-session").hidden, true, "an unsupported publisher-session API has no misleading status");
  model.publisherSession = { enabled: false, initialized: false, hosts: [], hasBackup: false };
  renderListener();
  assert.match(get("fta-pref-publisher-session").textContent, /正在读取/);
  model.publisherSession.initialized = true;
  renderListener();
  assert.match(get("fta-pref-publisher-session").textContent, /尚未保存/);
  assert.equal(get("fta-pref-publisher-session").textContent.includes("已关闭"), false, "no granted hosts does not mean the user disabled remembering login");
  model.publisherSession.enabled = true;
  renderListener();
  assert.match(get("fta-pref-publisher-session").textContent, /已启用保存/);
  model.publisherSession = { enabled: true, initialized: true, hasBackup: true, savedAt: "2026-11-04T12:00:00Z", hosts: ["private-institution.example.invalid"] };
  renderListener();
  assert.equal(get("fta-pref-publisher-session").hidden, false);
  assert.match(get("fta-pref-publisher-session").textContent, /已在本机加密保存（2026\/11\/4/);
  assert.match(get("fta-pref-publisher-session").textContent, /网站会话过期后需重新登录/);
  assert.equal(root.textContent.includes("private-institution.example.invalid"), false, "the settings pane does not dump tracked hosts");
  model.publisherSession.error = "internal storage detail";
  renderListener();
  assert.match(get("fta-pref-publisher-session").textContent, /保存或恢复未完成/);
  assert.equal(get("fta-pref-publisher-session").dataset.error, "true");
  assert.equal(root.textContent.includes("internal storage detail"), false);
  delete model.publisherSession;
  renderListener();
  assert.equal(get("fta-pref-publisher-session").hidden, true);
  submit("fta-pref-account-form"); await flush();
  assert.equal(calls.filter(c => c[0] === "login").length, 0);
  input("fta-pref-username", "tester@example.invalid");
  input("fta-pref-password", "test-only-secret");
  pageTab("tasks").click(); pageTab("messages").click(); pageTab("account").click();
  assert.equal(get("fta-pref-username").value, "tester@example.invalid");
  assert.equal(get("fta-pref-password").value, "test-only-secret", "navigation preserves the account draft until explicit login or destruction");
  submit("fta-pref-account-form");
  assert.equal(get("fta-pref-password").value, "", "password cleared immediately before login call");
  await flush();
  assert.equal(calls.find(call => call[0] === "login")[1].username, "tester@example.invalid");
  assert.equal(calls.find(call => call[0] === "login")[1].password, "test-only-secret");
  assert.equal(root.textContent.includes("test-only-secret"), false);
  assert.equal(get("fta-pref-account-state").textContent, "需要登录", "saving credentials must not imply that login succeeded");
  assert.match(get("fta-pref-status").textContent, /请在打开的科研通网页完成登录/);
  assert.match(get("fta-pref-password").placeholder, /已保存/);
  submit("fta-pref-account-form"); await flush();
  assert.equal(calls.filter(c => c[0] === "login").at(-1)[1].password, "");
  model.session.status = "authenticated";
  model.session.displayName = "研究者 <strong>甲</strong>";
  renderListener();
  assert.equal(get("fta-pref-account-identity").hidden, false);
  assert.equal(get("fta-pref-account-identity").textContent, "当前绑定：研究者 <strong>甲</strong>");
  assert.equal(get("fta-pref-account-identity").querySelector("strong"), null);
  assert.equal(get("fta-pref-username").value, "tester@example.invalid", "site display name never overwrites saved login username");
  input("fta-pref-username", "different@example.invalid");
  submit("fta-pref-account-form"); await flush();
  assert.equal(calls.filter(c => c[0] === "login").length, 2, "different account cannot reuse blank saved password");
  input("fta-pref-points", "25"); input("fta-pref-poll", "120");
  get("fta-pref-auto-download").checked = false;
  get("fta-pref-auto-download").dispatchEvent(new window.Event("input"));
  pageTab("settings").click();
  assert.equal(pageTab("settings").dataset.dirty, "true");
  assert.match(pageTab("settings").getAttribute("aria-label"), /未保存/);
  const draftPointsNode = get("fta-pref-points");
  const beforeDraftNavigation = calls.length;
  for (const page of ["messages", "account", "tasks", "settings"]) pageTab(page).click();
  renderListener();
  assert.equal(get("fta-pref-points").value, "25", "dirty input survives state update");
  assert.equal(get("fta-pref-points"), draftPointsNode, "tabs retain the actual form controls rather than remounting them");
  assert.equal(get("fta-pref-poll").value, "120");
  assert.equal(get("fta-pref-auto-download").checked, false);
  assert.equal(calls.length, beforeDraftNavigation, "switching tabs neither saves nor resets a draft");
  model.captureSummary = { id: "capture-with-draft", at: "2026-11-05T12:35:00Z", queued: 1, message: "加入 1 项。" }; renderListener();
  assert.equal(root.dataset.activePage, "tasks");
  pageTab("settings").click();
  assert.equal(get("fta-pref-points").value, "25", "a new batch can open tasks without discarding an unsaved settings draft");
  model.captureSummary = null;
  submit("fta-pref-settings-form"); await flush();
  assert.equal(pageTab("settings").dataset.dirty, "false");
  assert.equal(model.settings.points, 25);
  assert.equal(model.settings.pollSeconds, 120);
  assert.equal(model.settings.autoDownload, false);
  const savedCount = calls.filter(c => c[0] === "save").length;
  for (const invalid of ["0", "1.5", "10001", ""]) { input("fta-pref-points", invalid); submit("fta-pref-settings-form"); await flush(); }
  assert.equal(calls.filter(c => c[0] === "save").length, savedCount);
  input("fta-pref-points", "25"); input("fta-pref-poll", "30"); submit("fta-pref-settings-form"); await flush();
  assert.match(get("fta-pref-save-state").textContent, /60–3600/);
  input("fta-pref-poll", "3600"); submit("fta-pref-settings-form"); await flush();
  assert.equal(model.settings.pollSeconds, 3600, "upper bound matches the app API");
  const validPollCount = calls.filter(c => c[0] === "save").length;
  for (const invalid of ["3601", "59", "120.5", ""]) { input("fta-pref-poll", invalid); submit("fta-pref-settings-form"); await flush(); }
  assert.equal(calls.filter(c => c[0] === "save").length, validPollCount);
  input("fta-pref-poll", "120");
  model.tasks = [
    { id: "queue-done", state: "imported" },
    { id: "queue-first", state: "queued" },
    { id: "queue-remote", state: "waiting", requestID: "ExistingRequest" },
    { id: "queue-working", state: "resolving" },
    { id: "queue-warning", state: "needs_login" },
    { id: "queue-second", state: "queued" },
    { id: "queue-browser", state: "manual_waiting" }
  ];
  renderListener();
  const badgeText = id => taskRow(id).querySelector(".fta-status-badge").textContent;
  assert.equal(badgeText("queue-first"), "排队中 · 第 1 位");
  assert.equal(badgeText("queue-second"), "排队中 · 第 2 位");
  model.tasks.push({ id: "queue-third", state: "queued" }, { id: "queue-fourth", state: "queued" });
  renderListener();
  assert.equal(get("fta-pref-task-summary").textContent, "显示 8/9 项 · 正在获取 1 项 · 排队 4 项 · 等待应助 1 项 · 等待浏览器下载 1 项");
  assert.equal(badgeText("queue-third"), "排队中 · 第 3 位", "a second batch joins after the first queued batch");
  assert.equal(badgeText("queue-fourth"), "排队中 · 第 4 位");
  assert.equal(badgeText("queue-remote"), "等待应助", "remote waiting is not a numbered download queue slot");
  assert.equal(badgeText("queue-warning"), "需网页登录");
  assert.equal(taskRow("queue-warning").querySelector(".fta-status-badge").dataset.tone, "warning");
  filterButton("all").click();
  assert.equal(taskRow("queue-third"), null, "completed history excludes queued tasks");
  filterButton("active").click();
  assert.equal(get("fta-pref-task-list").children.length, 7, "active filter retains queued, acquiring and waiting tasks");
  assert.equal(badgeText("queue-fourth"), "排队中 · 第 4 位", "rank comes from the full snapshot, not visible row indices");
  assert.equal(taskRow("queue-warning"), null);
  model.tasks.find(task => task.id === "queue-first").state = "resolving";
  model.tasks.find(task => task.id === "queue-working").state = "imported";
  renderListener();
  assert.equal(badgeText("queue-first"), "正在获取");
  assert.equal(badgeText("queue-second"), "排队中 · 第 1 位");
  assert.equal(badgeText("queue-third"), "排队中 · 第 2 位");
  assert.equal(badgeText("queue-fourth"), "排队中 · 第 3 位");
  filterButton("unfinished").click();
  assert.equal(badgeText("queue-third"), "排队中 · 第 2 位", "switching filters keeps the updated global rank");
  const formattedTitle = '<i>OXTR</i> and <I>Eda</I>: <b>B</b><em>E</em><strong>S</strong> H<sub>2</sub>O x<sup>2</sup> <span class="nocase" title="a > b" onclick="bad()">Gene</span>; p < 0.05, a < b > c, <x>, <i + j>';
  const plainTitle = 'OXTR and Eda: BES H2O x2 Gene; p < 0.05, a < b > c, <x>, <i + j>';
  model.tasks = [{ id: "formatted-title", itemID: 700, title: formattedTitle, doi: "10.1234/format", state: "not_found" }];
  renderListener();
  assert.equal(taskRow("formatted-title").querySelector(".fta-row-title").textContent, plainTitle);
  assert.equal(taskCheckbox("formatted-title").getAttribute("aria-label"), "选择文献：" + plainTitle);
  assert.equal(get("fta-pref-request-target").querySelector('option[value="formatted-title"]').textContent, plainTitle + " — 10.1234/format");
  assert.equal(taskRow("formatted-title").querySelector("i,b,em,strong,sub,sup,[onclick]"), null, "formatting is converted to text without parsing markup or attributes");
  assert.equal(model.tasks[0].title, formattedTitle, "display normalization never mutates source metadata");
  model.tasks = [{ id: "t1", title: "<img src=x onerror=bad> paper", doi: "10.1234/test", state: "waiting", requestURL: "https://www.ablesci.com/assist/detail?id=EXAMPLE", requestedPoints: 25 }];
  renderListener();
  assert.equal(get("fta-pref-task-list").querySelector("img"), null);
  assert.match(get("fta-pref-task-list").textContent, /等待应助/);
  rowButton("立即检查").click(); await flush();
  rowButton("查看已有求助").click(); await flush();
  rowButton("暂停").click(); await flush();
  assert.equal(model.tasks[0].state, "paused");
  rowButton("重试").click(); await flush();
  assert.equal(model.tasks[0].state, "waiting");
  assert.deepEqual(calls.at(-1), ["retry", "t1", null], "remote request retries never override the published budget");
  assert.equal(assistButton(), undefined, "an existing request must never expose duplicate fallback submission");
  app.openTask = async id => calls.push(["openTask", id]);
  model.tasks = [
    { id: "batch-1", title: "已找到的文献", state: "imported", attachmentID: 42, completedAt: "2026-11-04T12:00:00Z", updatedAt: "2026-11-06T12:00:00Z", source: "publisher", message: "旧下载进度" },
    { id: "batch-2", title: "未找到的文献", doi: "10.1234/missing", state: "not_found" },
    { id: "batch-3", title: "需机构登录的文献", doi: "10.1234/login", state: "needs_login" },
    { id: "batch-4", title: "仍在查找的文献", state: "resolving" }
  ];
  renderListener();
  assert.equal(get("fta-pref-task-count").textContent, "4");
  assert.equal(get("fta-pref-task-summary").textContent, "显示 3/4 项 · 正在获取 1 项");
  assert.equal(taskRow("batch-1"), null, "completed tasks are absent from the default work list");
  for (const label of ["未找到全文", "需网页登录", "正在获取"]) assert.ok(get("fta-pref-task-list").textContent.includes(label), label);
  assert.equal([...get("fta-pref-task-list").querySelectorAll("button")].filter(b => b.textContent.startsWith("科研通求助")).length, 2);
  filterButton("success").click();
  assert.equal(get("fta-pref-task-list").children.length, 1);
  assert.deepEqual([get("fta-pref-bulk-actions").hidden, get("fta-pref-bulk-note").hidden], [true, true], "completed history hides bulk submission controls and guidance");
  assert.match(taskRow("batch-1").textContent, /完成 2026\/11\/4/);
  assert.match(taskRow("batch-1").textContent, /来源：出版社网页/);
  assert.equal(taskRow("batch-1").textContent.includes("旧下载进度"), false, "history does not retain stale progress instructions");
  assert.equal(rowButton("立即检查"), undefined);
  assert.equal(rowButton("暂停"), undefined);
  rowButton("打开全文").click(); await flush();
  assert.deepEqual(calls.at(-1), ["openTask", "batch-1"]);
  filterButton("unfinished").click();
  assert.deepEqual([get("fta-pref-bulk-actions").hidden, get("fta-pref-bulk-note").hidden], [false, false], "returning to unfinished tasks restores bulk submission controls and guidance");
  const fallback = assistButton();
  assert.equal(fallback.textContent, "科研通求助（25 积分）");
  assert.equal(fallback.disabled, false);
  fallback.click(); await flush();
  assert.deepEqual(calls.at(-1), ["assist", ["batch-2"], { points: 25 }]);
  assert.equal(model.tasks[1].state, "submitting");
  assert.equal([...get("fta-pref-task-list").querySelectorAll("button")].filter(b => b.textContent.startsWith("科研通求助")).length, 1, "in-flight requests cannot be submitted twice");
  const requestAssist = app.requestAssist;
  delete app.requestAssist;
  renderListener();
  assert.equal(assistButton().disabled, true, "unsupported app actions stay disabled");
  app.requestAssist = requestAssist;
  model.tasks = [
    { id: "select-1", title: "已获取", state: "imported", attachmentID: 42 },
    { id: "select-2", title: "缺少全文", doi: "10.1234/missing", state: "not_found", requestedPoints: 10 },
    { id: "select-3", title: "需网页登录", doi: "10.1234/login", state: "needs_login", requestedPoints: 25 },
    { id: "select-4", title: "正在处理", doi: "10.1234/working", state: "resolving" },
    { id: "select-5", title: "缺 DOI", state: "not_found" },
    { id: "select-6", title: "已有求助失败", doi: "10.1234/remote", state: "error", requestID: "Existing" },
    { id: "select-7", title: "提交待核实", doi: "10.1234/unknown", state: "submission_unknown" },
    { id: "select-8", title: "需账号登录", doi: "10.1234/account", state: "pending_login", requestedPoints: 15 },
    { id: "select-9", title: "已暂停", doi: "10.1234/paused", state: "paused", requestedPoints: 10 }
  ];
  renderListener();
  assert.equal(filterButton("success").textContent, "已获取 1");
  assert.equal(filterButton("login").textContent, "需网页登录 2");
  assert.equal(filterButton("fallback").textContent, "待兜底 3");
  filterButton("success").click();
  assert.equal(get("fta-pref-task-list").children.length, 1);
  assert.equal(get("fta-pref-select-tasks").disabled, true);
  filterButton("login").click();
  assert.equal(get("fta-pref-task-list").children.length, 2);
  changeChecked(get("fta-pref-select-tasks"), true);
  assert.match(get("fta-pref-selection-summary").textContent, /已选 2 篇/);
  filterButton("fallback").click();
  assert.equal(filterButton("fallback").getAttribute("aria-pressed"), "true");
  assert.equal(get("fta-pref-selection-summary").textContent, "未选择文献", "switching filters cannot submit hidden selections");
  assert.equal(get("fta-pref-task-list").children.length, 3, "login tasks do not overlap the fallback category");
  filterButton("unfinished").click();
  assert.equal(taskCheckbox("select-5").disabled, true, "missing DOI is visible but cannot be submitted");
  assert.equal(taskCheckbox("select-6"), null, "a request ID alone prevents duplicate fallback");
  assert.equal(taskCheckbox("select-7"), null, "uncertain submissions cannot be selected");
  changeChecked(get("fta-pref-select-tasks"), true);
  assert.match(get("fta-pref-selection-summary").textContent, /已选 4 篇 · 本次悬赏合计 100 积分/, "explicit action uses the saved current default, not old task budgets");
  pageTab("settings").click(); pageTab("messages").click(); pageTab("tasks").click();
  assert.match(get("fta-pref-selection-summary").textContent, /已选 4 篇/);
  assert.equal(filterButton("unfinished").getAttribute("aria-pressed"), "true", "page tabs preserve the task filter and explicit selections");
  assert.match(get("fta-pref-bulk-assist").textContent, /每篇 25 积分/);
  changeChecked(taskCheckbox("select-3"), false);
  assert.equal(get("fta-pref-select-tasks").indeterminate, true);
  assert.match(get("fta-pref-selection-summary").textContent, /已选 3 篇/);
  model.tasks.find(task => task.id === "select-9").state = "imported";
  model.tasks.find(task => task.id === "select-9").attachmentID = 91;
  renderListener();
  assert.match(get("fta-pref-selection-summary").textContent, /已选 2 篇 · 本次悬赏合计 50 积分/, "completed tasks are removed from pending selection");
  get("fta-pref-bulk-assist").click(); await flush();
  assert.deepEqual(calls.at(-1), ["assist", ["select-2", "select-8"], { points: 25 }]);
  assert.match(get("fta-pref-status").textContent, /已将 2 篇转入科研通求助流程/);
  assert.equal(get("fta-pref-bulk-assist").disabled, true);
  assert.equal(get("fta-pref-selection-summary").textContent, "未选择文献");
  changeChecked(taskCheckbox("select-3"), true);
  model.tasks.find(task => task.id === "select-3").requestID = "RaceExisting";
  get("fta-pref-bulk-assist").click(); await flush();
  assert.match(get("fta-pref-status").textContent, /没有新增求助任务。已跳过 1 项/, "stale selected tasks are not reported as accepted");
  filterButton("unfinished").click();
  input("fta-pref-points", "35");
  model.tasks = [{ id: "retry-budget", title: "原预算不足", state: "error", requestedPoints: 10, doi: "10.1234/low-budget", itemID: 76 }];
  renderListener();
  assert.equal(assistButton().textContent, "科研通求助（35 积分）");
  rowButton("按 35 积分重试").click(); await flush();
  assert.deepEqual(calls.at(-1), ["retry", "retry-budget", { points: 35 }]);
  assert.equal(model.tasks[0].requestedPoints, 35);
  model.tasks = [
    { id: "live-one", itemID: 770, title: "即时积分一", state: "not_found", doi: "10.1234/live-one" },
    { id: "live-two", itemID: 771, title: "即时积分二", state: "manual_waiting", acquisitionMode: "manual", doi: "10.1234/live-two" }
  ];
  renderListener();
  changeChecked(get("fta-pref-select-tasks"), true);
  input("fta-pref-points", "41");
  assert.equal(assistButton().textContent, "科研通求助（41 积分）", "single action updates without saving or blurring");
  assert.equal(rowButton("按 41 积分重试").disabled, false);
  assert.match(get("fta-pref-bulk-assist").textContent, /每篇 41 积分/);
  assert.match(get("fta-pref-selection-summary").textContent, /合计 82 积分/);
  assert.equal(model.settings.points, 35, "typing has not silently saved a budget");
  const staleAssist = assistButton();
  input("fta-pref-points", "42");
  const beforeStaleAction = calls.length;
  staleAssist.click(); await flush();
  assert.equal(calls.length, beforeStaleAction, "a detached stale button cannot save or submit its old amount");
  assert.match(get("fta-pref-status").textContent, /悬赏积分已变化/);
  for (const invalid of ["0", "-1", "1.5", "10001", "", "1e2", "NaN"]) {
    input("fta-pref-points", invalid);
    assert.equal(assistButton().disabled, true);
    assert.equal(get("fta-pref-bulk-assist").disabled, true);
    assert.equal(get("fta-pref-points").getAttribute("aria-invalid"), "true");
    const beforeInvalid = calls.length;
    assistButton().click(); get("fta-pref-bulk-assist").click(); await flush();
    assert.equal(calls.length, beforeInvalid, "invalid amounts cannot save or submit");
  }
  input("fta-pref-points", "42");
  const saveSettings = app.saveSettings;
  delete app.saveSettings; renderListener();
  assert.equal(assistButton().disabled, true);
  assert.equal(get("fta-pref-bulk-assist").disabled, true);
  app.saveSettings = async () => { throw new Error("积分保存失败"); }; renderListener();
  const beforeSaveFailure = calls.length;
  assistButton().click(); await flush();
  assert.equal(calls.length, beforeSaveFailure, "failed budget persistence prevents submission");
  assert.match(get("fta-pref-status").textContent, /积分保存失败/);
  app.saveSettings = saveSettings;
  input("fta-pref-poll", "180");
  get("fta-pref-auto-download").checked = true;
  get("fta-pref-auto-download").dispatchEvent(new window.Event("input"));
  renderListener();
  get("fta-pref-bulk-assist").click(); await flush();
  assert.deepEqual(calls.slice(-2), [["save", { points: 42 }], ["assist", ["live-one", "live-two"], { points: 42 }]], "the displayed bulk budget is saved before submission with the identical amount");
  assert.equal(model.settings.points, 42);
  assert.equal(get("fta-pref-poll").value, "180", "point-only persistence preserves unrelated unsaved inputs");
  assert.equal(get("fta-pref-auto-download").checked, true);
  assert.equal(model.settings.pollSeconds, 3600);
  assert.equal(model.settings.autoDownload, false);
  assert.match(get("fta-pref-save-state").textContent, /其他设置仍有未保存/);
  Object.assign(model.tasks[0], { state: "not_found", acquisitionMode: "" }); renderListener();
  input("fta-pref-points", "43");
  assistButton().click(); await flush();
  assert.deepEqual(calls.slice(-2), [["save", { points: 43 }], ["assist", ["live-one"], { points: 43 }]], "one-task action also saves then posts the displayed amount");
  Object.assign(model.tasks[0], { state: "error" }); renderListener();
  input("fta-pref-points", "44");
  rowButton("按 44 积分重试").click(); await flush();
  assert.deepEqual(calls.slice(-2), [["save", { points: 44 }], ["retry", "live-one", { points: 44 }]], "budgeted retry follows the same captured-amount contract");
  submit("fta-pref-settings-form"); await flush();
  assert.equal(model.settings.pollSeconds, 180);
  assert.equal(model.settings.autoDownload, true);
  assert.deepEqual(model.settings.downloadDirectories, ["D:\\Downloads"], "saving ordinary settings preserves configured folders");
  model.settings.autoDownload = false;
  model.tasks = [{ id: "manual-file", title: "可手动下载", state: "available", itemID: 77, requestID: "FileReady", requestURL: "https://www.ablesci.com/assist/detail?id=FileReady" }];
  renderListener();
  assert.equal(rowButton("下载到文库").disabled, false, "manual download stays available when automatic download is off");
  rowButton("下载到文库").click(); await flush();
  assert.equal(model.tasks[0].state, "imported");
  assert.deepEqual(calls.at(-1), ["download", "manual-file"]);
  assert.equal(rowButton("下载到文库"), undefined);
  filterButton("unfinished").click();
  assert.equal(get("fta-pref-task-list").children.length, 0);
  assert.match(get("fta-pref-task-empty").textContent, /跨批次的已获取记录可在“全部历史”中查看/);
  model.tasks = [{ id: "unbound-file", title: "仅跟踪的已应助任务", doi: "10.1234/bind", itemID: null, state: "available", requestID: "ReadyUnbound", requestURL: "https://www.ablesci.com/assist/detail?id=ReadyUnbound" }];
  bindingCandidates = [
    { itemID: 501, title: "<strong>对应文献</strong>", doi: "10.1234/bind", libraryName: "我的文库" },
    { itemID: 502, title: "第二个同 DOI 条目", doi: "10.1234/bind", libraryName: "可写群组" },
    { itemID: 501, title: "重复候选" },
    { itemID: -1, title: "无效候选" }
  ];
  renderListener();
  assert.match(taskRow("unbound-file").textContent, /待关联文献/);
  assert.match(taskRow("unbound-file").textContent, /尚未关联 Zotero 文献/);
  assert.equal(rowButton("下载到文库"), undefined, "unbound files cannot be imported without a parent");
  assert.equal(rowButton("选择已下载的PDF"), undefined);
  assert.equal(rowButton("关联文献").disabled, false);
  const beforeBindCount = calls.filter(call => call[0] === "bind").length;
  rowButton("关联文献").click(); await flush();
  assert.deepEqual(calls.at(-1), ["bindingCandidates", "unbound-file"]);
  assert.equal(get("fta-pref-binding-target").value, "", "candidate selection starts empty even if there is a likely match");
  assert.equal(get("fta-pref-binding-target").querySelectorAll("option").length, 3, "invalid and duplicate item IDs are removed");
  assert.equal(get("fta-pref-binding-target").querySelector("strong"), null, "candidate titles are inserted as text");
  assert.equal(get("fta-pref-binding-target").querySelector('option[value="501"]').textContent, "对应文献 — 10.1234/bind — 我的文库", "binding candidates remove inline formatting too");
  assert.equal(bindingCandidates[0].title, "<strong>对应文献</strong>");
  assert.equal(rowButton("确认关联").disabled, true);
  rowButton("确认关联").click(); await flush();
  assert.equal(calls.filter(call => call[0] === "bind").length, beforeBindCount);
  chooseBindingTarget(502);
  renderListener();
  assert.equal(get("fta-pref-binding-target").value, "502", "explicit choice survives automatic snapshots");
  assert.equal(rowButton("确认关联").disabled, false);
  const bindExistingTask = app.bindExistingTask;
  app.bindExistingTask = async () => { throw new Error("对应文献不可写，请重新选择。"); };
  rowButton("确认关联").click(); await flush();
  assert.match(get("fta-pref-status").textContent, /对应文献不可写/);
  assert.equal(get("fta-pref-binding-target").value, "502", "a rejected binding does not discard the user's explicit selection");
  assert.equal(model.tasks[0].itemID, null);
  app.bindExistingTask = bindExistingTask;
  rowButton("确认关联").click(); await flush();
  assert.deepEqual(calls.at(-1), ["bind", "unbound-file", 502]);
  assert.equal(model.tasks[0].itemID, 502);
  assert.equal(model.tasks[0].state, "available", "manual-download preference remains respected after binding");
  assert.equal(get("fta-pref-binding-target"), null);
  assert.equal(rowButton("关联文献"), undefined);
  assert.equal(rowButton("下载到文库").disabled, false);
  assert.match(get("fta-pref-status").textContent, /可点击“下载到文库”/);
  model.tasks[0].itemID = null;
  bindingCandidates = [];
  renderListener();
  rowButton("关联文献").click(); await flush();
  assert.equal(get("fta-pref-binding-target").disabled, true);
  assert.equal(rowButton("确认关联").disabled, true);
  assert.match(taskRow("unbound-file").textContent, /没有找到 DOI 相同且可写入附件的文献/);
  rowButton("取消").click();
  assert.equal(get("fta-pref-binding-target"), null);
  bindingCandidates = [{ itemID: 501, title: "对应文献", doi: "10.1234/bind" }];
  rowButton("关联文献").click(); await flush();
  chooseBindingTarget(501);
  filterButton("active").click();
  assert.equal(get("fta-pref-binding-target"), null, "switching filters clears the binding form along with batch selection");
  rowButton("关联文献").click(); await flush();
  assert.equal(get("fta-pref-binding-target").value, "", "reopening never reuses a previous item's selection");
  chooseBindingTarget(501);
  model.tasks[0].itemID = 502;
  renderListener();
  assert.equal(get("fta-pref-binding-target"), null, "a task bound by another update no longer offers a stale association");
  model.tasks[0].itemID = null;
  delete app.getBindingCandidates;
  renderListener();
  assert.equal(rowButton("关联文献").disabled, true, "unsupported binding APIs do not leave active controls");
  app.getBindingCandidates = async id => { calls.push(["bindingCandidates", id]); return structuredClone(bindingCandidates); };
  model.settings.autoDownload = true;
  filterButton("unfinished").click();
  rowButton("关联文献").click(); await flush();
  chooseBindingTarget(501);
  rowButton("确认关联").click(); await flush();
  assert.equal(model.tasks[0].state, "imported");
  assert.equal(get("fta-pref-task-list").children.length, 0, "an automatically completed binding leaves the unfinished list");
  filterButton("success").click();
  assert.match(taskRow("unbound-file").textContent, /来源：科研通/);
  model.tasks = [
    { id: "history-old", title: "较早记录", itemID: 601, attachmentID: 601, state: "completed", completedAt: "2025-12-31T01:00:00Z", updatedAt: "2026-12-31T01:00:00Z", source: "open_access" },
    { id: "history-new", title: "较新记录", itemID: 602, attachmentID: 602, state: "imported", completedAt: "2026-11-04T01:00:00Z", source: "existing" },
    { id: "history-legacy", title: "旧格式记录", itemID: 603, attachmentID: 603, state: "imported", updatedAt: "2024-01-01T01:00:00Z" }
  ];
  renderListener();
  assert.equal(get("fta-pref-task-list").firstElementChild.dataset.taskId, "history-new", "history sorts by completion time rather than later metadata updates");
  assert.match(taskRow("history-old").textContent, /完成 2025\/12\/31/);
  assert.match(taskRow("history-old").textContent, /来源：开放获取/);
  assert.match(taskRow("history-legacy").textContent, /完成 2024\/1\/1/);
  assert.match(taskRow("history-legacy").textContent, /来源：未记录/);
  model.tasks = [
    { id: "route-normal", title: "普通下载完成", itemID: 610, attachmentID: 610, state: "imported", source: "ablesci", downloadRoute: "normal", completedAt: "2026-11-04T01:00:00Z" },
    { id: "route-highspeed", title: "高速下载完成", itemID: 611, attachmentID: 611, state: "imported", source: "ablesci", downloadRoute: "highspeed", completedAt: "2026-11-04T02:00:00Z" },
    { id: "route-old", title: "旧科研通记录", itemID: 612, attachmentID: 612, state: "imported", source: "ablesci", completedAt: "2026-11-04T03:00:00Z" },
    { id: "route-local", title: "后续使用本地文件", itemID: 613, attachmentID: 613, state: "imported", source: "local_file", downloadRoute: "highspeed", completedAt: "2026-11-04T04:00:00Z" },
    { id: "route-unknown", title: "未知线路", itemID: 614, attachmentID: 614, state: "imported", source: "ablesci", downloadRoute: "__proto__", completedAt: "2026-11-04T05:00:00Z" }
  ];
  renderListener();
  assert.match(taskRow("route-normal").querySelector(".fta-row-meta").textContent, /来源：科研通 · 普通线路/);
  assert.match(taskRow("route-highspeed").querySelector(".fta-row-meta").textContent, /来源：科研通 · 免积分高速/);
  for (const id of ["route-old", "route-local", "route-unknown"]) assert.doesNotMatch(taskRow(id).querySelector(".fta-row-meta").textContent, /普通线路|免积分高速|__proto__|\[object Object\]/, "only recorded AbleSci routes are shown");
  filterButton("unfinished").click();
  model.tasks = [{ id: "route-running", title: "正在获取应助文件", itemID: 620, state: "downloading", requestID: "RouteReady", requestedPoints: 10, downloadRoute: "highspeed" }];
  renderListener();
  assert.match(taskRow("route-running").querySelector(".fta-row-meta").textContent, /来源：科研通 · 免积分高速/);
  assert.match(taskRow("route-running").querySelector(".fta-row-meta").textContent, /悬赏 10 积分/);
  assert.doesNotMatch(taskRow("route-running").querySelector(".fta-row-meta").textContent, /求助预算/);
  model.tasks[0].state = "validating";
  model.tasks[0].downloadRoute = "normal";
  renderListener();
  assert.match(taskRow("route-running").querySelector(".fta-row-meta").textContent, /来源：科研通 · 普通线路/);
  model.tasks[0].state = "available";
  renderListener();
  assert.doesNotMatch(taskRow("route-running").querySelector(".fta-row-meta").textContent, /来源：科研通|普通线路|免积分高速/, "a stale prior attempt is not presented as the next route before download starts");
  Object.assign(model.tasks[0], { state: "error", requestURL: "https://www.ablesci.com/assist/detail?id=RouteReady", acquisitionMode: "browser" });
  renderListener();
  assert.equal(rowButton("专用 Edge 自动获取"), undefined, "existing requests cannot enter publisher browser capture");
  assert.equal(rowButton("继续专用 Edge 获取"), undefined, "a legacy browser marker does not hide existing-request controls");
  assert.equal(rowButton("重试专用 Edge 获取"), undefined);
  assert.equal(rowButton("默认浏览器手动下载"), undefined);
  assert.equal(rowButton("选择已下载的PDF").disabled, false);
  assert.equal(rowButton("查看已有求助").disabled, false);
  assert.equal(rowButton("立即检查").disabled, false);
  assert.equal(rowButton("重试").disabled, false);
  filterButton("unfinished").click();
  model.tasks = [
    { id: "manual-login", title: "浏览器可下载的文献", itemID: 700, doi: "10.1234/browser", state: "needs_login", requestedPoints: 10 },
    { id: "unbound-login", title: "仅跟踪", doi: "10.1234/unbound", state: "needs_login" }
  ];
  filterButton("unfinished").click();
  renderListener();
  const labels = id => [...taskRow(id).querySelectorAll(".fta-row-actions button")].map(button => button.textContent);
  assert.equal(labels("unbound-login").includes("浏览器下载并自动入库"), false, "browser acquisition requires an associated Zotero item");
  assert.doesNotMatch(taskRow("manual-login").querySelector(".fta-row-meta").textContent, /积分/, "unsubmitted task budgets do not contradict the live input");
  changeChecked(taskCheckbox("manual-login"), true);
  rowButton("浏览器下载并自动入库").click(); await flush();
  assert.deepEqual(calls.at(-1), ["systemBrowser", "manual-login"]);
  assert.equal(model.tasks[0].state, "manual_waiting");
  assert.equal(model.tasks[0].acquisitionMode, "manual");
  assert.match(taskRow("manual-login").textContent, /等待浏览器下载/);
  assert.match(get("fta-pref-status").textContent, /明确匹配的新 PDF 会自动入库/);
  assert.match(get("fta-pref-status").textContent, /插件不会代你操作浏览器/);
  assert.equal(taskCheckbox("manual-login").disabled, false, "a waiting download remains an explicit AbleSci fallback candidate");
  assert.equal(taskCheckbox("manual-login").checked, true, "manual download does not discard an intentional fallback selection");
  assert.equal(assistButton().disabled, false);
  assert.equal(rowButton("暂停监控").disabled, false);
  assert.equal(labels("manual-login").includes("立即检查"), false);
  assert.equal(labels("manual-login").some(label => label.includes("重试")), false);
  assert.equal(labels("manual-login").some(label => label.includes("Edge")), false);
  rowButton("暂停监控").click(); await flush();
  assert.equal(model.tasks[0].state, "paused");
  assert.equal(model.tasks[0].acquisitionMode, "manual");
  assert.equal(assistButton().disabled, false);
  assert.equal(rowButton("浏览器下载并自动入库").disabled, false);
  rowButton("浏览器下载并自动入库").click(); await flush();
  assert.equal(model.tasks[0].state, "manual_waiting");
  for (const state of ["manual_waiting", "manual_review", "paused", "error", "failed", "needs_review", "captcha", "browser_waiting", "browser_scanning", "browser_downloading"]) {
    model.tasks[0].state = state; renderListener();
    assert.equal(taskCheckbox("manual-login").disabled, false, state + " retains explicit fallback");
    assert.equal(assistButton().disabled, false, state + " retains one-task fallback");
    assert.equal(labels("manual-login").some(label => label.includes("Edge")), false, state + " never exposes removed capture controls");
    assert.equal(labels("manual-login").includes("立即检查"), false, state + " does not call the obsolete acquisition retry route");
  }
  assert.equal(rowButton("预览待核对 PDF"), undefined, "review controls appear only for the review state");
  model.tasks[0].state = "manual_review"; renderListener();
  assert.equal(rowButton("暂停监控"), undefined, "a selected unknown file is awaiting review, not being monitored");
  assert.equal(rowButton("预览待核对 PDF").disabled, true);
  assert.equal(rowButton("我已核对，是这篇论文").disabled, true, "missing candidate filename blocks confirmation");
  const openSystemBrowserTask = app.openSystemBrowserTask;
  delete app.openSystemBrowserTask; renderListener();
  assert.equal(rowButton("浏览器下载并自动入库").disabled, true);
  app.openSystemBrowserTask = openSystemBrowserTask;
  model.tasks[0].state = "manual_waiting"; renderListener();
  get("fta-pref-bulk-assist").click(); await flush();
  assert.deepEqual(calls.at(-1), ["assist", ["manual-login"], { points: model.settings.points }]);
  assert.equal(model.tasks[0].state, "submitting");
  assert.equal(model.tasks[0].acquisitionMode, "");
  assert.equal(taskCheckbox("manual-login"), null);
  assert.equal(labels("manual-login").some(label => label.startsWith("科研通求助")), false, "submission cannot be duplicated");
  Object.assign(model.tasks[0], { state: "paused", acquisitionMode: "manual" }); renderListener();
  app.openSystemBrowserTask = async () => { throw new Error("默认浏览器暂时无法打开。"); };
  rowButton("浏览器下载并自动入库").click(); await flush();
  assert.match(get("fta-pref-status").textContent, /默认浏览器暂时无法打开/);
  assert.equal(rowButton("浏览器下载并自动入库").disabled, false);
  app.openSystemBrowserTask = async () => ({ opened: true, watching: false });
  rowButton("浏览器下载并自动入库").click(); await flush();
  assert.match(get("fta-pref-status").textContent, /下载文件夹检查尚未启动/);
  assert.doesNotMatch(get("fta-pref-status").textContent, /并接管/);
  app.openSystemBrowserTask = openSystemBrowserTask;
  cancelLocalImport = true;
  rowButton("选择已下载的PDF").click(); await flush();
  assert.equal(model.tasks[0].state, "paused");
  assert.match(get("fta-pref-status").textContent, /已取消选择文件/);
  cancelLocalImport = false; reviewLocalImport = true;
  rowButton("选择已下载的PDF").click(); await flush();
  assert.equal(model.tasks[0].state, "manual_review");
  assert.match(taskRow("manual-login").textContent, /待核对文件：<img src=x onerror=bad>.pdf/);
  assert.equal(taskRow("manual-login").textContent.includes("待关联文献：PDF title"), true);
  assert.match(taskRow("manual-login").textContent, /身份仍不确定/);
  assert.equal(taskRow("manual-login").querySelector("img"), null);
  assert.equal(taskRow("manual-login").querySelector("b"), null);
  assert.equal(calls.some(call => call[0] === "confirmPDF"), false, "choosing an unknown PDF never confirms it implicitly");
  assert.equal(assistButton().disabled, false);
  rowButton("预览待核对 PDF").click(); await flush();
  assert.deepEqual(calls.at(-1), ["previewPDF", "manual-login"]);
  assert.equal(model.tasks[0].state, "manual_review");
  rowButton("取消这次导入").click(); await flush();
  assert.deepEqual(calls.at(-1), ["dismissPDF", "manual-login"]);
  assert.equal(model.tasks[0].state, "paused");
  assert.match(get("fta-pref-status").textContent, /已取消，任务保留/);
  assert.doesNotMatch(get("fta-pref-status").textContent, /继续等待/);
  rowButton("选择已下载的PDF").click(); await flush();
  rowButton("我已核对，是这篇论文").click(); await flush();
  assert.deepEqual(calls.at(-1), ["confirmPDF", "manual-login"]);
  assert.equal(taskRow("manual-login"), null);
  filterButton("success").click();
  assert.match(taskRow("manual-login").textContent, /来源：本地 PDF/);
  reviewLocalImport = false;
  model.tasks.push({ id: "local-match", title: "身份匹配的本地 PDF", itemID: 703, doi: "10.1234/matched", state: "not_found" });
  filterButton("unfinished").click(); renderListener();
  const matchedRow = taskRow("local-match");
  [...matchedRow.querySelectorAll("button")].find(button => button.textContent === "选择已下载的PDF").click(); await flush();
  assert.equal(model.tasks.find(task => task.id === "local-match").state, "imported");
  model.tasks.push({ id: "browser-complete", title: "下载文件夹取得的全文", itemID: 701, attachmentID: 702, state: "imported", source: "browser_download", acquisitionMode: "manual", completedAt: "2026-11-05T01:00:00Z" });
  filterButton("success").click(); renderListener();
  assert.match(taskRow("browser-complete").textContent, /来源：浏览器下载/);
  assert.deepEqual(labels("browser-complete"), ["打开全文"]);
  model.tasks.push({ id: "manual-finish-race", title: "切换时完成的文献", itemID: 710, doi: "10.1234/finished", state: "manual_waiting", acquisitionMode: "manual" });
  app.openSystemBrowserTask = async id => {
    calls.push(["systemBrowser", id]);
    Object.assign(model.tasks.find(task => task.id === id), { state: "imported", attachmentID: 711, source: "browser_download" });
    renderListener(); return { opened: false, alreadyImported: true };
  };
  filterButton("unfinished").click(); renderListener();
  rowButton("浏览器下载并自动入库").click(); await flush();
  assert.deepEqual(calls.at(-1), ["systemBrowser", "manual-finish-race"]);
  assert.match(get("fta-pref-status").textContent, /已保存到原文献，无需再次下载/);
  assert.doesNotMatch(get("fta-pref-status").textContent, /已在默认浏览器打开|请自行下载/);
  assert.equal(calls.some(call => call[0] === "localPDF" && call[1] === "manual-finish-race"), false);
  app.openSystemBrowserTask = openSystemBrowserTask;
  model.messages = [{ id: "m1", title: "应助提醒", text: "<script>secret</script>", read: false, createdAt: "2026-11-04T12:00:00Z" }];
  renderListener();
  assert.equal(get("fta-messages-heading").textContent, "消息");
  assert.equal(get("fta-pref-message-count"), null);
  assert.equal(get("fta-pref-message-list").querySelector("script"), null);
  get("fta-pref-message-list").querySelector("button").click(); await flush();
  get("fta-pref-refresh-messages").click(); await flush();
  assert.match(get("fta-pref-messages-refreshed").textContent, /最近刷新/);
  assert.equal(get("fta-pref-messages-refreshed").parentElement, get("fta-pref-refresh-messages").parentElement, "the refresh timestamp stays next to its action");
  assert.equal(get("fta-pref-messages-state").hidden, true, "a successful refresh does not duplicate its timestamp below the heading");
  const refreshedText = get("fta-pref-messages-refreshed").textContent;
  model.messagesStatus = { state: "error", message: "暂时无法读取消息", lastCheckedAt: "2026-11-04T13:00:00Z" };
  renderListener();
  assert.equal(get("fta-pref-messages-refreshed").textContent, refreshedText, "a refresh error retains the previous successful timestamp");
  assert.equal(get("fta-pref-messages-state").hidden, false);
  assert.equal(get("fta-pref-messages-state").dataset.error, "true");
  assert.match(get("fta-pref-messages-state").textContent, /暂时无法读取消息/);
  const assistTaskBase = { state: "imported", source: "ablesci", itemID: 800, attachmentID: 801, requestID: "ReceiptFixture", requestURL: "https://www.ablesci.com/assist/detail?id=ReceiptFixture", doi: "10.1234/receipt", requestedPoints: 10 };
  model.tasks = [
    { ...assistTaskBase, id: "receipt-pending", title: "全文已入库，待采纳", lastError: "旧下载错误不应再显示", assistReceipt: { adoption: "pending", messages: "pending", needsReconcile: false, lastError: "采纳暂时失败 <img src=x onerror=bad>", nextCheckAt: "2026-11-05T14:00:00Z" } },
    { ...assistTaskBase, id: "receipt-read", title: "等待对应消息已读", assistReceipt: { adoption: "accepted", messages: "pending", needsReconcile: false, lastError: "" } },
    { ...assistTaskBase, id: "receipt-unknown", title: "提交结果待核实", assistReceipt: { adoption: "pending", messages: "pending", needsReconcile: true, lastError: "请先核实网站状态" } },
    { ...assistTaskBase, id: "receipt-done", title: "已完成收尾", assistReceipt: { adoption: "accepted", messages: "done", needsReconcile: false, lastError: "" } },
    { ...assistTaskBase, id: "receipt-legacy", title: "旧版已获取历史", assistReceipt: null }
  ];
  filterButton("unfinished").click(); renderListener();
  assert.equal(get("fta-pref-task-list").children.length, 3, "downloaded files with pending completion stay in unfinished");
  assert.equal(badgeText("receipt-pending"), "已获取 · 待采纳");
  assert.equal(badgeText("receipt-read"), "已采纳 · 待已读");
  assert.equal(badgeText("receipt-unknown"), "已获取 · 采纳待核实");
  assert.equal(taskRow("receipt-pending").querySelector(".fta-status-badge").dataset.tone, "warning");
  assert.match(taskRow("receipt-pending").textContent, /采纳暂时失败 <img src=x onerror=bad>/);
  assert.doesNotMatch(taskRow("receipt-pending").textContent, /旧下载错误/);
  assert.equal(taskRow("receipt-pending").querySelector("img"), null);
  assert.deepEqual(labels("receipt-pending"), ["打开全文", "查看已有求助", "重试采纳与已读"]);
  assert.deepEqual(labels("receipt-unknown"), ["打开全文", "查看已有求助", "核实采纳状态"]);
  assert.equal(get("fta-pref-bulk-actions").hidden, true, "completion retries cannot create a new paid request");
  const receiptButton = (id, label) => [...taskRow(id).querySelectorAll("button")].find(button => button.textContent === label);
  receiptButton("receipt-pending", "打开全文").click(); await flush();
  assert.deepEqual(calls.at(-1), ["openTask", "receipt-pending"]);
  receiptButton("receipt-pending", "查看已有求助").click(); await flush();
  assert.deepEqual(calls.at(-1), ["open", "receipt-pending"]);
  receiptButton("receipt-pending", "重试采纳与已读").click(); await flush();
  assert.deepEqual(calls.at(-1), ["assistCompletion", "receipt-pending"]);
  receiptButton("receipt-unknown", "核实采纳状态").click(); await flush();
  assert.deepEqual(calls.at(-1), ["assistCompletion", "receipt-unknown"]);
  filterButton("success").click();
  assert.equal(get("fta-pref-task-list").children.length, 5, "all acquired PDFs remain accessible in completed history");
  assert.equal(badgeText("receipt-pending"), "已获取 · 待采纳");
  assert.equal(badgeText("receipt-done"), "已采纳 · 对应消息已读");
  assert.equal(badgeText("receipt-legacy"), "已获取", "legacy history never claims adoption without a receipt");
  assert.equal(labels("receipt-done").includes("重试采纳与已读"), false);
  assert.equal(labels("receipt-legacy").includes("重试采纳与已读"), false);
  const legacyVerify = receiptButton("receipt-legacy", "核验并补采纳");
  assert.ok(legacyVerify, "legacy acquired assistance history offers explicit provenance verification");
  assert.equal(legacyVerify.disabled, false);
  const beforeLegacyVerify = calls.length;
  legacyVerify.click(); await flush();
  assert.deepEqual(calls.slice(beforeLegacyVerify), [["verifyAssistCompletion", "receipt-legacy"]], "legacy verification does not invoke download or a new assistance request");
  assert.match(get("fta-pref-status").textContent, /原文件核验结果已更新/);
  model.tasks[0].assistReceipt = { adoption: "accepted", messages: "done", needsReconcile: false, lastError: "" };
  filterButton("unfinished").click(); renderListener();
  assert.equal(taskRow("receipt-pending"), null, "finished receipt leaves unfinished while the PDF remains in history");
  model.tasks = [{ ...assistTaskBase, id: "assist-review", state: "manual_review", attachmentID: null, title: "<i>待核对文献</i>", pendingFilename: "应助文件.pdf", pendingTitle: "<i>待核对文献</i>", pendingSummary: "身份尚不明确", assistReview: { fileID: "FileFixture", createdAt: "2026-11-05T13:00:00Z" }, assistReceipt: null }];
  renderListener();
  assert.ok(labels("assist-review").includes("确认对应论文并入库、采纳"));
  assert.equal(labels("assist-review").includes("我已核对，是这篇论文"), false);
  assert.match(taskRow("assist-review").textContent, /结算该求助的原悬赏（10 积分）/);
  assert.match(taskRow("assist-review").textContent, /只将对应上传消息标记已读/);
  const beforeReviewConfirm = calls.filter(call => call[0] === "confirmPDF").length;
  rowButton("预览待核对 PDF").click(); await flush();
  assert.equal(calls.filter(call => call[0] === "confirmPDF").length, beforeReviewConfirm, "previewing an assistance file does not adopt it");
  rowButton("确认对应论文并入库、采纳").click(); await flush();
  assert.deepEqual(calls.at(-1), ["confirmPDF", "assist-review"]);
  model.tasks = [
    { id: "bind-1", title: "明确选择的文献", doi: "10.1234/bind", itemID: 10, state: "not_found" },
    { id: "bind-2", title: "批量最后一篇", doi: "10.1234/other", itemID: 11, state: "not_found" },
    { id: "bind-remote", title: "已关联求助", itemID: 12, requestID: "Bound", state: "waiting" },
    { id: "bind-tracking", title: "仅跟踪的求助", state: "waiting" }
  ];
  model.selectedTaskId = "bind-2";
  renderListener();
  const targetSelect = get("fta-pref-request-target");
  assert.equal(targetSelect.querySelectorAll("option").length, 3, "only unbound library tasks can be chosen");
  assert.equal(targetSelect.value, "", "existing request tracking never implicitly binds the most recent batch item");
  input("fta-pref-request-url", "https://www.ablesci.com/assist/detail?id=EXAMPLE"); submit("fta-pref-add-form"); await flush();
  assert.deepEqual(calls.at(-1), ["add", "https://www.ablesci.com/assist/detail?id=EXAMPLE", null]);
  assert.match(get("fta-pref-status").textContent, /未关联文献/);
  chooseTarget("bind-1");
  pageTab("account").click(); pageTab("tasks").click();
  renderListener();
  assert.equal(targetSelect.value, "bind-1", "explicit target survives an unrelated snapshot refresh");
  input("fta-pref-request-url", "https://www.ablesci.com/assist/detail?id=EXPLICIT"); submit("fta-pref-add-form"); await flush();
  assert.deepEqual(calls.at(-1), ["add", "https://www.ablesci.com/assist/detail?id=EXPLICIT", "bind-1"]);
  assert.equal(targetSelect.value, "", "a successful link resets the next request to tracking only");
  chooseTarget("bind-1");
  model.tasks[0].requestID = "LinkedElsewhere";
  renderListener();
  assert.equal(targetSelect.value, "", "an unavailable target is cleared, never replaced with another library item");
  get("fta-pref-web-login").click(); await flush();
  get("fta-pref-logout").click(); await flush();
  assert.equal(get("fta-pref-account-state").textContent, "未登录");
  assert.equal(get("fta-pref-account-identity").hidden, true);
  for (const method of ["check", "open", "openTask", "assist", "download", "pause", "retry", "assistCompletion", "message", "messages", "add", "web", "logout", "bindingCandidates", "bind", "systemBrowser", "localPDF", "previewPDF", "confirmPDF", "dismissPDF"]) assert.ok(calls.some(c => c[0] === method), method);
  const ids = [...root.querySelectorAll("[id]")].map(node => node.id);
  assert.equal(ids.length, new Set(ids).size);
  model.tasks = Array.from({ length: 8 }, (_, index) => ({ id: "all-done-" + index, state: "imported", attachmentID: 1000 + index, title: "已获取文献 " + index }));
  filterButton("unfinished").click(); renderListener();
  assert.equal(get("fta-pref-task-empty").hidden, false);
  assert.match(get("fta-pref-task-empty").textContent, /当前没有未完成任务/);
  assert.equal(get("fta-pref-task-list").hidden, true);
  assert.equal(get("fta-pref-bulk-actions").hidden, true);
  assert.equal(get("fta-pref-bulk-note").hidden, true);
  filterButton("success").click();
  assert.equal(get("fta-pref-task-list").hidden, false);
  assert.equal(get("fta-pref-task-list").children.length, 8);
  assert.equal(get("fta-pref-bulk-actions").hidden, true);
  assert.equal(get("fta-pref-bulk-note").hidden, true, "completed history keeps the paid-selection toolbar collapsed");
  // Batch categories are exclusive and never absorb old tasks. Global unfinished
  // and completed history remain available even before any batch was recorded.
  assert.deepEqual([...get("fta-pref-task-filters").querySelectorAll("button")].map(node => node.dataset.filter), ["active", "login", "fallback", "success", "unfinished", "all"]);
  model.tasks = [
    { id: "scope-old-wait", state: "waiting", requestID: "OldRequest" },
    { id: "scope-old-done", state: "imported", attachmentID: 201, completedAt: "2026-11-01T08:00:00Z" },
    { id: "scope-queued", state: "queued", title: "Queued article" },
    { id: "scope-login", state: "needs_login", itemID: 101, doi: "10.1234/login" },
    { id: "scope-fallback", state: "not_found", itemID: 102, doi: "10.1234/fallback" },
    { id: "scope-browser", state: "manual_waiting", itemID: 103, doi: "10.1234/browser" },
    { id: "scope-done", state: "imported", attachmentID: 202, completedAt: "2026-11-05T08:00:00Z" },
    { id: "scope-old-receipt", state: "imported", attachmentID: 203, completedAt: "2026-11-03T08:00:00Z", assistReceipt: { adoption: "pending", messages: "pending" } }
  ];
  model.currentBatch = { id: "scope-batch", createdAt: "2026-11-05T08:00:00Z", taskIDs: ["scope-queued", "scope-login", "scope-fallback", "scope-browser", "scope-done"], summary: { id: "persisted-batch", at: "2026-11-05T08:00:00Z", message: "本次选择已处理，结果见任务列表。" } };
  filterButton("unfinished").click();renderListener();
  assert.equal(get("fta-pref-task-list").children.length, 6);
  assert.ok(taskRow("scope-old-wait"));assert.ok(taskRow("scope-old-receipt"));
  assert.match(get("fta-pref-task-scope").textContent, /跨批次保留所有未完成/);
  assert.equal(filterButton("active").textContent, "进行中 2");
  assert.equal(filterButton("login").textContent, "需网页登录 1");
  assert.equal(filterButton("fallback").textContent, "待兜底 1");
  assert.equal(filterButton("success").textContent, "已获取 1");
  assert.equal(filterButton("unfinished").textContent, "未完成 6");
  assert.equal(filterButton("all").textContent, "全部历史 3");
  filterButton("active").click();
  assert.deepEqual([...get("fta-pref-task-list").children].map(node => node.dataset.taskId), ["scope-queued", "scope-browser"]);
  assert.equal(get("fta-pref-task-count").textContent, "5");
  assert.match(get("fta-pref-task-scope").textContent, /仅统计最近一次/);
  assert.equal(labels("scope-browser").some(label => label.startsWith("科研通求助")), true, "browser wait remains eligible for an explicit fallback despite its active category");
  filterButton("login").click();
  assert.equal(labels("scope-login").some(label => label.startsWith("科研通求助")), true, "login category retains an explicit fallback action");
  filterButton("all").click();
  assert.deepEqual([...get("fta-pref-task-list").children].map(node => node.dataset.taskId), ["scope-done", "scope-old-receipt", "scope-old-done"]);
  assert.match(get("fta-pref-task-scope").textContent, /按完成时间从新到旧/);
  model.currentBatch = null;renderListener();filterButton("active").click();
  assert.equal(get("fta-pref-task-list").children.length, 0);
  assert.equal(filterButton("active").textContent, "进行中 0");
  assert.match(get("fta-pref-task-scope").textContent, /尚未记录当前批次/);
  filterButton("unfinished").click();assert.equal(get("fta-pref-task-list").children.length, 6);
  filterButton("all").click();assert.equal(get("fta-pref-task-list").children.length, 3);

  // Download diagnostics cannot implicitly import or confirm a candidate.
  app.recheckDownloadedPDFs = async id => { calls.push(["recheckPDFs", id]); };
  app.reviewDownloadCandidate = async (id, candidate) => { calls.push(["reviewCandidate", id, candidate]); };
  model.tasks = [{ id: "diagnostic", state: "manual_waiting", itemID: 301, title: "下载设置", doi: "10.1234/diagnostic", acquisitionMode: "manual",
    downloadStatus: { scanned: 4, unknown: 1, mismatched: 2, lastScanAt: "2026-11-05T08:30:00Z" },
    downloadCandidates: [{ id: "candidate-one", filename: "<img src=x onerror=bad>.pdf", message: "无法自动确认所选 PDF 的论文身份。请先预览并核对标题、作者和 DOI，再明确确认。" }],
    accessEvidence: { kind: "institutional_entry", confidence: "explicit" }, accessHint: { scope: "host_hint", kind: "institutional_confirmed", institutionalConfirmed: false }
  }];
  model.currentBatch = { id: "diagnostic-batch", createdAt: "2026-11-05T08:00:00Z", taskIDs: ["diagnostic"] };
  filterButton("unfinished").click();renderListener();
  const diagnostic = taskRow("diagnostic").querySelector(".fta-download-details");
  assert.equal(diagnostic.hasAttribute("open"), false, "download diagnostics start collapsed");
  assert.match(diagnostic.textContent, /已检查 4 个 PDF；身份待核对 1 个，不匹配 2 个/);
  assert.equal(diagnostic.querySelector("img"), null);
  assert.match(taskRow("diagnostic").textContent, /不代表当前账号拥有此论文权限/);
  assert.match(taskRow("diagnostic").textContent, /仅供参考/);
  assert.doesNotMatch(taskRow("diagnostic").textContent, /此论文已确认机构访问/);
  diagnostic.setAttribute("open", "");
  renderListener();
  assert.equal(taskRow("diagnostic").querySelector(".fta-download-details").hasAttribute("open"), true, "an immediate polling refresh preserves the user's expanded diagnostic before toggle dispatch");
  model.tasks.push({ id: "diagnostic-other", state: "manual_waiting", itemID: 302, title: "Another download", downloadStatus: { scanned: 0 } });
  renderListener();
  assert.equal(taskRow("diagnostic-other").querySelector(".fta-download-details").hasAttribute("open"), false, "expansion belongs only to the selected task");
  filterButton("all").click();filterButton("unfinished").click();
  assert.equal(taskRow("diagnostic").querySelector(".fta-download-details").hasAttribute("open"), true, "filtering away and back preserves the expanded task");
  taskRow("diagnostic").querySelector(".fta-download-details").removeAttribute("open");
  renderListener();
  assert.equal(taskRow("diagnostic").querySelector(".fta-download-details").hasAttribute("open"), false, "an explicitly collapsed diagnostic stays collapsed after refresh");
  taskRow("diagnostic").querySelector(".fta-download-details").setAttribute("open", "");
  model.tasks.pop();renderListener();
  const beforeDiagnostic = calls.length;
  rowButton("检查已下载文件").click();await flush();
  assert.equal(taskRow("diagnostic").querySelector(".fta-download-details").hasAttribute("open"), true, "a check action also preserves expanded candidates");
  rowButton("预览并核对").click();await flush();
  assert.deepEqual(calls.slice(beforeDiagnostic), [["recheckPDFs", "diagnostic"], ["reviewCandidate", "diagnostic", "candidate-one"]]);
  assert.equal(model.tasks[0].state, "manual_waiting");
  assert.equal(taskRow("diagnostic").querySelector(".fta-download-details").hasAttribute("open"), true, "preview refresh does not hide the candidate or imply confirmation");

  // Language is saved on its own, while drafts, task filter, selection and raw
  // article/site text survive immediately switching among all three locales.
  model.session = { status: "signed_out", username: "saved@example.invalid", message: "", hasSavedPassword: false };
  model.messages = [{ id: "raw-message", title: "下载设置", summary: "科研通账号" }];
  model.messagesStatus = { state: "loaded" };
  input("fta-pref-points", "37");input("fta-pref-poll", "125");
  input("fta-pref-username", "draft@example.invalid");input("fta-pref-password", "do-not-save-this-draft");
  get("fta-pref-request-url").value = "https://www.ablesci.com/assist/detail?id=DraftOnly";
  chooseTarget("diagnostic");changeChecked(taskCheckbox("diagnostic"), true);
  const savedPointsBeforeLanguage = model.settings.points;
  const chooseLanguage = async language => {
    const select = get("fta-pref-language");
    for (const option of select.querySelectorAll("option")) option.removeAttribute("selected");
    select.querySelector('option[value="' + language + '"]').setAttribute("selected", "selected");
    select.dispatchEvent(new window.Event("change"));await flush();
  };
  const beforeLanguage = calls.length;await chooseLanguage("en");
  assert.deepEqual(calls.slice(beforeLanguage), [["save", { language: "en" }]]);
  assert.equal(model.settings.points, savedPointsBeforeLanguage);
  assert.equal(get("fta-pref-points").value, "37");assert.equal(get("fta-pref-poll").value, "125");
  assert.equal(get("fta-pref-username").value, "draft@example.invalid");assert.equal(get("fta-pref-password").value, "do-not-save-this-draft");
  assert.equal(get("fta-pref-request-url").value, "https://www.ablesci.com/assist/detail?id=DraftOnly");
  assert.equal(get("fta-pref-request-target").value, "diagnostic");assert.equal(taskCheckbox("diagnostic").checked, true);
  assert.equal(filterButton("unfinished").getAttribute("aria-pressed"), "true");
  assert.equal(pageTab("settings").textContent, "Download settings");
  assert.equal(filterButton("active").textContent, "In progress 1");
  assert.match(get("fta-pref-task-scope").textContent, /All unfinished tasks across batches/);
  assert.match(get("fta-pref-bulk-assist").textContent, /37 points each/);
  assert.equal(taskRow("diagnostic").querySelector(".fta-row-title button span").textContent, "下载设置", "article title matching a UI key must never be translated");
  assert.equal(get("fta-pref-message-list").querySelector(".fta-row-title").textContent, "下载设置");
  assert.equal(get("fta-pref-message-list").querySelector(".fta-message-summary").textContent, "科研通账号");
  assert.equal(taskRow("diagnostic").querySelector(".fta-candidate-name").textContent, "<img src=x onerror=bad>.pdf");
  assert.match(taskRow("diagnostic").textContent, /Checked 4 PDFs: 1 need identity review, 2 do not match/);
  assert.match(taskRow("diagnostic").textContent, /does not confirm that the current account/);
  const untranslatedUI = [];
  (function inspect(node) {
    if (node.nodeType === 3) { if (/[\u4e00-\u9fff]/.test(node.nodeValue || "")) untranslatedUI.push(node.nodeValue.trim());return; }
    if (node.getAttribute?.("data-i18n-skip") === "true" || ["style", "script"].includes(node.localName)) return;
    for (const child of node.childNodes || []) inspect(child);
  })(root);
  assert.deepEqual(untranslatedUI, [], "all plugin UI text is translated; source metadata is explicitly excluded");
  await chooseLanguage("zh-TW");
  assert.equal(pageTab("settings").textContent, "下載設定");
  assert.equal(get("fta-pref-account-state").textContent, "未登入");
  assert.equal(get("fta-pref-password").value, "do-not-save-this-draft");
  assert.equal(taskRow("diagnostic").querySelector(".fta-row-title button span").textContent, "下载设置");
  await chooseLanguage("zh-CN");
  assert.equal(pageTab("settings").textContent, "下载设置");
  assert.match(get("fta-pref-bulk-assist").textContent, /每篇 37 积分/);
  await chooseLanguage("en");
  model.tasks[0].title = "S <i>olenopsis</i> and <b>other</b>";renderListener();
  const copyTitle = taskRow("diagnostic").querySelector(".fta-row-title button");
  assert.equal(copyTitle.getAttribute("aria-label"), "Copy title");
  assert.equal(copyTitle.getAttribute("type"), "button");
  copyTitle.click();await flush();
  assert.deepEqual(calls.at(-1), ["copy", "S olenopsis and other"], "copy strips formatting but does not collapse real spaces");
  assert.equal(taskRow("diagnostic").querySelector(".fta-copy-hint").textContent, "Copied");
  await new Promise(resolve => setTimeout(resolve, 1900));
  assert.equal(taskRow("diagnostic").querySelector(".fta-copy-hint").textContent, "", "copy feedback expires without changing the item title");
  const copyDOI = taskRow("diagnostic").querySelector(".fta-doi-copy");copyDOI.click();await flush();
  assert.deepEqual(calls.at(-1), ["copy", "10.1234/diagnostic"]);
  app.copyText = async () => { throw new Error("复制失败，请重试。"); };
  copyDOI.click();await flush();assert.equal(get("fta-pref-status").textContent, "Copy failed. Try again.");
  assert.equal(get("fta-pref-status").dataset.error, "true");
  app.copyText = async value => { calls.push(["copy", value]); };
  await chooseLanguage("zh-CN");
  app.confirmInstitutionalAccess = async id => { calls.push(["confirmAccess", id]);model.tasks[0].accessHint = { scope: "article", kind: "institutional_confirmed", institutionalConfirmed: true };renderListener(); };
  app.forgetInstitutionalAccess = async id => { calls.push(["forgetAccess", id]);model.tasks[0].accessHint = { scope: "article", kind: "browser_success", institutionalConfirmed: false };renderListener(); };
  Object.assign(model.tasks[0], { state: "imported", source: "browser_download", attachmentID: 345, accessHint: { scope: "article", kind: "browser_success", institutionalConfirmed: false } });
  filterButton("success").click();renderListener();
  assert.match(taskRow("diagnostic").textContent, /尚未确认机构权限/);
  rowButton("这是通过机构获取").click();await flush();
  assert.deepEqual(calls.at(-1), ["confirmAccess", "diagnostic"]);
  assert.match(taskRow("diagnostic").textContent, /此论文已确认机构访问/);
  assert.equal(rowButton("这是通过机构获取"), undefined);
  rowButton("撤销机构确认").click();await flush();
  assert.deepEqual(calls.at(-1), ["forgetAccess", "diagnostic"]);
  assert.doesNotMatch(taskRow("diagnostic").textContent, /此论文已确认机构访问/);
  assert.ok(rowButton("这是通过机构获取"));
  for (const [zh, tw, en] of i18n.uiCatalog) {
    if (zh.includes("{")) continue;
    assert.equal(i18n.translate(zh, "en"), en);assert.equal(i18n.translate(zh, "zh-TW"), tw);
  }
  assert.equal(i18n.translate("已检查 9 个 PDF；身份待核对 2 个，不匹配 6 个。", "en"), "Checked 9 PDFs: 2 need identity review, 6 do not match.");
  assert.equal(i18n.translate("按 25 积分重试", "en"), "Retry with 25 points");
  assert.equal(i18n.translate("来源：出版社网页", "en"), "Source: Publisher page");
  assert.equal(i18n.translate("Unknown <img onerror=x> 论文", "en"), "Unknown <img onerror=x> 论文");
  pageTab("messages").click();
  context.FulltextPreferences.destroy();
  assert.equal(subscriptions, 0);
  pageTab("settings").click();
  assert.equal(root.dataset.activePage, "messages", "destroy removes page navigation handlers");
  const publisher = await publisherControls();
  assert.equal(publisher.get("publisher-external"), null);
  assert.equal(publisher.get("publisher-system").textContent, "浏览器下载并自动入库");
  assert.match(publisher.get("publisher-status").textContent, /浏览器下载并自动入库/);
  publisher.get("publisher-system").click(); await flush();
  assert.deepEqual(publisher.calls, [["systemBrowser", "publisher-task"]]);
  assert.match(publisher.get("publisher-status").textContent, /请自行完成验证、点击 PDF 下载/);
  assert.match(publisher.get("publisher-status").textContent, /明确匹配的新 PDF 会自动入库/);
  publisher.app.openSystemBrowserTask = async () => ({ opened: true, watching: false });
  publisher.get("publisher-system").click(); await flush();
  assert.match(publisher.get("publisher-status").textContent, /下载文件夹检查尚未启动/);
  publisher.app.openSystemBrowserTask = async () => ({ opened: false, alreadyImported: true });
  publisher.get("publisher-system").click(); await flush();
  assert.match(publisher.get("publisher-status").textContent, /已保存到原文献，无需再次下载/);
  assert.equal(publisher.calls.some(call => call[0] === "localPDF"), false);
  publisher.app.openSystemBrowserTask = async () => { throw new Error("默认浏览器调用失败。"); };
  publisher.get("publisher-system").click(); await flush();
  assert.equal(publisher.get("publisher-status").textContent, "默认浏览器调用失败。");
  assert.equal(publisher.get("publisher-system").disabled, false);
  publisher.app.importLocalPDF = async id => { publisher.calls.push(["localPDF", id]); return { needsReview: true }; };
  publisher.get("publisher-import").click(); await flush();
  assert.match(publisher.get("publisher-status").textContent, /需要核对/);
  assert.doesNotMatch(publisher.get("publisher-status").textContent, /已导入/);
  publisher.close();
  const noTask = await publisherControls(null);
  assert.equal(noTask.get("publisher-external"), null);
  assert.equal(noTask.get("publisher-system").textContent, "在默认浏览器打开");
  noTask.get("publisher-system").click(); await flush();
  assert.deepEqual(noTask.calls, [["launchURL", "https://publisher.example/article"]]);
  assert.match(noTask.get("publisher-status").textContent, /此页面未关联文献/);
  assert.doesNotMatch(noTask.get("publisher-status").textContent, /接管|自动入库|检查/);
  assert.equal(noTask.get("publisher-import").disabled, true);
  noTask.close();
  const unsupported = await publisherControls("publisher-task", { openSystemBrowserTask: undefined });
  assert.equal(unsupported.get("publisher-system").disabled, true);
  unsupported.close();
  const localizedPublisher = await publisherControls();
  assert.equal(localizedPublisher.languageSubscriptions(), 1);
  localizedPublisher.setLanguage("en");await flush();
  assert.equal(localizedPublisher.document.documentElement.getAttribute("lang"), "en", "publisher localization targets its own document");
  assert.equal(localizedPublisher.document.documentElement.contains(localizedPublisher.get("publisher-system")), true, "test browser chrome is inside its document element");
  assert.equal(localizedPublisher.get("publisher-system").textContent, "Download in browser and auto-import");
  assert.match(localizedPublisher.get("publisher-status").textContent, /website requires human verification/);
  localizedPublisher.get("publisher-system").click();await flush();
  assert.match(localizedPublisher.get("publisher-status").textContent, /folder checks started/);
  localizedPublisher.browser.contentTitle = "下载设置";localizedPublisher.browser.dispatchEvent(new window.Event("pagetitlechanged"));await flush();
  assert.equal(localizedPublisher.get("publisher-tabs").querySelector(".publisher-tab-title").textContent, "下载设置", "real website titles are preserved in localized browser chrome");
  localizedPublisher.setLanguage("zh-TW");await flush();
  assert.equal(localizedPublisher.get("publisher-retry").textContent, "完成登入並重試此文獻");
  localizedPublisher.setLanguage("zh-CN");await flush();
  assert.equal(localizedPublisher.get("publisher-system").textContent, "浏览器下载并自动入库");
  localizedPublisher.close();assert.equal(localizedPublisher.languageSubscriptions(), 0);
  const localizedSite = await siteControls();
  assert.equal(localizedSite.languageSubscriptions(), 1);
  localizedSite.setLanguage("en");await flush();
  assert.equal(localizedSite.get("ft-read").textContent, "Refresh task status");
  assert.match(localizedSite.get("ft-status").textContent, /Complete login or CAPTCHA/);
  localizedSite.get("ft-read").click();await flush();
  assert.match(localizedSite.get("ft-status").textContent, /Task status updated/);
  localizedSite.setLanguage("zh-TW");await flush();
  assert.equal(localizedSite.get("ft-read").textContent, "刷新任務狀態");
  localizedSite.close();assert.equal(localizedSite.languageSubscriptions(), 0);assert.equal(localizedSite.detached(), true);
  console.log("Preferences tests passed: batch scopes and exclusive filters, completed history, three-language UI and browser chrome, preserved drafts and metadata, title/DOI copy, download diagnosis and explicit review, institutional confirmation/undo, existing task workflows and cleanup.");
})().catch(error => { console.error(error); process.exitCode = 1; });
