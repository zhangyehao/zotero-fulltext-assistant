"use strict";
const fs = require("node:fs");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = require("node:path");
const { parseHTML } = require("linkedom");
const source = fs.readFileSync(path.join(__dirname, "preferences.xhtml"), "utf8");
const script = fs.readFileSync(path.join(__dirname, "prefs.js"), "utf8");
new vm.Script(script);
const { document, window } = parseHTML("<html><body><div id='preference-container'></div></body></html>");
let renderListener;
let subscriptions = 0;
const calls = [];
const model = {
  version: "0.2.0", settings: { points: 10, pollSeconds: 60, autoDownload: true },
  session: { status: "signed_out", username: "", hasSavedPassword: false, message: "尚未登录" },
  tasks: [], messages: [], messagesStatus: { state: "idle" }
};
const app = {
  getSnapshot: () => structuredClone(model),
  subscribe: fn => { renderListener = fn; subscriptions++; return () => { subscriptions--; }; },
  saveCredentialsAndLogin: async account => {
    calls.push(["login", { ...account }]);
    model.session = { status: "pending_login", username: account.username, hasSavedPassword: true, message: "请在网页完成登录" };
    renderListener();
  },
  openLogin: async () => calls.push(["web"]),
  logout: async () => { calls.push(["logout"]); model.session.status = "signed_out"; renderListener(); },
  saveSettings: async settings => { calls.push(["save", { ...settings }]); model.settings = { ...settings }; renderListener(); },
  checkTask: async id => calls.push(["check", id]),
  openRequest: async id => calls.push(["open", id]),
  pauseTask: async id => { calls.push(["pause", id]); model.tasks.find(task => task.id === id).state = "paused"; renderListener(); },
  retryTask: async (id, options) => { calls.push(["retry", id, options ? { ...options } : null]); const task = model.tasks.find(task => task.id === id); task.state = "waiting"; if (options?.points) task.requestedPoints = options.points; renderListener(); },
  requestAssist: async (ids, options) => {
    const requested = Array.from(ids);
    calls.push(["assist", requested, options ? { ...options } : null]);
    const acceptedIDs = [], skippedIDs = [];
    for (const id of requested) {
      const task = model.tasks.find(value => value.id === id);
      if (!task?.doi || task.requestID || task.requestURL || task.attachmentID || !["not_found", "needs_login", "pending_login", "paused", "error"].includes(task.state)) { skippedIDs.push(id); continue; }
      task.state = "submitting";
      if (options?.points) task.requestedPoints = options.points;
      acceptedIDs.push(id);
    }
    renderListener();
    return { accepted: acceptedIDs.length, skipped: skippedIDs.length, acceptedIDs, skippedIDs };
  },
  downloadTask: async id => { calls.push(["download", id]); const task = model.tasks.find(value => value.id === id); task.state = "imported"; task.attachmentID = 100; renderListener(); },
  addExistingRequest: async (url, target) => calls.push(["add", url, target]),
  refreshMessages: async () => { calls.push(["messages"]); model.messagesStatus = { state: "loaded" }; renderListener(); },
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
const flush = () => new Promise(resolve => setImmediate(resolve));
const submit = id => get(id).dispatchEvent(new window.Event("submit", { cancelable: true }));
const input = (id, value) => { get(id).value = value; get(id).dispatchEvent(new window.Event("input")); };
const rowButton = label => [...get("fta-pref-task-list").querySelectorAll("button")].find(b => b.textContent === label);
const assistButton = () => [...get("fta-pref-task-list").querySelectorAll("button")].find(b => b.textContent.startsWith("科研通求助"));
const filterButton = filter => get("fta-pref-task-filters").querySelector('[data-filter="' + filter + '"]');
const taskCheckbox = id => get("fta-pref-task-list").querySelector('[data-task-id="' + id + '"] input[type="checkbox"]');
const changeChecked = (node, checked) => { node.checked = checked; node.dispatchEvent(new window.Event("change")); };
const chooseTarget = id => {
  const select = get("fta-pref-request-target");
  for (const option of select.querySelectorAll("option")) option.removeAttribute("selected");
  select.querySelector('option[value="' + id + '"]').setAttribute("selected", "selected");
  select.dispatchEvent(new window.Event("change"));
};
(async () => {
  assert.equal(get("fta-pref-task-count").textContent, "0");
  assert.equal(get("fta-pref-task-empty").hidden, false);
  assert.equal(get("fta-pref-account-state").textContent, "未登录");
  assert.equal(get("fta-pref-auto-download").checked, true);
  assert.equal(root.textContent.includes("QxRqAb"), false);
  assert.equal(root.textContent.includes("打开全文助手"), false);
  assert.match(root.textContent, /在文库多选文献/);
  assert.match(root.textContent, /全文助手：批量获取全文/);
  assert.equal(get("fta-pref-poll").getAttribute("max"), "3600");
  assert.equal(get("fta-pref-bulk-assist").disabled, true);
  assert.equal(get("fta-pref-select-tasks").disabled, true);
  assert.equal(get("fta-pref-save-login").textContent, "保存并打开登录");
  submit("fta-pref-account-form"); await flush();
  assert.equal(calls.filter(c => c[0] === "login").length, 0);
  input("fta-pref-username", "tester@example.invalid");
  input("fta-pref-password", "test-only-secret");
  submit("fta-pref-account-form");
  assert.equal(get("fta-pref-password").value, "", "password cleared immediately before login call");
  await flush();
  assert.equal(calls[0][1].username, "tester@example.invalid");
  assert.equal(calls[0][1].password, "test-only-secret");
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
  renderListener();
  assert.equal(get("fta-pref-points").value, "25", "dirty input survives state update");
  submit("fta-pref-settings-form"); await flush();
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
  model.tasks = [{ id: "t1", title: "<img src=x onerror=bad> paper", doi: "10.1234/test", state: "waiting", requestURL: "https://www.ablesci.com/assist/detail?id=EXAMPLE", requestedPoints: 25 }];
  renderListener();
  assert.equal(get("fta-pref-task-list").querySelector("img"), null);
  assert.match(get("fta-pref-task-list").textContent, /等待应助/);
  rowButton("立即检查").click(); await flush();
  rowButton("打开").click(); await flush();
  rowButton("暂停").click(); await flush();
  assert.equal(model.tasks[0].state, "paused");
  rowButton("重试").click(); await flush();
  assert.equal(model.tasks[0].state, "waiting");
  assert.deepEqual(calls.at(-1), ["retry", "t1", null], "remote request retries never override the published budget");
  assert.equal(assistButton(), undefined, "an existing request must never expose duplicate fallback submission");
  app.openTask = async id => calls.push(["openTask", id]);
  model.tasks = [
    { id: "batch-1", title: "已找到的文献", state: "imported", attachmentID: 42 },
    { id: "batch-2", title: "未找到的文献", doi: "10.1234/missing", state: "not_found" },
    { id: "batch-3", title: "需机构登录的文献", doi: "10.1234/login", state: "needs_login" },
    { id: "batch-4", title: "仍在查找的文献", state: "resolving" }
  ];
  renderListener();
  assert.equal(get("fta-pref-task-count").textContent, "4");
  assert.equal(get("fta-pref-task-summary").textContent, "1 项进行中");
  for (const label of ["已获取", "未找到全文", "需网页登录", "正在获取"]) assert.ok(get("fta-pref-task-list").textContent.includes(label), label);
  assert.equal([...get("fta-pref-task-list").querySelectorAll("button")].filter(b => b.textContent.startsWith("科研通求助")).length, 2);
  rowButton("打开全文").click(); await flush();
  assert.deepEqual(calls.at(-1), ["openTask", "batch-1"]);
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
  assert.equal(filterButton("fallback").textContent, "待兜底 5");
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
  assert.equal(get("fta-pref-task-list").children.length, 5);
  assert.equal(taskCheckbox("select-5").disabled, true, "missing DOI is visible but cannot be submitted");
  assert.equal(taskCheckbox("select-6"), null, "a request ID alone prevents duplicate fallback");
  assert.equal(taskCheckbox("select-7"), null, "uncertain submissions cannot be selected");
  changeChecked(get("fta-pref-select-tasks"), true);
  assert.match(get("fta-pref-selection-summary").textContent, /已选 4 篇 · 本次悬赏合计 100 积分/, "explicit action uses the saved current default, not old task budgets");
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
  filterButton("all").click();
  model.settings.points = 35;
  model.tasks = [{ id: "retry-budget", title: "原预算不足", state: "error", requestedPoints: 10, doi: "10.1234/low-budget", itemID: 76 }];
  renderListener();
  assert.equal(assistButton().textContent, "科研通求助（35 积分）");
  rowButton("按 35 积分重试").click(); await flush();
  assert.deepEqual(calls.at(-1), ["retry", "retry-budget", { points: 35 }]);
  assert.equal(model.tasks[0].requestedPoints, 35);
  model.settings.autoDownload = false;
  model.tasks = [{ id: "manual-file", title: "可手动下载", state: "available", itemID: 77, requestID: "FileReady", requestURL: "https://www.ablesci.com/assist/detail?id=FileReady" }];
  renderListener();
  assert.equal(rowButton("下载到文库").disabled, false, "manual download stays available when automatic download is off");
  rowButton("下载到文库").click(); await flush();
  assert.equal(model.tasks[0].state, "imported");
  assert.deepEqual(calls.at(-1), ["download", "manual-file"]);
  assert.equal(rowButton("下载到文库"), undefined);
  model.messages = [{ id: "m1", title: "应助提醒", text: "<script>secret</script>", read: false, createdAt: "2026-11-04T12:00:00Z" }];
  renderListener();
  assert.equal(get("fta-pref-message-count").textContent, "1");
  assert.equal(get("fta-pref-message-list").querySelector("script"), null);
  get("fta-pref-message-list").querySelector("button").click(); await flush();
  get("fta-pref-refresh-messages").click(); await flush();
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
  for (const method of ["check", "open", "openTask", "assist", "download", "pause", "retry", "message", "messages", "add", "web", "logout"]) assert.ok(calls.some(c => c[0] === method), method);
  const ids = [...root.querySelectorAll("[id]")].map(node => node.id);
  assert.equal(ids.length, new Set(ids).size);
  context.FulltextPreferences.destroy();
  assert.equal(subscriptions, 0);
  console.log("Preferences tests passed: embedded mount, credentials, 60–3600-second settings, result filters, batch fallback selection, stale-state handling, manual download, safe text, cleanup.");
})().catch(error => { console.error(error); process.exitCode = 1; });
