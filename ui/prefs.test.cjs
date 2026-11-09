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
assert.equal(i18n.translate("CORE 本机每日下载上限须为 1 至 1000 的整数。", "en"), "The local daily CORE download limit must be an integer from 1 to 1000.");
assert.equal(i18n.translate("CORE 本机每日下载上限须为 1 至 1000 的整数。", "zh-TW"), "CORE 本機每日下載上限須為 1 至 1000 的整數。");
new vm.Script(script);
const { document, window } = parseHTML("<html><body><div id='preference-container'></div></body></html>");
let renderListener;
let subscriptions = 0;
let preferencesOpenedCalls = 0;
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
  preferencesOpened: async () => { preferencesOpenedCalls++; },
  refreshCheckIn: async options => { calls.push(["refreshCheckIn", { ...options }]);renderListener();return { ...model.checkIn }; },
  openCheckIn: async () => { calls.push(["openCheckIn"]); },
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
  openSubmissionReview: async id => calls.push(["openSubmissionReview", id]),
  inspectDOI: async id => {
    calls.push(["inspectDOI", id]);const task = model.tasks.find(task => task.id === id);
    task.doiCheck = { expectedDOI: task.doi, receivedDOI: task.doi, expectedTitle: task.title, receivedTitle: "<img src=x onerror=bad> 网站标题", reason: "match", checkedAt: "2026-11-06T09:00:00Z" };
    renderListener();return { ...task.doiCheck };
  },
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
async function siteControls(mode = "request") {
  const markup = fs.readFileSync(path.join(__dirname, "browser.xhtml"), "utf8").replace(/html:/g, "").replace(/<script([^>]*?)\s*\/>/g, "<script$1></script>");
  const { document, window } = parseHTML("<html><body>" + markup + "</body></html>");
  const handlers = {}, listeners = new Set();let language = "zh-CN", detached = false;
  const app = { localize: root => i18n.apply(root, language), subscribe: listener => { listeners.add(listener);return () => listeners.delete(listener); },
    attachBrowser: async () => ({ currentURI: { spec: "https://www.ablesci.com/assist/detail?id=LocalOnly" } }), detachBrowser: () => { detached = true; }, inspectActivePage: async () => {} };
  const chromeWindow = { document, MutationObserver: window.MutationObserver,
    arguments: [{ wrappedJSObject: { app, url: "https://www.ablesci.com/assist/detail?id=LocalOnly", mode } }],
    addEventListener(type, callback) { handlers[type] = callback; }, setInterval: () => 1, clearInterval() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "browser.js"), "utf8"), { window: chromeWindow, document, Date });
  await handlers.load();await flush();
  return { get: id => document.getElementById(id), setLanguage(value) { language = value;for (const listener of listeners) listener(); }, close: () => handlers.unload(), detached: () => detached, languageSubscriptions: () => listeners.size };
}
(async () => {
  await flush();assert.equal(preferencesOpenedCalls, 1, "duplicate mounts perform the opening check only once");
  assert.equal(root.dataset.activePage, "tasks");
  assert.equal(get("fta-pref-tabs").getAttribute("role"), "tablist");
  assert.equal(get("fta-pref-tabs").getAttribute("aria-orientation"), "horizontal");
  const pages = ["tasks", "settings", "account", "messages"];
  assert.deepEqual([...get("fta-pref-tabs").querySelectorAll("button")].map(node => node.textContent), ["任务", "设置", "科研通设置", "消息"]);
  for (const id of ["fta-pref-language", "fta-pref-download-directories", "fta-pref-publisher-session"]) assert.ok(pagePanel("settings").contains(get(id)), id + " belongs in general settings");
  for (const id of ["fta-pref-account-form", "fta-pref-points", "fta-pref-poll", "fta-pref-site-minimum", "fta-pref-auto-download", "fta-pref-save-settings"]) assert.ok(pagePanel("account").contains(get(id)), id + " belongs in AbleSci settings");
  assert.equal(get("fta-pref-site-minimum").checked, false, "minimum-reward opt-in defaults to off for old settings");
  assert.equal(get("fta-pref-checkin-reminder").checked, true, "scheduled status checks default to enabled");
  assert.ok(pagePanel("account").contains(get("fta-pref-checkin-state")));
  assert.match(get("fta-pref-checkin-note").textContent, /运行时每天 6:00 检查/);
  assert.match(get("fta-pref-checkin-note").textContent, /签到请在官方网页自行完成/);
  assert.equal(get("fta-pref-site-minimum").getAttribute("aria-describedby"), "fta-pref-site-minimum-note");
  assert.match(get("fta-pref-site-minimum-note").textContent, /实际积分可能更高/);
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
  // Balance and check-in are read-only account status, independent of local
  // spending. Old dates or unverified credit must not be presented as today.
  const checkInDay = date => date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
  const todayDate = new Date(), priorDate = new Date();priorDate.setDate(priorDate.getDate() - 1);
  const todayDay = checkInDay(todayDate), yesterdayDay = checkInDay(priorDate);
  const sessionBeforeCheckIn = { ...model.session };
  model.session.status = "authenticated";
  model.checkIn = { state: "loaded", day: todayDay, signed: false, balance: 120, reward: null, rewardVerified: false, checkedAt: todayDate.toISOString(), message: "" };renderListener();
  assert.equal(get("fta-pref-checkin-balance").textContent, "120 积分");
  assert.equal(get("fta-pref-checkin-state").textContent, "今日未签到");
  assert.equal(get("fta-pref-checkin-reward").textContent, "—");
  for (const state of ["loaded", "error"]) {
    model.checkIn.state = state;model.checkIn.signed = null;renderListener();
    assert.equal(get("fta-pref-checkin-state").textContent, "今日状态待核实", "a completed lookup without positive evidence is unverified, not unqueried");
    assert.equal(get("fta-pref-checkin-reward").textContent, "—");
  }
  model.checkIn.state = "loaded";model.checkIn.signed = false;renderListener();
  const spendTotalBeforeCheckIn = get("fta-pref-spending-total").textContent;
  const beforeCheckInActions = calls.length;
  get("fta-pref-checkin-open").click();await flush();
  assert.equal(model.checkIn.signed, false, "opening the website never implies successful check-in");
  get("fta-pref-checkin-refresh").click();await flush();
  assert.deepEqual(calls.slice(beforeCheckInActions), [["openCheckIn"], ["refreshCheckIn", { force: true }]], "UI has no automatic check-in or reward-claim action");
  model.checkIn.signed = true;model.checkIn.reward = 5;renderListener();
  assert.equal(get("fta-pref-checkin-state").textContent, "今日已签到");
  assert.equal(get("fta-pref-checkin-reward").textContent, "到账待核实");
  assert.equal(get("fta-pref-checkin-open").textContent, "查看签到页面");
  model.checkIn.rewardVerified = true;renderListener();
  assert.equal(get("fta-pref-checkin-reward").textContent, "已到账 5 积分");
  assert.equal(get("fta-pref-spending-total").textContent, spendTotalBeforeCheckIn, "check-in income and current balance never enter spending totals");
  model.checkIn.day = yesterdayDay;renderListener();
  assert.equal(get("fta-pref-checkin-state").textContent, "今日状态待刷新");
  assert.equal(get("fta-pref-checkin-reward").textContent, "—");
  assert.equal(get("fta-pref-checkin-open").textContent, "去网页签到");
  assert.equal(get("fta-pref-checkin-balance").textContent, "120 积分", "a cached balance remains paired with its query timestamp");
  assert.match(get("fta-pref-checkin-refreshed").textContent, /最近查询/);
  model.checkIn.day = todayDay;model.checkIn.state = "idle";model.checkIn.signed = null;model.checkIn.checkedAt = priorDate.toISOString();renderListener();
  assert.equal(get("fta-pref-checkin-balance-label").textContent, "上次查询余额", "today's snapshot day cannot relabel yesterday's cached balance as current");
  model.checkIn.state = "checking";renderListener();
  assert.equal(get("fta-pref-checkin-balance-label").textContent, "上次查询余额", "a new check does not refresh a cached balance until it completes");
  model.checkIn.checkedAt = todayDate.toISOString();model.checkIn.signed = true;
  model.checkIn.state = "checking";renderListener();
  assert.equal(get("fta-pref-checkin-refresh").disabled, true);
  assert.equal(get("fta-pref-checkin-state").textContent, "正在查询…");
  model.checkIn.state = "error";model.checkIn.message = "签到状态暂时无法核实，请打开科研通网页查看。";renderListener();
  assert.equal(get("fta-pref-checkin-message").dataset.error, "true");
  assert.equal(get("fta-pref-checkin-balance-label").textContent, "上次查询余额");
  model.checkIn.day = todayDay;model.checkIn.state = "loaded";model.checkIn.message = "";
  model.settings.language = "en";renderListener();
  assert.equal(get("fta-pref-checkin-state").textContent, "Checked in today");
  assert.equal(get("fta-pref-checkin-reward").textContent, "5 points credited");
  model.settings.language = "zh-TW";renderListener();assert.equal(get("fta-pref-checkin-state").textContent, "今日已簽到");
  model.settings.language = "zh-CN";
  model.session.status = "signed_out";renderListener();
  assert.equal(get("fta-pref-checkin-balance").textContent, "—");
  assert.equal(get("fta-pref-checkin-reward").textContent, "—");
  assert.equal(get("fta-pref-checkin-state").textContent, "登录后查询", "sign-out hides former account values even before the next check");
  assert.equal(get("fta-pref-checkin-refresh").disabled, true, "signed-out refresh cannot imply that a query occurred");
  const beforeSignedOutRefresh = calls.length;get("fta-pref-checkin-refresh").click();await flush();assert.equal(calls.length, beforeSignedOutRefresh);
  model.session = sessionBeforeCheckIn;delete model.checkIn;renderListener();
  assert.equal(preferencesOpenedCalls, 1, "polling and tab navigation do not repeat the mount check");
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
  assert.equal(pageTab("account").dataset.dirty, "true");
  assert.match(pageTab("account").getAttribute("aria-label"), /未保存/);
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
  assert.equal(pageTab("account").dataset.dirty, "false");
  assert.equal(model.settings.points, 25);
  assert.equal(model.settings.pollSeconds, 120);
  assert.equal(model.settings.autoDownload, false);
  assert.equal(model.settings.checkInReminder, true);
  get("fta-pref-checkin-reminder").checked = false;get("fta-pref-checkin-reminder").dispatchEvent(new window.Event("input"));
  pageTab("tasks").click();pageTab("account").click();renderListener();
  assert.equal(get("fta-pref-checkin-reminder").checked, false, "reminder draft survives navigation and polling");
  assert.equal(model.settings.checkInReminder, true, "draft reminder changes have no immediate scheduling effect");
  submit("fta-pref-settings-form");await flush();
  assert.equal(model.settings.checkInReminder, false);
  assert.equal(model.settings.acceptSiteMinimum, false);
  get("fta-pref-site-minimum").checked = true;
  get("fta-pref-site-minimum").dispatchEvent(new window.Event("input"));
  pageTab("messages").click(); pageTab("settings").click(); renderListener();
  assert.equal(get("fta-pref-site-minimum").checked, true, "minimum-reward draft survives updates and navigation");
  assert.equal(model.settings.acceptSiteMinimum, false, "typing a cost policy does not silently activate it");
  assert.equal(pageTab("account").dataset.dirty, "true", "unsaved AbleSci changes are marked on the AbleSci tab");
  submit("fta-pref-settings-form"); await flush();
  assert.equal(model.settings.acceptSiteMinimum, true, "saving explicitly enables automatic minimum reward");
  get("fta-pref-site-minimum").checked = false;
  get("fta-pref-site-minimum").dispatchEvent(new window.Event("input"));
  submit("fta-pref-settings-form"); await flush();
  assert.equal(model.settings.acceptSiteMinimum, false);
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
  pageTab("tasks").click();
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
  assert.match(taskRow("route-normal").querySelector(".fta-row-meta").textContent, /来源：科研通 · 积分待核实 · 普通线路/);
  assert.match(taskRow("route-highspeed").querySelector(".fta-row-meta").textContent, /来源：科研通 · 积分待核实 · 免积分高速/);
  for (const id of ["route-old", "route-local", "route-unknown"]) assert.doesNotMatch(taskRow(id).querySelector(".fta-row-meta").textContent, /普通线路|免积分高速|__proto__|\[object Object\]/, "only recorded AbleSci routes are shown");
  filterButton("unfinished").click();
  model.tasks = [{ id: "route-running", title: "正在获取应助文件", itemID: 620, state: "downloading", requestID: "RouteReady", requestedPoints: 10, pointsVerified: true, downloadRoute: "highspeed" }];
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
  pageTab("messages").click();
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
  const assistTaskBase = { state: "imported", source: "ablesci", itemID: 800, attachmentID: 801, requestID: "ReceiptFixture", requestURL: "https://www.ablesci.com/assist/detail?id=ReceiptFixture", doi: "10.1234/receipt", requestedPoints: 10, pointsVerified: true };
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
  assert.match(taskRow("receipt-done").querySelector(".fta-row-meta").textContent, /来源：科研通 · 已支出 10 积分/);
  assert.match(taskRow("receipt-pending").querySelector(".fta-row-meta").textContent, /来源：科研通 · 悬赏 10 积分（待采纳）/);
  model.tasks.find(task => task.id === "receipt-done").pointsVerified = false; renderListener();
  assert.match(taskRow("receipt-done").querySelector(".fta-row-meta").textContent, /来源：科研通 · 积分待核实/);
  assert.doesNotMatch(taskRow("receipt-done").querySelector(".fta-row-meta").textContent, /已支出 10|悬赏 10/);
  assert.equal(labels("receipt-done").includes("重试采纳与已读"), false);
  assert.equal(labels("receipt-legacy").includes("重试采纳与已读"), false);
  const legacyVerify = receiptButton("receipt-legacy", "核验科研通文件");
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
  assert.ok(labels("assist-review").includes("检查已下载文件"), "linked requests retain a local-download check entry");
  assert.ok(labels("assist-review").includes("选择已下载的PDF"), "linked requests retain a manual import entry");
  const beforeReviewConfirm = calls.filter(call => call[0] === "confirmPDF").length;
  rowButton("预览待核对 PDF").click(); await flush();
  assert.equal(calls.filter(call => call[0] === "confirmPDF").length, beforeReviewConfirm, "previewing an assistance file does not adopt it");
  rowButton("确认对应论文并入库、采纳").click(); await flush();
  assert.deepEqual(calls.at(-1), ["confirmPDF", "assist-review"]);
  model.tasks = [{ ...assistTaskBase, id: "linked-local", source: "local_file", assistReceipt: null, accessHint: { scope: "article", kind: "browser_success", institutionalConfirmed: false }, title: "手动导入的应助文件" }];
  filterButton("all").click(); renderListener();
  assert.ok(labels("linked-local").includes("核验科研通文件"), "an existing request can be verified after manual import");
  assert.equal(labels("linked-local").includes("这是通过机构获取"), false, "a local file with an assistance request must not imply institutional retrieval");
  assert.doesNotMatch(taskRow("linked-local").textContent, /此论文曾通过浏览器获取/);
  assert.match(taskRow("linked-local").textContent, /网站文件与已保存 PDF 完全一致/);
  assert.match(taskRow("linked-local").querySelector(".fta-row-meta").textContent, /来源：本地 PDF/);
  assert.doesNotMatch(taskRow("linked-local").querySelector(".fta-row-meta").textContent, /已支出|待采纳/);
  receiptButton("linked-local", "核验科研通文件").click(); await flush();
  assert.deepEqual(calls.at(-1), ["verifyAssistCompletion", "linked-local"]);
  filterButton("unfinished").click();
  model.tasks = [{ id: "metadata-check", state: "error", itemID: 904, title: "Zotero 条目标题", doi: "10.1234/check", lastError: "旧的 DOI 查询错误" }];
  filterButton("unfinished").click();renderListener();
  assert.ok(labels("metadata-check").includes("核对网站文献信息"));
  const beforeMetadataCheck = calls.length;
  rowButton("核对网站文献信息").click();await flush();
  assert.deepEqual(calls.slice(beforeMetadataCheck), [["inspectDOI", "metadata-check"]], "metadata lookup does not save points, retry a task, or request assistance");
  assert.equal(model.tasks[0].state, "error", "metadata lookup does not imply publication or acquisition");
  let metadataDetails = taskRow("metadata-check").querySelector(".fta-doi-check");
  assert.equal(metadataDetails.hasAttribute("open"), true, "explicit metadata lookup reveals the comparison");
  assert.match(metadataDetails.textContent, /条目 DOI：10\.1234\/check/);
  assert.match(metadataDetails.textContent, /网站 DOI：10\.1234\/check/);
  assert.match(metadataDetails.textContent, /条目标题：Zotero 条目标题/);
  assert.match(metadataDetails.textContent, /网站标题：<img src=x onerror=bad> 网站标题/);
  assert.equal(metadataDetails.querySelector("img"), null, "website titles are displayed as text");
  assert.match(metadataDetails.textContent, /DOI 一致，请核对标题后重试/);
  assert.match(get("fta-pref-status").textContent, /未发布求助/);
  renderListener();assert.equal(taskRow("metadata-check").querySelector(".fta-doi-check").hasAttribute("open"), true, "polling preserves an expanded metadata comparison");
  taskRow("metadata-check").querySelector(".fta-doi-check").removeAttribute("open");renderListener();
  assert.equal(taskRow("metadata-check").querySelector(".fta-doi-check").hasAttribute("open"), false, "a manually collapsed metadata comparison stays collapsed");
  for (const [reason, expectedText] of [["doi_mismatch", "网站返回的 DOI 与条目不同"], ["doi_missing", "网站查询未提供 DOI"], ["doi_invalid", "网站返回的 DOI 无法验证"]]) {
    model.tasks[0].doiCheck.reason = reason;model.tasks[0].doiCheck.receivedDOI = reason === "doi_mismatch" ? "10.1234/other" : "";
    model.tasks[0].doiCheck.receivedTitle = "";renderListener();
    metadataDetails = taskRow("metadata-check").querySelector(".fta-doi-check");
    assert.match(metadataDetails.textContent, new RegExp(expectedText));
    assert.match(metadataDetails.textContent, /网站标题：未提供/);
    if (reason !== "doi_mismatch") assert.match(metadataDetails.textContent, /网站 DOI：未提供/);
  }
  model.settings.language = "en";renderListener();
  assert.ok(labels("metadata-check").includes("Check website article metadata"));
  assert.match(taskRow("metadata-check").querySelector(".fta-doi-check").textContent, /Website article metadata · Website DOI invalid/);
  assert.match(taskRow("metadata-check").querySelector(".fta-doi-check").textContent, /Website title:Not provided/);
  assert.match(taskRow("metadata-check").querySelector(".fta-doi-check").textContent, /Zotero 条目标题/, "original article data is never translated");
  model.settings.language = "zh-TW";renderListener();assert.ok(labels("metadata-check").includes("核對網站文獻資訊"));
  model.settings.language = "zh-CN";
  for (const state of ["error", "not_found", "needs_review"]) { model.tasks[0].state = state;renderListener();assert.ok(labels("metadata-check").includes("核对网站文献信息")); }
  model.tasks[0].requestID = "AlreadyPublished";renderListener();assert.equal(labels("metadata-check").includes("核对网站文献信息"), false);
  model.tasks[0].requestID = "";model.tasks[0].doi = "";renderListener();assert.equal(labels("metadata-check").includes("核对网站文献信息"), false);

  // The returned request URL is retained only as a review candidate. UI
  // controls must never convert it to a linked request or repeat paid posting.
  model.tasks = [{ id: "submitted-review", state: "submission_unknown", itemID: 903, doi: "10.1234/expected", title: "已发布 DOI 待核验", requestID: "", requestURL: "", submissionReview: { requestID: "ReviewOnly", requestURL: "https://www.ablesci.com/assist/detail?id=ReviewOnly", expectedDOI: "10.1234/expected", receivedDOI: "10.1234/received", reason: "DOI 不一致 <img src=x onerror=bad>" } }];
  renderListener();
  assert.equal(badgeText("submitted-review"), "已发布求助待核对");
  const reviewBlock = taskRow("submitted-review").querySelector(".fta-submission-review");
  assert.match(reviewBlock.textContent, /条目 DOI：10\.1234\/expected/);
  assert.match(reviewBlock.textContent, /网站 DOI：10\.1234\/received/);
  assert.match(reviewBlock.textContent, /不会重新发布/);
  assert.equal(reviewBlock.querySelector("img"), null, "review reasons are text, never website markup");
  assert.equal(model.tasks[0].requestURL, "", "displaying review metadata never links a request");
  assert.deepEqual(labels("submitted-review"), ["立即检查", "打开已发布求助核对", "打开网页"]);
  assert.equal(taskCheckbox("submitted-review"), null);
  assert.equal(labels("submitted-review").includes("核对网站文献信息"), false, "published candidates use request verification, not an unrelated metadata lookup");
  const beforeSubmittedReview = calls.length;
  rowButton("打开已发布求助核对").click(); await flush();
  rowButton("立即检查").click(); await flush();
  assert.deepEqual(calls.slice(beforeSubmittedReview), [["openSubmissionReview", "submitted-review"], ["check", "submitted-review"]], "review actions neither save a budget nor submit assistance");
  model.tasks[0].submissionReview.receivedDOI = ""; renderListener();
  assert.match(taskRow("submitted-review").querySelector(".fta-submission-review").textContent, /网站 DOI：未提供/);
  model.tasks[0].state = "paused";model.tasks[0].acquisitionMode = "manual";renderListener();
  assert.deepEqual(labels("submitted-review"), ["立即检查", "打开已发布求助核对", "打开网页"], "pausing never unlocks a fresh paid request or hides candidate verification");
  model.settings.language = "en";renderListener();
  assert.equal(badgeText("submitted-review"), "Published request needs review");
  assert.match(taskRow("submitted-review").querySelector(".fta-submission-review").textContent, /Website DOI:Not provided/);
  assert.ok(labels("submitted-review").includes("Open published request for review"));
  model.settings.language = "zh-TW";renderListener();
  assert.equal(badgeText("submitted-review"), "已發布求助待核對");
  assert.ok(labels("submitted-review").includes("打開已發布求助核對"));
  model.settings.language = "zh-CN";
  model.tasks = [{ ...assistTaskBase, id: "linked-browser", source: "browser_download", assistReceipt: null, accessHint: { scope: "article", kind: "browser_success", institutionalConfirmed: false }, title: "浏览器下载的应助文件" }];
  filterButton("all").click();renderListener();
  assert.doesNotMatch(taskRow("linked-browser").textContent, /此论文曾通过浏览器获取|此论文已确认机构访问/);
  assert.equal(labels("linked-browser").includes("这是通过机构获取"), false);
  model.tasks[0].state = "manual_waiting";model.tasks[0].attachmentID = null;model.tasks[0].acquisitionMode = "manual";
  filterButton("unfinished").click();renderListener();
  assert.ok(labels("linked-browser").includes("暂停监控"));
  rowButton("暂停监控").click();await flush();
  assert.deepEqual(calls.at(-1), ["pause", "linked-browser"]);
  assert.match(get("fta-pref-status").textContent, /已有求助保留/);
  assert.match(get("fta-pref-status").textContent, /检查已下载文件/);
  // Local spending totals count accepted requests exactly once, with unknown
  // rewards excluded from point totals and the average's denominator.
  const spendingTask = (id, requestID, points, date, options = {}) => ({ id, requestID, requestURL: "https://www.ablesci.com/assist/detail?id=" + requestID, source: "ablesci", state: "imported", itemID: 950, attachmentID: 951, doi: "10.1234/" + id, title: id, requestedPoints: points, pointsVerified: true, updatedAt: date, assistReceipt: { requestID, accountID: "AccountA", adoption: "accepted", messages: "done", acceptedAt: date }, ...options });
  model.tasks = [
    spendingTask("spend-old", "Spend1", 10, "2026-11-04T01:00:00Z"),
    spendingTask("spend-new", "Spend1", 30, "2026-11-06T01:00:00Z", { title: "<img src=x onerror=bad> 应助论文", assistReceipt: { requestID: "Spend1", accountID: "AccountB", adoption: "accepted", messages: "done", acceptedAt: "2026-11-06T01:00:00Z" } }),
    spendingTask("spend-other", "Spend2", 20, "2026-11-05T01:00:00Z"),
    spendingTask("spend-unknown", "Spend3", 999, "2026-11-07T01:00:00Z", { pointsVerified: false }),
    spendingTask("spend-pending", "Spend4", 500, "2026-11-08T01:00:00Z", { assistReceipt: { requestID: "Spend4", adoption: "pending" } }),
    spendingTask("spend-local", "Spend5", 500, "2026-11-08T01:00:00Z", { source: "local_file" }),
    spendingTask("spend-mismatched", "Spend6", 500, "2026-11-08T01:00:00Z", { assistReceipt: { requestID: "WrongRequest", adoption: "accepted" } })
  ];
  pageTab("account").click();renderListener();
  assert.ok(pagePanel("account").contains(get("fta-pref-spending")));
  assert.equal(get("fta-pref-spending-total").textContent, "50 积分");
  assert.equal(get("fta-pref-spending-count").textContent, "3 篇");
  assert.equal(get("fta-pref-spending-average").textContent, "25.0 积分");
  assert.match(get("fta-pref-spending-coverage").textContent, /金额已核实 2 篇；金额待核实 1 篇/);
  assert.deepEqual([...get("fta-pref-spending-list").children].map(row => row.dataset.requestId), ["Spend3", "Spend1", "Spend2"], "latest accepted record wins and recent spending is newest first");
  assert.equal(get("fta-pref-spending-list").querySelector("img"), null, "spending titles are safe text");
  assert.match(get("fta-pref-spending-list").firstElementChild.textContent, /积分待核实（未计入积分统计）/);
  const spendingDetailsNode = get("fta-pref-spending-details");spendingDetailsNode.setAttribute("open", "");
  model.tasks.find(task => task.id === "spend-unknown").pointsVerified = true;
  model.tasks.find(task => task.id === "spend-unknown").requestedPoints = 40;renderListener();
  assert.equal(get("fta-pref-spending-total").textContent, "90 积分");
  assert.equal(get("fta-pref-spending-average").textContent, "30.0 积分");
  assert.equal(get("fta-pref-spending-details"), spendingDetailsNode);
  assert.equal(spendingDetailsNode.hasAttribute("open"), true, "polling never replaces or closes spending details");
  spendingDetailsNode.removeAttribute("open");renderListener();assert.equal(spendingDetailsNode.hasAttribute("open"), false);
  model.settings.language = "en";renderListener();
  assert.equal(get("fta-pref-spending-heading").textContent, "Points usage");
  assert.equal(get("fta-pref-spending-count").textContent, "3 articles");
  assert.equal(get("fta-pref-spending-average").textContent, "30.0 points");
  assert.match(get("fta-pref-spending-list").textContent, /应助论文/, "spending titles are not translated");
  model.settings.language = "zh-TW";renderListener();assert.equal(get("fta-pref-spending-heading").textContent, "積分使用");
  model.settings.language = "zh-CN";
  model.tasks = Array.from({ length: 12 }, (_, index) => spendingTask("spend-many-" + index, "Many" + index, 10, "2026-11-" + String(index + 1).padStart(2, "0") + "T01:00:00Z"));renderListener();
  assert.equal(get("fta-pref-spending-list").children.length, 10, "recent spending is bounded without truncating totals");
  assert.equal(get("fta-pref-spending-count").textContent, "12 篇");
  assert.equal(get("fta-pref-spending-total").textContent, "120 积分");
  model.tasks = [spendingTask("unknown-only", "UnknownOnly", 10, "2026-11-06T01:00:00Z", { pointsVerified: false })];renderListener();
  assert.equal(get("fta-pref-spending-total").textContent, "0 积分");
  assert.equal(get("fta-pref-spending-count").textContent, "1 篇");
  assert.equal(get("fta-pref-spending-average").textContent, "—", "unknown rewards cannot create a zero-price average");
  model.tasks = [];renderListener();
  assert.equal(get("fta-pref-spending-empty").hidden, false);
  assert.equal(get("fta-pref-spending-count").textContent, "0 篇");
  assert.equal(get("fta-pref-spending-average").textContent, "—");
  pageTab("tasks").click();
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
    downloadStatus: { scanned: 23, unknown: 21, related: 4, unreadable: 1, unrelated: 16, mismatched: 2, lastScanAt: "2026-11-05T08:30:00Z" },
    downloadCandidates: [
      { id: "candidate-three", filename: "third.pdf", related: true, candidateScore: 0.7, titleSimilarity: 0.72, evidence: { candidateBasis: ["front_title_similar"] } },
      { id: "candidate-unrelated", filename: "unrelated.pdf", related: false, candidateScore: 1 },
      { id: "candidate-one", filename: "<img src=x onerror=bad>.pdf", related: true, candidateScore: 0.92, titleSimilarity: 0.94, detectedTitle: "科研通账号", detectedDOIs: ["10.1234/diagnostic"], evidence: { titleReliable: true, doiReliable: true, candidateBasis: ["article_doi_match", "front_title_similar", "article_doi_match", "unknown_future_basis"] }, message: "无法自动确认所选 PDF 的论文身份。请先预览并核对标题、作者和 DOI，再明确确认。" },
      { id: "candidate-four", filename: "fourth.pdf", related: true, candidateScore: 0.6 },
      { id: "candidate-legacy", filename: "legacy.pdf" },
      { id: "candidate-two", filename: "second.pdf", related: true, candidateScore: 0.8, titleSimilarity: 0.81, evidence: { candidateBasis: ["front_title_similar"] } },
      { filename: "missing-id.pdf", related: true, candidateScore: 1 }
    ],
    downloadDiagnostics: [
      { category: "unrelated", filename: "other-article.pdf", detectedTitle: "A different article", detectedDOIs: ["10.1234/other"], titleSimilarity: 0.1, evidence: { candidateBasis: ["front_title_different"] } },
      { category: "unreadable", filename: "scanned.pdf", evidence: { extractionSucceeded: false, candidateBasis: ["no_extractable_text"] }, message: "PDF 未提取到可核验文字，可能是扫描件或受保护文件，需人工核对。" },
      { category: "mismatch", filename: "<svg onload=bad>.pdf", detectedTitle: "<img src=x onerror=bad>下载设置", detectedDOIs: ["10.1234/<svg onload=bad>"], evidence: { candidateBasis: ["article_doi_mismatch"] } },
      { category: "constructor", filename: "invalid-category.pdf" }
    ],
    accessEvidence: { kind: "institutional_entry", confidence: "explicit" }, accessHint: { scope: "host_hint", kind: "institutional_confirmed", institutionalConfirmed: false }
  }];
  model.currentBatch = { id: "diagnostic-batch", createdAt: "2026-11-05T08:00:00Z", taskIDs: ["diagnostic"] };
  filterButton("unfinished").click();renderListener();
  const diagnostic = taskRow("diagnostic").querySelector(".fta-download-details");
  assert.equal(diagnostic.hasAttribute("open"), false, "download diagnostics start collapsed");
  assert.match(diagnostic.textContent, /已检查 23 个 PDF；相关候选 4 个，已排除 18 个，识别不足 1 个/);
  assert.doesNotMatch(diagnostic.textContent, /身份待核对 21/);
  assert.deepEqual([...diagnostic.querySelectorAll(".fta-download-candidate")].map(node => node.dataset.candidateId), ["candidate-one", "candidate-two", "candidate-three"], "only the three highest-ranked explicitly related candidates can be reviewed");
  assert.doesNotMatch(diagnostic.textContent, /unrelated\.pdf|legacy\.pdf|fourth\.pdf|missing-id\.pdf|invalid-category\.pdf/);
  assert.match(diagnostic.querySelector(".fta-detected-title").textContent, /识别标题：科研通账号/);
  assert.match(diagnostic.querySelector(".fta-detected-dois").textContent, /识别 DOI：10\.1234\/diagnostic/);
  assert.equal(diagnostic.querySelector(".fta-evidence-basis").textContent, "判定依据：本文 DOI 一致 · 首页标题相近，待核对");
  assert.equal(diagnostic.querySelector(".fta-title-similarity").textContent, "标题相似度 94%");
  assert.match(diagnostic.querySelector(".fta-title-similarity").title, /不是论文匹配概率/);
  const excludedDiagnostic = diagnostic.querySelector(".fta-download-diagnostics");
  assert.equal(excludedDiagnostic.hasAttribute("open"), false, "excluded files and insufficient evidence start collapsed separately");
  assert.equal(excludedDiagnostic.querySelectorAll(".fta-download-diagnostic").length, 3);
  assert.equal(excludedDiagnostic.querySelectorAll("button").length, 0, "low-relevance and unreadable files are not presented as actionable candidates");
  assert.match(excludedDiagnostic.textContent, /明确不匹配 2 个；低相关 16 个；识别不足 1 个/);
  assert.match(excludedDiagnostic.textContent, /不能据此断定文件错误/);
  assert.equal(diagnostic.querySelector("img"), null);
  assert.equal(diagnostic.querySelector("svg"), null);
  assert.match(taskRow("diagnostic").textContent, /不代表当前账号拥有此论文权限/);
  assert.match(taskRow("diagnostic").textContent, /仅供参考/);
  assert.doesNotMatch(taskRow("diagnostic").textContent, /此论文已确认机构访问/);
  diagnostic.setAttribute("open", "");
  excludedDiagnostic.setAttribute("open", "");
  renderListener();
  assert.equal(taskRow("diagnostic").querySelector(".fta-download-details").hasAttribute("open"), true, "an immediate polling refresh preserves the user's expanded diagnostic before toggle dispatch");
  assert.equal(taskRow("diagnostic").querySelector(".fta-download-diagnostics").hasAttribute("open"), true, "the diagnostic section also survives polling refreshes");
  model.tasks.push({ id: "diagnostic-other", state: "manual_waiting", itemID: 302, title: "Another download", downloadStatus: { scanned: 0 } });
  renderListener();
  assert.equal(taskRow("diagnostic-other").querySelector(".fta-download-details").hasAttribute("open"), false, "expansion belongs only to the selected task");
  filterButton("all").click();filterButton("unfinished").click();
  assert.equal(taskRow("diagnostic").querySelector(".fta-download-details").hasAttribute("open"), true, "filtering away and back preserves the expanded task");
  assert.equal(taskRow("diagnostic").querySelector(".fta-download-diagnostics").hasAttribute("open"), true, "filter changes retain the separate diagnostic expansion");
  taskRow("diagnostic").querySelector(".fta-download-details").removeAttribute("open");
  taskRow("diagnostic").querySelector(".fta-download-diagnostics").removeAttribute("open");
  renderListener();
  assert.equal(taskRow("diagnostic").querySelector(".fta-download-details").hasAttribute("open"), false, "an explicitly collapsed diagnostic stays collapsed after refresh");
  assert.equal(taskRow("diagnostic").querySelector(".fta-download-diagnostics").hasAttribute("open"), false, "explicitly collapsing diagnostic records is preserved");
  taskRow("diagnostic").querySelector(".fta-download-details").setAttribute("open", "");
  model.tasks.pop();renderListener();
  const beforeDiagnostic = calls.length;
  rowButton("检查已下载文件").click();await flush();
  assert.equal(taskRow("diagnostic").querySelector(".fta-download-details").hasAttribute("open"), true, "a check action also preserves expanded candidates");
  rowButton("预览并核对").click();await flush();
  assert.deepEqual(calls.slice(beforeDiagnostic), [["recheckPDFs", "diagnostic"], ["reviewCandidate", "diagnostic", "candidate-one"]]);
  assert.equal(model.tasks[0].state, "manual_waiting");
  assert.equal(taskRow("diagnostic").querySelector(".fta-download-details").hasAttribute("open"), true, "preview refresh does not hide the candidate or imply confirmation");

  // Unknown counts from older versions are not inferred to be candidates or
  // mismatches. Missing or malformed classifications remain explicitly unknown.
  model.tasks.push({ id: "legacy-diagnostic", state: "manual_waiting", itemID: 302, title: "Legacy check", downloadStatus: { scanned: 23, unknown: 19, mismatched: 4 }, downloadCandidates: [{ id: "old-unknown", filename: "old.pdf" }] });
  renderListener();
  const legacyDiagnostic = taskRow("legacy-diagnostic").querySelector(".fta-download-details");
  assert.match(legacyDiagnostic.textContent, /已检查 23 个 PDF。/);
  assert.match(legacyDiagnostic.textContent, /尚无完整的相关性分类/);
  assert.doesNotMatch(legacyDiagnostic.textContent, /相关候选|已排除 4|尚未找到足够相关/);
  assert.equal(legacyDiagnostic.querySelectorAll(".fta-download-candidate").length, 0);
  Object.assign(model.tasks.at(-1).downloadStatus, { related: -1, unreadable: 4, unrelated: 15 });renderListener();
  assert.match(taskRow("legacy-diagnostic").textContent, /尚无完整的相关性分类/);
  model.tasks.pop();renderListener();

  // A saved minimum policy is explicit at the action, while an unsaved checkbox
  // does not change what a request button promises to use.
  model.settings.acceptSiteMinimum = true; renderListener();
  changeChecked(taskCheckbox("diagnostic"), true);
  assert.match(rowButton("科研通求助（" + model.settings.points + " 积分起）").textContent, /积分起/);
  assert.match(get("fta-pref-bulk-assist").textContent, /每篇 .* 积分起/);
  assert.match(get("fta-pref-selection-summary").textContent, /基础悬赏合计 .*可能按网站最低积分上调/);
  assert.match(taskRow("diagnostic").textContent, /最终悬赏可能高于按钮中的基础积分/);
  model.settings.acceptSiteMinimum = false; renderListener();
  assert.doesNotMatch(get("fta-pref-bulk-assist").textContent, /积分起/);

  // Language is saved on its own, while drafts, task filter, selection and raw
  // article/site text survive immediately switching among all three locales.
  model.session = { status: "signed_out", username: "saved@example.invalid", message: "", hasSavedPassword: false };
  model.messages = [{ id: "raw-message", title: "下载设置", summary: "科研通账号" }];
  model.messagesStatus = { state: "loaded" };
  input("fta-pref-points", "37");input("fta-pref-poll", "125");
  get("fta-pref-site-minimum").checked = true;get("fta-pref-site-minimum").dispatchEvent(new window.Event("input"));
  input("fta-pref-username", "draft@example.invalid");input("fta-pref-password", "do-not-save-this-draft");
  get("fta-pref-request-url").value = "https://www.ablesci.com/assist/detail?id=DraftOnly";
  chooseTarget("diagnostic");changeChecked(taskCheckbox("diagnostic"), true);
  get("fta-pref-checkin-reminder").checked = true;get("fta-pref-checkin-reminder").dispatchEvent(new window.Event("input"));
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
  assert.equal(get("fta-pref-checkin-reminder").checked, true);
  assert.equal(model.settings.checkInReminder, false, "language changes preserve but do not save the reminder draft");
  assert.equal(model.settings.acceptSiteMinimum, false, "language changes never activate an unsaved minimum-reward opt-in");
  assert.equal(get("fta-pref-site-minimum").checked, true, "language changes retain the minimum-reward draft");
  assert.equal(pageTab("account").textContent, "AbleSci settings");
  assert.equal(get("fta-pref-points").value, "37");assert.equal(get("fta-pref-poll").value, "125");
  assert.equal(get("fta-pref-username").value, "draft@example.invalid");assert.equal(get("fta-pref-password").value, "do-not-save-this-draft");
  assert.equal(get("fta-pref-request-url").value, "https://www.ablesci.com/assist/detail?id=DraftOnly");
  assert.equal(get("fta-pref-request-target").value, "diagnostic");assert.equal(taskCheckbox("diagnostic").checked, true);
  assert.equal(filterButton("unfinished").getAttribute("aria-pressed"), "true");
  assert.equal(pageTab("settings").textContent, "Settings");
  assert.equal(filterButton("active").textContent, "In progress 1");
  assert.match(get("fta-pref-task-scope").textContent, /All unfinished tasks across batches/);
  assert.match(get("fta-pref-bulk-assist").textContent, /37 points each/);
  assert.equal(taskRow("diagnostic").querySelector(".fta-row-title button span").textContent, "下载设置", "article title matching a UI key must never be translated");
  pageTab("messages").click();
  assert.equal(get("fta-pref-message-list").querySelector(".fta-row-title").textContent, "下载设置");
  assert.equal(get("fta-pref-message-list").querySelector(".fta-message-summary").textContent, "科研通账号");
  pageTab("tasks").click();
  assert.equal(taskRow("diagnostic").querySelector(".fta-candidate-name").textContent, "<img src=x onerror=bad>.pdf");
  assert.equal(taskRow("diagnostic").querySelector(".fta-detected-title [data-i18n-skip]").textContent, "科研通账号", "detected titles matching UI translation keys remain raw metadata");
  assert.match(taskRow("diagnostic").textContent, /Checked 23 PDFs: 4 relevant candidates, 18 excluded, 1 with insufficient identity evidence/);
  assert.equal(taskRow("diagnostic").querySelector(".fta-evidence-basis").textContent, "Evidence: Article DOI matches · Similar first-page title; review required");
  assert.equal(taskRow("diagnostic").querySelector(".fta-title-similarity").textContent, "Title similarity 94%");
  assert.equal(taskRow("diagnostic").querySelector(".fta-download-diagnostics > summary").textContent, "Excluded files and insufficient evidence");
  assert.match(taskRow("diagnostic").textContent, /does not confirm that the current account/);
  const untranslatedUI = [];
  (function inspect(node) {
    if (node.nodeType === 3) { if (/[\u4e00-\u9fff]/.test(node.nodeValue || "")) untranslatedUI.push(node.nodeValue.trim());return; }
    if (node.getAttribute?.("data-i18n-skip") === "true" || ["style", "script"].includes(node.localName)) return;
    for (const child of node.childNodes || []) inspect(child);
  })(root);
  assert.deepEqual(untranslatedUI, [], "all plugin UI text is translated; source metadata is explicitly excluded");
  await chooseLanguage("zh-TW");
  assert.equal(pageTab("settings").textContent, "設定");
  assert.equal(get("fta-pref-account-state").textContent, "未登入");
  assert.equal(get("fta-pref-password").value, "do-not-save-this-draft");
  assert.equal(taskRow("diagnostic").querySelector(".fta-row-title button span").textContent, "下载设置");
  assert.equal(taskRow("diagnostic").querySelector(".fta-download-diagnostics > summary").textContent, "已排除與識別不足");
  assert.equal(taskRow("diagnostic").querySelector(".fta-detected-title [data-i18n-skip]").textContent, "科研通账号");
  await chooseLanguage("zh-CN");
  assert.equal(pageTab("settings").textContent, "设置");
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
  assert.equal(i18n.translate("按 25 积分起重试", "en"), "Retry from 25 points");
  assert.equal(i18n.translate("网页优先，科研通兜底（25 积分起）", "en"), "Web first, AbleSci fallback (from 25 points)");
  assert.equal(i18n.translate("网页优先，科研通兜底（25 积分起）", "zh-TW"), "網頁優先，科研通兜底（25 積分起）");
  assert.equal(i18n.translate("来源：科研通 · 已支出 30 积分", "en"), "Source: AbleSci · Spent 30 points");
  assert.equal(i18n.translate("来源：科研通 · 积分待核实", "zh-TW"), "來源：科研通 · 積分待核實");
  assert.equal(i18n.translate("来源：出版社网页", "en"), "Source: Publisher page");
  assert.equal(i18n.translate("Unknown <img onerror=x> 论文", "en"), "Unknown <img onerror=x> 论文");
  pageTab("messages").click();
  context.FulltextPreferences.destroy();
  assert.equal(subscriptions, 0);
  pageTab("settings").click();
  assert.equal(root.dataset.activePage, "messages", "destroy removes page navigation handlers");
  // Source credentials and native update controls use only app APIs, preserve
  // concurrent edits, and never infer a successful download from a source URL.
  {
    const pane = parseHTML("<html><body>" + markup + "</body></html>");
    const node = id => pane.document.getElementById(id);
    const state = { version: "0.9.0", settings: { language: "zh-CN" }, session: { status: "signed_out" }, tasks: [], messages: [],
      sourceCredentials: { openalex: true, core: true, semanticScholar: false },
      sourceSettings: { enabled: { publisher: true, openAccess: true, openalex: true, pmc: true, core: true, semanticScholar: true, custom: false }, versionPreference: "accepted", customTemplates: [], openalexContentEnabled: false, openalexDailyLimit: 100 },
      updateStatus: { state: "idle", currentVersion: "0.9.0", availableVersion: null, checkedAt: null, autoUpdate: true, canInstall: false, canCheck: true, releaseNotesAvailable: true } };
    const actions = [];let emit;
    const api = { getSnapshot: () => structuredClone(state), subscribe: fn => { emit = fn;return () => {}; }, localize: node => i18n.apply(node, state.settings.language),
      saveSourceSettings: async value => { actions.push(["sources", JSON.parse(JSON.stringify(value))]);state.sourceSettings = JSON.parse(JSON.stringify(value));emit(); },
      saveSourceCredentials: async value => { actions.push(["keys", JSON.parse(JSON.stringify(value))]);for (const key of Object.keys(value)) state.sourceCredentials[key] = value[key] !== null;emit(); },
      checkForUpdates: async () => { actions.push(["checkUpdates"]);state.updateStatus = { ...state.updateStatus, state: "current", checkedAt: "2026-11-09T10:00:00Z" };emit(); },
      installUpdate: async () => { actions.push(["installUpdate"]);state.updateStatus = { ...state.updateStatus, state: "installed", canInstall: false, currentVersion: "0.9.1" };emit(); },
      setAutoUpdate: async value => { actions.push(["autoUpdate", value]);state.updateStatus.autoUpdate = value;emit(); },
      openReleaseNotes: async () => { actions.push(["releaseNotes"]); }
    };
    pane.window.Zotero = { FulltextAssistant: api };
    const isolated = { window: pane.window, document: pane.document, Zotero: pane.window.Zotero, URL, Date };
    vm.runInNewContext(script, isolated);await flush();
    const type = (id, value) => { node(id).value = value;node(id).dispatchEvent(new pane.window.Event("input")); };
    const check = (id, checked) => { node(id).checked = checked;node(id).dispatchEvent(new pane.window.Event("change")); };
    const send = id => node(id).dispatchEvent(new pane.window.Event("submit", { cancelable: true }));
    const select = (id, value) => { for (const option of node(id).querySelectorAll("option")) option.selected = option.value === value;node(id).dispatchEvent(new pane.window.Event("change")); };
    assert.deepEqual(actions, [], "opening or rendering preferences never checks or installs an update");
    assert.equal(node("fta-pref-source-version").value, "accepted");
    assert.equal(node("fta-pref-openalex-content").checked, false);
    assert.equal(node("fta-pref-openalex-limit").disabled, true);
    assert.equal(node("fta-pref-core-content").checked, false, "CORE direct-content consent defaults off for old settings");
    assert.equal(node("fta-pref-core-limit").value, "20");assert.equal(node("fta-pref-core-limit").disabled, true);
    assert.equal(node("fta-pref-source-custom").checked, false);
    assert.equal(node("fta-pref-version").textContent, "v0.9.0");
    assert.equal(node("fta-pref-install-update").hidden, true);
    assert.equal(node("fta-pref-check-update").getAttribute("aria-label"), "检查更新");
    for (const key of ["openalex", "core", "semanticScholar"]) {
      assert.equal(node("fta-pref-key-" + key).type, "password");
      assert.equal(node("fta-pref-key-" + key).value, "");
      assert.equal(node("fta-pref-key-" + key).getAttribute("autocomplete"), "new-password");
    }
    assert.equal(node("fta-pref-key-openalex-state").textContent, "已保存密钥");
    assert.equal(node("fta-pref-key-semanticScholar-state").textContent, "未保存密钥");
    assert.ok(node("fta-pref-panel-settings").contains(node("fta-pref-source-settings-form")));
    assert.ok(node("fta-pref-panel-settings").contains(node("fta-pref-source-credentials-form")));
    type("fta-pref-key-openalex", "new-key-fixture");
    check("fta-pref-key-core-clear", true);
    check("fta-pref-source-pmc", false);
    check("fta-pref-source-custom", true);
    select("fta-pref-source-version", "any");
    type("fta-pref-source-templates", "https://first.example/doi/{doi}; https://second.example/?doi={doi}\nhttps://first.example/doi/{doi}");
    check("fta-pref-openalex-content", true);
    type("fta-pref-openalex-limit", "27");
    check("fta-pref-core-content", true);type("fta-pref-core-limit", "17");
    assert.equal(node("fta-pref-core-limit").disabled, false);
    assert.equal(node("fta-pref-tab-settings").dataset.dirty, "true");
    state.sourceSettings = { ...state.sourceSettings, customTemplates: ["https://remote.example/{doi}"], versionPreference: "published", openalexDailyLimit: 100 };
    state.settings.language = "en";emit();node("fta-pref-tab-messages").click();node("fta-pref-tab-settings").click();
    assert.equal(node("fta-pref-key-openalex").value, "new-key-fixture", "snapshot refresh and navigation keep the secret draft");
    assert.match(node("fta-pref-source-templates").value, /first\.example/);
    assert.equal(node("fta-pref-source-version").value, "any");
    assert.equal(node("fta-pref-openalex-limit").value, "27");
    assert.equal(node("fta-pref-core-content").checked, true);assert.equal(node("fta-pref-core-limit").value, "17", "CORE consent and limit drafts survive language and snapshot refreshes");
    assert.equal(node("fta-pref-source-pmc").checked, false);
    assert.equal(node("fta-pref-key-core-clear").checked, true);
    assert.equal(node("fta-pref-save-sources").textContent, "Save full-text sources");
    send("fta-pref-source-credentials-form");await flush();
    assert.deepEqual(actions.at(-1), ["keys", { openalex: "new-key-fixture", core: null }], "omitted keys are kept, explicit null removes only the selected saved key");
    assert.equal(node("fta-pref-key-openalex").value, "", "only a successful save clears the password draft");
    assert.equal(node("fta-pref-key-core-clear").checked, false);
    assert.equal(node("fta-pref-key-core-state").textContent, "No saved key");
    assert.equal(node("fta-pref-tab-settings").dataset.dirty, "true", "saving credentials does not discard the independent source draft");
    assert.equal(state.sourceSettings.openalexContentEnabled, false, "saving an OpenAlex key cannot silently enable paid-credit usage");
    assert.notEqual(state.sourceSettings.coreContentEnabled, true, "saving or clearing keys never enables CORE direct downloads");
    assert.equal(actions.some(action => action[0] === "sources"), false);
    const saveKeys = api.saveSourceCredentials;
    api.saveSourceCredentials = async () => { throw new Error("Internal failure including a-private-secret"); };
    type("fta-pref-key-semanticScholar", "retry-secret-fixture");send("fta-pref-source-credentials-form");await flush();
    assert.equal(node("fta-pref-key-semanticScholar").value, "retry-secret-fixture");
    assert.equal(node("fta-pref-source-key-state").dataset.error, "true");
    assert.match(node("fta-pref-source-key-state").textContent, /did not finish.*input was kept/i);
    assert.doesNotMatch(pane.document.body.textContent, /a-private-secret|retry-secret-fixture/);
    api.saveSourceCredentials = saveKeys;
    type("fta-pref-key-semanticScholar", " ");const unchangedKeyCalls = actions.length;
    send("fta-pref-source-credentials-form");await flush();assert.equal(actions.length, unchangedKeyCalls, "blank fields do not delete saved keys or call the credentials API");
    assert.equal(state.sourceCredentials.openalex, true);
    send("fta-pref-source-settings-form");await flush();
    const saved = actions.at(-1);
    assert.equal(saved[0], "sources");
    assert.deepEqual(saved[1].customTemplates, ["https://first.example/doi/{doi}", "https://second.example/?doi={doi}"]);
    assert.equal(saved[1].versionPreference, "any");assert.equal(saved[1].enabled.pmc, false);assert.equal(saved[1].enabled.custom, true);
    assert.equal(saved[1].openalexContentEnabled, true);assert.equal(saved[1].openalexDailyLimit, 27);
    assert.equal(saved[1].coreContentEnabled, true);assert.equal(saved[1].coreDailyLimit, 17, "CORE opt-in can be saved without a key so the backend can explain missing credentials");
    assert.equal(Object.hasOwn(saved[1], "openalex"), false, "secret keys never enter ordinary source settings");
    assert.equal(node("fta-pref-tab-settings").dataset.dirty, "false");
    assert.match(node("fta-pref-source-save-state").textContent, /settings saved/);
    const sourceSave = api.saveSourceSettings;
    api.saveSourceSettings = async () => { throw new Error("Source settings could not be saved."); };
    type("fta-pref-source-templates", "https://retained.example/{doi}");send("fta-pref-source-settings-form");await flush();
    assert.equal(node("fta-pref-source-templates").value, "https://retained.example/{doi}");
    assert.equal(node("fta-pref-source-save-state").dataset.error, "true");
    assert.match(node("fta-pref-source-save-state").textContent, /could not be saved/);
    api.saveSourceSettings = sourceSave;
    for (const invalid of ["http://insecure.example/{doi}", "https://example.org/no-placeholder", "https://user:pass@example.org/{doi}"]) {
      type("fta-pref-source-templates", invalid);const count = actions.length;send("fta-pref-source-settings-form");await flush();
      assert.equal(actions.length, count);assert.equal(node("fta-pref-source-save-state").dataset.error, "true");
    }
    type("fta-pref-source-templates", "https://retained.example/{doi}");
    for (const invalid of ["0", "1001", "1.5", "bad"]) {
      type("fta-pref-openalex-limit", invalid);const count = actions.length;send("fta-pref-source-settings-form");await flush();
      assert.equal(actions.length, count);assert.match(node("fta-pref-source-save-state").textContent, /integer from 1 to 1000/);
    }
    type("fta-pref-openalex-limit", "35");
    for (const invalid of ["0", "1001", "2.5", "", "bad"]) {
      type("fta-pref-core-limit", invalid);const count = actions.length;send("fta-pref-source-settings-form");await flush();
      assert.equal(actions.length, count);assert.match(node("fta-pref-source-save-state").textContent, /direct CORE downloads.*integer from 1 to 1000/);
    }
    type("fta-pref-core-limit", "31");
    type("fta-pref-key-openalex", "pending-update-secret");
    let finishUpdateCheck;
    api.checkForUpdates = async () => { actions.push(["checkUpdates"]);state.updateStatus.state = "checking";emit();await new Promise(resolve => { finishUpdateCheck = resolve; });state.updateStatus = { ...state.updateStatus, state: "available", availableVersion: "0.9.1", canInstall: true, checkedAt: "2026-11-09T11:00:00Z" };emit(); };
    node("fta-pref-check-update").click();await flush();
    assert.equal(node("fta-pref-check-update").disabled, true);
    assert.equal(node("fta-pref-check-update").getAttribute("aria-busy"), "true");
    assert.equal(node("fta-pref-update-state").textContent, "Checking for updates…");
    assert.equal(node("fta-pref-key-openalex").value, "pending-update-secret");
    finishUpdateCheck();await flush();
    assert.equal(node("fta-pref-update-state").textContent, "Update available: v0.9.1");
    assert.equal(node("fta-pref-install-update").hidden, false);assert.equal(node("fta-pref-install-update").disabled, false);
    assert.equal(actions.some(action => action[0] === "installUpdate"), false, "discovering an update never installs it");
    assert.equal(node("fta-pref-openalex-limit").value, "35");
    assert.equal(node("fta-pref-core-limit").value, "31", "native update checks preserve the CORE budget draft");
    assert.equal(node("fta-pref-key-openalex").value, "pending-update-secret");
    node("fta-pref-release-notes").click();await flush();assert.deepEqual(actions.at(-1), ["releaseNotes"]);
    assert.equal(actions.some(action => action[0] === "installUpdate"), false);
    check("fta-pref-auto-update", false);await flush();assert.deepEqual(actions.at(-1), ["autoUpdate", false]);
    const autoUpdate = api.setAutoUpdate;api.setAutoUpdate = async () => { throw new Error("Automatic update preference could not be saved."); };
    check("fta-pref-auto-update", true);await flush();
    assert.equal(node("fta-pref-auto-update").checked, false, "failed native preference writes restore the actual persisted setting");
    assert.equal(node("fta-pref-update-action-status").dataset.error, "true");
    api.setAutoUpdate = autoUpdate;
    state.updateStatus.globalUpdatesEnabled = false;emit();assert.equal(node("fta-pref-update-global-note").hidden, false);
    state.settings.language = "zh-TW";emit();
    assert.equal(node("fta-pref-save-sources").textContent, "儲存全文來源");
    assert.equal(node("fta-pref-update-state").textContent, "可更新至 v0.9.1");
    assert.equal(node("fta-pref-check-update").getAttribute("aria-label"), "檢查更新");
    assert.equal(node("fta-pref-key-openalex").value, "pending-update-secret");
    state.updateStatus.state = "downloading";state.updateStatus.progress = { percent: 42 };emit();
    assert.equal(node("fta-pref-update-state").textContent, "正在下載更新 · 42%");
    assert.equal(node("fta-pref-install-update").disabled, true);
    state.updateStatus.state = "available";state.updateStatus.progress = null;emit();
    node("fta-pref-install-update").click();await flush();assert.deepEqual(actions.at(-1), ["installUpdate"]);
    assert.equal(node("fta-pref-version").textContent, "v0.9.1");assert.equal(node("fta-pref-update-state").textContent, "更新已安裝");
    state.updateStatus.restartRequired = true;emit();assert.match(node("fta-pref-update-message").textContent, /需要重新啟動/);
    state.updateStatus = { ...state.updateStatus, state: "error", restartRequired: false, message: "更新失败，可重试", canCheck: false, canInstall: false };emit();
    assert.equal(node("fta-pref-check-update").disabled, true, "native installation reconciliation can block repeated checks");
    assert.equal(node("fta-pref-update-state").dataset.error, "true");
    assert.equal(node("fta-pref-update-message").textContent, "更新失敗，可重試");
    state.updateStatus.message = "<img src=x onerror=bad>";emit();assert.equal(node("fta-pref-update-message").querySelector("img"), null);
    state.settings.language = "en";
    state.tasks = ["published", "accepted", "submitted", "unknown"].map((version, index) => ({ id: "source-version-" + index, title: "Version fixture " + index, doi: "10.1234/" + index, state: "imported", source: ["openalex", "pmc", "core", "semanticScholar"][index], fulltextVersion: version, completedAt: "2026-11-09T10:00:00Z" }));emit();
    node("fta-pref-task-filters").querySelector('[data-filter="all"]').click();
    const history = node("fta-pref-task-list").textContent;
    assert.match(history, /Full-text version: Published/);assert.match(history, /Full-text version: Accepted manuscript/);
    assert.match(history, /Full-text version: Preprint/);assert.match(history, /Full-text version: Unverified/);
    assert.match(history, /Source: OpenAlex/);assert.match(history, /Source: PubMed Central/);assert.match(history, /Source: CORE/);assert.match(history, /Source: Semantic Scholar/);
    state.tasks[0].sourceDiagnostics = [
      { source: "openalex", code: "timeout", message: "The source lookup reached its time limit." },
      { source: "core", code: "download_failed", message: "此来源未完成下载，已继续其他获取方式。" },
      { source: "semanticScholar", code: "metadata_only", message: "This source reports links, not a verified hosted PDF." },
      { source: "custom", code: "human_verification", message: "The page requires human verification." },
      { source: "unknown", code: "future_code", message: "<img src=x onerror=bad>" }
    ];emit();
    let sourceDetail = node("fta-pref-task-list").querySelector('[data-task-id="source-version-0"] .fta-source-diagnostics');
    assert.equal(sourceDetail.querySelector("summary").textContent, "Source check details");
    assert.equal(sourceDetail.hasAttribute("open"), false, "source diagnostics start collapsed");
    assert.match(sourceDetail.textContent, /lookup or download timed out/);
    assert.match(sourceDetail.textContent, /download from this source failed/);
    assert.match(sourceDetail.textContent, /API results from this source are used only to discover links/);
    assert.doesNotMatch(sourceDetail.textContent, /candidate link was found/, "metadata diagnostics do not claim a candidate exists");
    assert.match(sourceDetail.textContent, /requires human verification/);
    assert.equal(sourceDetail.querySelector("img"), null, "unknown backend messages are safe text");
    sourceDetail.setAttribute("open", "");emit();
    node("fta-pref-task-filters").querySelector('[data-filter="unfinished"]').click();
    node("fta-pref-task-filters").querySelector('[data-filter="all"]').click();
    sourceDetail = node("fta-pref-task-list").querySelector('[data-task-id="source-version-0"] .fta-source-diagnostics');
    assert.equal(sourceDetail.hasAttribute("open"), true, "source details retain expansion across refresh and filtering");
    state.settings.language = "zh-CN";emit();
    assert.match(node("fta-pref-task-list").textContent, /来源检查详情/);
    assert.match(node("fta-pref-task-list").textContent, /此来源查询或下载超时/);
    assert.match(node("fta-pref-task-list").textContent, /此来源下载失败，未取得可用全文/);
    assert.doesNotMatch(node("fta-pref-task-list").textContent, /The source lookup reached/);
    state.tasks[0].sourceDiagnostics = Array.from({ length: 30 }, () => ({ source: "openalex", code: "timeout" }));emit();
    assert.equal(node("fta-pref-task-list").querySelectorAll(".fta-source-diagnostic-row").length, 24);
    state.updateStatus = { ...state.updateStatus, state: "idle", canCheck: true, message: "", autoUpdate: false };
    api.checkForUpdates = async () => { state.updateStatus = { ...state.updateStatus, state: "error", errorCode: "CHECK_TIMEOUT", message: "检查更新超时，可以重新检查。" };emit();return { ...state.updateStatus }; };emit();
    node("fta-pref-check-update").click();await flush();
    assert.equal(node("fta-pref-update-action-status").dataset.error, "true", "resolved native failure snapshots are not reported as successful checks");
    assert.match(node("fta-pref-update-action-status").textContent, /检查更新超时/);
    api.setAutoUpdate = async () => { state.updateStatus = { ...state.updateStatus, state: "error", errorCode: "SETTINGS_FAILED", message: "无法保存 Zotero 自动更新设置，请重试。", autoUpdate: false };emit();return { ...state.updateStatus }; };
    check("fta-pref-auto-update", true);await flush();
    assert.equal(node("fta-pref-auto-update").checked, false);
    assert.equal(node("fta-pref-update-action-status").dataset.error, "true", "resolved native preference errors retain a visible failure");
    assert.match(node("fta-pref-update-action-status").textContent, /无法保存/);
    state.settings.language = "en";emit();
    assert.equal(node("fta-pref-update-message").textContent, "The Zotero automatic update setting could not be saved. Try again.");
    assert.equal(node("fta-pref-key-openalex").value, "pending-update-secret");
    isolated.FulltextPreferences.destroy();assert.equal(node("fta-pref-key-openalex").value, "", "unmount clears secret drafts");
  }
  // A complete large history stays searchable while only one bounded page is
  // mounted. Background notifications must not replace unchanged controls.
  {
    const pane = parseHTML("<html><body>" + markup + "</body></html>");
    const node = id => pane.document.getElementById(id), rows = kind => [...node("fta-pref-" + kind + "-list").children];
    const baseTime = Date.parse("2026-01-01T00:00:00Z");
    const state = { version: "1.0.0", settings: { language: "zh-CN", points: 10, pollSeconds: 60 }, session: { status: "authenticated", accountID: "fixture-account" },
      tasks: Array.from({ length: 10037 }, (_, index) => ({ id: "large-" + index, itemID: index + 1, attachmentID: index + 20000, title: "Article " + index, doi: "10.9999/" + index, state: "imported", completedAt: new Date(baseTime + index * 1000).toISOString(), source: "openalex", discoveryProvider: "openalex", pdfHost: "repository.example.org" })),
      messages: Array.from({ length: 203 }, (_, index) => ({ id: "message-" + index, title: "Message " + index, text: index === 200 ? "needle beyond the first thirty messages" : "Message body " + index, read: index % 2 === 1 })),
      messagesStatus: { state: "loaded" }, currentBatch: { id: "large-batch", taskIDs: [], createdAt: "2026-11-09T00:00:00Z" },
      updateStatus: { state: "current", currentVersion: "1.0.0", canCheck: true, releaseNotesAvailable: true, autoUpdate: true } };
    state.tasks.at(-1).discoveryProvider = "";state.tasks.at(-1).pdfHost = "";state.tasks.at(-1).source = "publisher";
    state.tasks.at(-2).pdfHost = "https://user:secret@example.org/file?token=hidden";
    let emit, articleCreations = 0, elementCreations = 0, subscribers = 0;
    const create = pane.document.createElementNS.bind(pane.document);
    pane.document.createElementNS = (...args) => { elementCreations++;if (args[1] === "article") articleCreations++;return create(...args); };
    const actions = [];
    const api = { getSnapshot: () => structuredClone(state), subscribe: fn => { emit = fn;subscribers++;return () => subscribers--; }, localize: target => i18n.apply(target, state.settings.language),
      copyText: async value => actions.push(["copy", value]), openMessage: async id => actions.push(["message", id]),
      saveSettings: async value => { Object.assign(state.settings, value);emit(); },
      requestAssist: async ids => { actions.push(["assist", [...ids]]);return { accepted: ids.length, skipped: 0 }; } };
    pane.window.Zotero = { FulltextAssistant: api };
    const isolated = { window: pane.window, document: pane.document, Zotero: pane.window.Zotero, URL, Date };
    vm.runInNewContext(script, isolated);
    const choose = (id, value) => { const field = node(id);for (const option of field.querySelectorAll("option")) option.selected = false;field.querySelector('option[value="' + value + '"]').selected = true;field.dispatchEvent(new pane.window.Event("change")); };
    const search = async (kind, value) => { node("fta-pref-" + kind + "-search").value = value;node("fta-pref-" + kind + "-search").dispatchEvent(new pane.window.Event("input"));await new Promise(resolve => setTimeout(resolve, 140)); };
    const filter = value => node("fta-pref-task-filters").querySelector('[data-filter="' + value + '"]').click();
    const selectPage = value => node("fta-pref-tab-" + value).click();
    assert.equal(rows("message").length, 0, "the hidden message tab is not mounted on task updates");
    filter("all");
    assert.equal(rows("task").length, 25);
    assert.equal(node("fta-pref-task-count").textContent, "10037", "history totals are not reduced to the page size");
    assert.match(node("fta-pref-task-page-status").textContent, /1\/402.*1–25 \/ 10037/);
    assert.equal(rows("task")[0].dataset.taskId, "large-10036", "completion order applies across the entire history");
    assert.match(rows("task")[0].textContent, /来源：出版社网页/, "legacy sources remain readable");
    assert.doesNotMatch(rows("task")[1].textContent, /user:secret|token=hidden|PDF：https/, "a malformed host cannot disclose URL credentials");
    assert.match(rows("task")[2].textContent, /发现来源：OpenAlex.*PDF：repository\.example\.org/);
    assert.ok(node("fta-pref-request-target").querySelectorAll("option").length <= 51, "the association picker is also bounded");
    const unchanged = rows("task")[2], association = node("fta-pref-request-target").firstChild;
    node("fta-preferences").scrollTop = 420;node("fta-pref-username").value = "draft-account";node("fta-pref-username").dispatchEvent(new pane.window.Event("input"));
    articleCreations = 0;elementCreations = 0;
    for (let index = 0; index < 5; index++) { state.updateStatus.progress = { percent: index };emit(); }
    assert.equal(articleCreations, 0);assert.equal(elementCreations, 0, "unchanged snapshots do not rebuild list rows or option lists");
    assert.equal(rows("task")[2], unchanged);assert.equal(node("fta-pref-request-target").firstChild, association);
    assert.equal(node("fta-preferences").scrollTop, 420);assert.equal(node("fta-pref-username").value, "draft-account");
    state.tasks.at(-1).title = "Changed visible article";articleCreations = 0;emit();
    assert.equal(articleCreations, 1, "one changed task rebuilds only its own visible row");assert.equal(rows("task")[2], unchanged);
    node("fta-pref-task-next").click();assert.match(node("fta-pref-task-page-status").textContent, /2\/402.*26–50/);
    assert.equal(rows("task")[0].dataset.taskId, "large-10011");
    choose("fta-pref-task-page-size", "50");assert.equal(rows("task").length, 50);assert.match(node("fta-pref-task-page-status").textContent, /1\/201/);
    await search("task", "10.9999/9999");assert.equal(rows("task").length, 1);assert.equal(rows("task")[0].dataset.taskId, "large-9999", "search includes off-page history");
    assert.equal(state.tasks.length, 10037);
    await search("task", "no-such-article");assert.equal(rows("task").length, 0);assert.match(node("fta-pref-task-empty").textContent, /没有匹配/);
    await search("task", "");
    selectPage("messages");assert.equal(rows("message").length, 25);assert.match(node("fta-pref-message-page-status").textContent, /1\/9.*203/);
    const messageRow = rows("message")[0], hiddenTaskRow = rows("task")[0];articleCreations = 0;
    state.tasks.at(-1).title = "Changed while tasks hidden";emit();
    assert.equal(rows("task")[0], hiddenTaskRow);assert.equal(rows("message")[0], messageRow);assert.equal(articleCreations, 0, "hidden task changes do not rebuild either list");
    for (let index = 0; index < 8; index++) node("fta-pref-message-next").click();
    assert.equal(rows("message").length, 3);assert.equal(rows("message")[0].dataset.messageId, "message-200", "messages beyond the old 30-item cutoff remain reachable");
    await search("message", "needle");assert.equal(rows("message").length, 1);assert.equal(rows("message")[0].dataset.messageId, "message-200");
    rows("message")[0].querySelector("button").click();await flush();assert.deepEqual(actions.at(-1), ["message", "message-200"]);
    await search("message", "");choose("fta-pref-message-filter", "unread");assert.match(node("fta-pref-message-page-status").textContent, /102/);
    choose("fta-pref-message-page-size", "50");assert.equal(rows("message").length, 50);
    choose("fta-pref-message-filter", "read");assert.match(node("fta-pref-message-page-status").textContent, /101/);
    state.settings.language = "en";emit();assert.match(node("fta-pref-message-page-status").textContent, /Page 1\/3.*1–50 of 101/);
    assert.equal(node("fta-pref-update-details").querySelector("summary").textContent, "Release notes");
    assert.equal(node("fta-pref-version").parentElement, node("fta-pref-update-state").parentElement, "status and version share one inline group");
    state.settings.language = "zh-TW";emit();assert.equal(node("fta-pref-message-search").placeholder, "搜尋訊息標題或內容");
    assert.match(node("fta-pref-message-page-status").textContent, /第 1\/3 頁/);
    state.settings.language = "zh-CN";emit();selectPage("tasks");assert.match(rows("task")[0].textContent, /Changed while tasks hidden/);
    const retainedMessages = rows("message")[0];articleCreations = 0;state.messages[1].title = "Hidden message update";emit();
    assert.equal(rows("message")[0], retainedMessages);assert.equal(articleCreations, 0, "hidden message changes do not rebuild the task list");
    node("fta-pref-request-search").value = "10.9999/8000";node("fta-pref-request-search").dispatchEvent(new pane.window.Event("input"));
    assert.equal(node("fta-pref-request-target").querySelectorAll("option").length, 2, "the bounded association picker can find a distant item");
    assert.ok(node("fta-pref-request-target").querySelector('option[value="large-8000"]'));
    state.tasks = Array.from({ length: 62 }, (_, index) => ({ id: "pending-" + index, itemID: index + 1, state: "not_found", title: "Pending " + index, doi: "10.9998/" + index }));emit();filter("unfinished");choose("fta-pref-task-page-size", "25");
    const selectCurrent = () => { node("fta-pref-select-tasks").checked = true;node("fta-pref-select-tasks").dispatchEvent(new pane.window.Event("change")); };
    selectCurrent();assert.match(node("fta-pref-selection-summary").textContent, /已选 25 篇/);
    node("fta-pref-task-next").click();assert.equal(node("fta-pref-select-tasks").checked, false);selectCurrent();assert.match(node("fta-pref-selection-summary").textContent, /已选 50 篇/);
    node("fta-pref-bulk-assist").click();await flush();assert.equal(actions.at(-1)[1].length, 50);assert.equal(new Set(actions.at(-1)[1]).size, 50, "the action submits only explicit selections, including prior pages");
    selectCurrent();await search("task", "Pending 61");assert.match(node("fta-pref-selection-summary").textContent, /未选择文献/, "searching clears paid-action selection");
    assert.equal(rows("task").length, 1);
    await search("task", "");node("fta-pref-task-next").click();node("fta-pref-task-next").click();assert.equal(rows("task").length, 12);
    state.tasks = state.tasks.slice(0, 3);emit();assert.equal(rows("task").length, 3);assert.match(node("fta-pref-task-page-status").textContent, /1\/1/, "shrinking results clamp to an available page");
    selectPage("messages");assert.match(rows("message")[0].textContent, /Hidden message update/);
    node("fta-pref-message-search").value = "pending timer";node("fta-pref-message-search").dispatchEvent(new pane.window.Event("input"));
    isolated.FulltextPreferences.destroy();assert.equal(subscribers, 0);articleCreations = 0;await new Promise(resolve => setTimeout(resolve, 140));assert.equal(articleCreations, 0, "unmount cancels a pending search refresh");
  }
  // Rejected asynchronous opening checks are caught inside a separate pane.
  {
    const failedPane = parseHTML("<html><body>" + markup + "</body></html>");let failedOpens = 0;
    const failedApp = { getSnapshot: () => ({ settings: {}, session: { status: "signed_out" }, tasks: [], messages: [] }), localize: node => i18n.apply(node, "zh-CN"), subscribe: () => () => {}, preferencesOpened: async () => { failedOpens++;throw new Error("签到状态检查未完成，可点击刷新重试。"); } };
    failedPane.window.Zotero = { FulltextAssistant: failedApp };
    const failedContext = { window: failedPane.window, document: failedPane.document, Zotero: failedPane.window.Zotero, Date };
    vm.runInNewContext(script, failedContext);await flush();
    failedContext.FulltextPreferences.mount(failedPane.document.getElementById("fta-preferences"));await flush();
    assert.equal(failedOpens, 1);
    assert.equal(failedPane.document.getElementById("fta-pref-checkin-message").dataset.error, "true");
    assert.match(failedPane.document.getElementById("fta-pref-checkin-message").textContent, /可点击刷新重试/);
    failedContext.FulltextPreferences.destroy();
  }
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
  const checkInSite = await siteControls("checkin");
  assert.equal(checkInSite.get("ft-read").textContent, "刷新签到状态");
  checkInSite.setLanguage("en");await flush();
  assert.equal(checkInSite.get("ft-read").textContent, "Refresh check-in status");
  checkInSite.get("ft-read").click();await flush();
  assert.match(checkInSite.get("ft-status").textContent, /View the balance and reward in AbleSci settings/);
  checkInSite.setLanguage("zh-TW");await flush();assert.equal(checkInSite.get("ft-read").textContent, "刷新簽到狀態");
  checkInSite.close();assert.equal(checkInSite.languageSubscriptions(), 0);
  console.log("Preferences tests passed: batch scopes and exclusive filters, completed history, three-language UI and browser chrome, preserved drafts and metadata, title/DOI copy, download diagnosis and explicit review, institutional confirmation/undo, source credentials and quota consent, template validation, native update controls, existing task workflows and cleanup.");
})().catch(error => { console.error(error); process.exitCode = 1; });
