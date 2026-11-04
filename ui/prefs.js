/* global window, document, Zotero */
(function () {
  "use strict";
  const ROOT_ID = "fta-preferences";
  let cleanup = null;
  function mount(root) {
    if (!root || root.dataset.fulltextMounted === "true") return;
    const app = window.Zotero?.FulltextAssistant || (typeof Zotero !== "undefined" && Zotero.FulltextAssistant);
    const $ = id => root.querySelector("#" + id);
    if (!app || typeof app.getSnapshot !== "function") {
      $("fta-pref-status").textContent = "全文助手尚未初始化。请重启 Zotero 后再试。";
      $("fta-pref-status").dataset.error = "true";
      return;
    }
    root.dataset.fulltextMounted = "true";
    let snapshot = {};
    let busy = false;
    let settingsDirty = false;
    let accountDirty = false;
    let destroyed = false;
    let taskFilter = "all";
    let requestTarget = "";
    const selectedTasks = new Set();
    const bindings = [];
    const taskLabels = {
      queued: "排队中", pending: "排队中", finding: "查找全文", searching: "查找全文", resolving: "正在获取",
      not_found: "未找到全文", needs_login: "需网页登录",
      checking_account: "检查账号", submitting: "正在求助", submission_unknown: "提交待核实",
      pending_login: "需要登录", ready_to_check: "待检查", waiting: "等待应助",
      available: "文件可下载", downloading: "正在下载", validating: "校验文件",
      needs_review: "需要核对", paused: "已暂停", imported: "已获取", completed: "已获取",
      error: "需要处理", failed: "需要处理", captcha: "需要验证", closed: "求助已关闭"
    };
    const accountLabels = { authenticated: "已登录", logged_in: "已登录", signed_out: "未登录", logged_out: "未登录", pending_login: "需要登录", expired: "登录已过期", checking: "正在登录", logging_in: "正在登录", captcha: "需要验证", error: "登录失败", unknown: "待验证", unverified: "待验证" };
    const filterLabels = { all: "全部", success: "已获取", login: "需网页登录", fallback: "待兜底", active: "进行中" };
    const currentTasks = () => Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
    const currentPoints = () => Number.isSafeInteger(snapshot.settings?.points) && snapshot.settings.points >= 1 && snapshot.settings.points <= 10000 ? snapshot.settings.points : 10;
    const isFallback = task => !task.requestURL && !task.requestID && !task.attachmentID && ["not_found", "needs_login", "pending_login", "paused", "error"].includes(task.state);
    const canAssist = task => isFallback(task) && Boolean(String(task.doi || "").trim());
    function matchesFilter(task, filter) {
      if (filter === "success") return ["imported", "completed"].includes(task.state);
      if (filter === "login") return ["needs_login", "pending_login", "captcha"].includes(task.state);
      if (filter === "fallback") return isFallback(task);
      if (filter === "active") return ["waiting", "submitting", "downloading", "queued", "finding", "searching", "resolving", "checking_account", "validating", "ready_to_check"].includes(task.state);
      return true;
    }
    function on(node, name, handler) { node.addEventListener(name, handler); bindings.push(() => node.removeEventListener(name, handler)); }
    function status(message, error = false, target = "fta-pref-status") {
      $(target).textContent = String(message || "");
      $(target).dataset.error = String(error);
    }
    function dateText(value) {
      if (!value) return "";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
    }
    function make(name, className, text) {
      const node = document.createElementNS("http://www.w3.org/1999/xhtml", name);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = String(text);
      return node;
    }
    function button(label, method, args, disabled = false, success = "") {
      const node = make("button", "", label);
      node.type = "button";
      node.disabled = busy || disabled || typeof app[method] !== "function";
      node.addEventListener("click", () => run(() => app[method](...args), success));
      return node;
    }
    function assistMessage(result) {
      if (!Number.isSafeInteger(result?.accepted)) return "已转入科研通求助流程，进度见任务列表。";
      const accepted = result.accepted;
      const skipped = Number.isSafeInteger(result.skipped) ? result.skipped : 0;
      return (accepted ? "已将 " + accepted + " 篇转入科研通求助流程。" : "没有新增求助任务。") + (skipped ? "已跳过 " + skipped + " 项，请查看当前任务状态。" : "进度见任务列表。");
    }
    function renderSelection() {
      const eligible = currentTasks().filter(task => matchesFilter(task, taskFilter) && canAssist(task));
      const selected = eligible.filter(task => selectedTasks.has(task.id));
      const all = $("fta-pref-select-tasks");
      all.disabled = busy || !eligible.length || typeof app.requestAssist !== "function";
      all.checked = eligible.length > 0 && selected.length === eligible.length;
      all.indeterminate = selected.length > 0 && selected.length < eligible.length;
      const action = $("fta-pref-bulk-assist");
      action.disabled = busy || !selected.length || typeof app.requestAssist !== "function";
      action.textContent = (selected.length ? "为所选 " + selected.length + " 篇发起科研通求助" : "为所选文献发起科研通求助") + "（每篇 " + currentPoints() + " 积分）";
      const totalPoints = selected.length * currentPoints();
      $("fta-pref-selection-summary").textContent = selected.length ? "已选 " + selected.length + " 篇 · 本次悬赏合计 " + totalPoints + " 积分" : "未选择文献";
    }
    function renderRequestTargets() {
      const available = currentTasks().filter(task => task.itemID && !task.requestID && !task.requestURL);
      if (requestTarget && !available.some(task => task.id === requestTarget)) requestTarget = "";
      const select = $("fta-pref-request-target");
      select.replaceChildren();
      const unbound = make("option", "", "只跟踪，不关联文献");
      unbound.value = "";
      unbound.selected = !requestTarget;
      select.append(unbound);
      for (const task of available) {
        const name = task.title || task.doi || "未命名文献";
        const option = make("option", "", name + (task.doi && task.doi !== name ? " — " + task.doi : ""));
        option.value = task.id;
        option.selected = task.id === requestTarget;
        select.append(option);
      }
    }
    function renderTasks() {
      const tasks = currentTasks();
      const visible = tasks.filter(task => matchesFilter(task, taskFilter));
      const eligibleIDs = new Set(visible.filter(canAssist).map(task => task.id));
      for (const id of selectedTasks) if (!eligibleIDs.has(id)) selectedTasks.delete(id);
      const list = $("fta-pref-task-list");
      list.replaceChildren();
      $("fta-pref-task-count").textContent = String(tasks.length);
      $("fta-pref-task-empty").hidden = visible.length > 0;
      $("fta-pref-task-empty").textContent = tasks.length ? "当前筛选没有任务。" : "还没有任务。在文库多选文献，右击“全文助手：批量获取全文”开始批量获取。";
      const waiting = tasks.filter(task => matchesFilter(task, "active")).length;
      $("fta-pref-task-summary").textContent = (waiting ? waiting + " 项进行中" : "") + (taskFilter !== "all" ? (waiting ? " · " : "") + "显示 " + visible.length + "/" + tasks.length + " 项" : "");
      for (const node of $("fta-pref-task-filters").querySelectorAll("button")) {
        const filter = node.dataset.filter;
        node.textContent = filterLabels[filter] + " " + tasks.filter(task => matchesFilter(task, filter)).length;
        node.setAttribute("aria-pressed", String(filter === taskFilter));
        node.disabled = busy;
      }
      for (const task of visible) {
        const row = make("article", "fta-row");
        row.dataset.taskId = String(task.id);
        const main = make("div", "fta-row-main");
        if (isFallback(task)) {
          const checkbox = make("input", "fta-task-select");
          checkbox.type = "checkbox";
          checkbox.checked = selectedTasks.has(task.id);
          checkbox.disabled = busy || !canAssist(task) || typeof app.requestAssist !== "function";
          checkbox.setAttribute("aria-label", "选择文献：" + (task.title || task.doi || "未命名文献"));
          if (!canAssist(task)) checkbox.title = "请先在原文献条目补全 DOI";
          checkbox.addEventListener("change", () => {
            if (busy || checkbox.disabled) return;
            if (checkbox.checked) selectedTasks.add(task.id); else selectedTasks.delete(task.id);
            renderSelection();
          });
          main.append(checkbox);
        }
        main.append(make("div", "fta-row-title", task.title || task.doi || "未命名文献"));
        const badge = make("span", "fta-status-badge", taskLabels[task.state] || "待处理");
        if (["imported", "completed"].includes(task.state)) badge.dataset.tone = "success";
        if (["error", "failed"].includes(task.state)) badge.dataset.tone = "error";
        if (["pending_login", "needs_login", "not_found", "needs_review", "captcha", "submission_unknown"].includes(task.state)) badge.dataset.tone = "warning";
        main.append(badge);
        row.append(main);
        const meta = [task.doi, task.requestID ? "求助 " + task.requestID : "", task.requestedPoints ? task.requestedPoints + " 积分" : "", task.lastCheckedAt ? "最近检查 " + dateText(task.lastCheckedAt) : ""].filter(Boolean);
        if (meta.length) row.append(make("div", "fta-row-meta", meta.join(" · ")));
        const note = task.message || task.lastError;
        if (note) row.append(make("p", "fta-row-note", note));
        const actions = make("div", "fta-row-actions");
        const done = ["imported", "completed", "closed"].includes(task.state);
        actions.append(button("立即检查", "checkTask", [task.id], done));
        if (task.state === "available" && task.itemID) actions.append(button("下载到文库", "downloadTask", [task.id], false, "下载结果已更新。"));
        const openMethod = typeof app.openTask === "function" ? "openTask" : "openRequest";
        const canOpen = openMethod === "openTask" ? Boolean(task.attachmentID || task.requestURL || task.officialURL || task.doi) : Boolean(task.requestURL);
        actions.append(button(task.attachmentID ? "打开全文" : task.requestURL ? "打开" : "打开网页", openMethod, [task.id], !canOpen));
        if (["paused", "error", "failed", "not_found", "needs_login", "pending_login", "needs_review"].includes(task.state)) {
          const unsubmitted = !task.requestID && !task.requestURL;
          actions.append(button(unsubmitted ? "按 " + currentPoints() + " 积分重试" : "重试", "retryTask", unsubmitted ? [task.id, { points: currentPoints() }] : [task.id], false, "任务已恢复。"));
        }
        else actions.append(button("暂停", "pauseTask", [task.id], done, task.requestURL ? "已暂停本地检查，网站上的求助仍然保留。" : "任务已暂停。"));
        if (isFallback(task)) {
          actions.append(button("科研通求助（" + currentPoints() + " 积分）", "requestAssist", [[task.id], { points: currentPoints() }], !canAssist(task), assistMessage));
          if (!canAssist(task)) actions.append(make("span", "fta-secondary", "补全 DOI 后可求助"));
        }
        row.append(actions);
        list.append(row);
      }
      renderSelection();
    }
    function renderMessages() {
      const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
      const info = snapshot.messagesStatus || {};
      const list = $("fta-pref-message-list");
      list.replaceChildren();
      $("fta-pref-message-count").textContent = String(messages.filter(message => !message.read).length);
      $("fta-pref-message-empty").hidden = messages.length > 0;
      $("fta-pref-message-empty").textContent = info.state === "loaded" ? "暂无消息。" : "尚未读取科研通消息。";
      $("fta-pref-messages-state").textContent = String(info.message || (info.state === "loading" ? "正在刷新消息…" : info.lastCheckedAt ? "最近刷新 " + dateText(info.lastCheckedAt) : "登录后可查看科研通应助提醒。"));
      $("fta-pref-messages-state").dataset.error = String(info.state === "error");
      for (const message of messages.slice(0, 30)) {
        const row = make("article", "fta-row");
        const main = make("div", "fta-row-main");
        main.append(make("div", "fta-row-title", message.title || "科研通消息"));
        main.append(make("span", "fta-row-meta", dateText(message.createdAt)));
        row.append(main);
        const summary = String(message.text || message.summary || "").trim();
        if (summary) row.append(make("p", "fta-message-summary", summary.slice(0, 220) + (summary.length > 220 ? "…" : "")));
        const actions = make("div", "fta-row-actions");
        actions.append(button("查看", "openMessage", [message.id]));
        row.append(actions);
        list.append(row);
      }
    }
    function render() {
      if (destroyed) return;
      snapshot = app.getSnapshot() || {};
      const session = snapshot.session || {};
      const settings = snapshot.settings || {};
      $("fta-pref-version").textContent = snapshot.version ? "v" + snapshot.version : "";
      $("fta-pref-account-state").textContent = accountLabels[session.status] || "待验证";
      $("fta-pref-account-state").dataset.tone = ["authenticated", "logged_in"].includes(session.status) ? "success" : ["captcha", "expired", "pending_login"].includes(session.status) ? "warning" : "";
      const boundName = ["authenticated", "logged_in"].includes(session.status) ? String(session.displayName || "").trim() : "";
      $("fta-pref-account-identity").hidden = !boundName;
      $("fta-pref-account-identity").textContent = boundName ? "当前绑定：" + boundName : "";
      $("fta-pref-account-message").textContent = String(session.message || "登录后可发起求助、查看应助进度并下载文件。");
      if (!accountDirty) $("fta-pref-username").value = session.username || "";
      $("fta-pref-password").placeholder = session.hasSavedPassword ? "已保存密码；留空使用已保存的密码" : "输入密码";
      if (!settingsDirty) {
        $("fta-pref-points").value = String(settings.points ?? 10);
        $("fta-pref-poll").value = String(settings.pollSeconds ?? 60);
        $("fta-pref-auto-download").checked = settings.autoDownload !== false;
      }
      renderTasks();
      renderRequestTargets();
      renderMessages();
      const methodButtons = { "fta-pref-save-login": "saveCredentialsAndLogin", "fta-pref-web-login": "openLogin", "fta-pref-logout": "logout", "fta-pref-save-settings": "saveSettings", "fta-pref-add-request": "addExistingRequest", "fta-pref-refresh-messages": "refreshMessages" };
      for (const [id, method] of Object.entries(methodButtons)) $(id).disabled = busy || typeof app[method] !== "function";
      for (const id of ["fta-pref-username", "fta-pref-password", "fta-pref-points", "fta-pref-poll", "fta-pref-auto-download", "fta-pref-request-url", "fta-pref-request-target"]) $(id).disabled = busy;
    }
    async function run(action, message = "", sensitive = false) {
      if (busy || destroyed) return;
      busy = true; render(); status("正在处理…");
      try { const result = await action(); if (!destroyed) status(typeof message === "function" ? message(result) : message || "已更新。"); return result; }
      catch (error) { if (!destroyed) status(sensitive ? "登录未完成，请检查账号密码或使用网页登录完成验证。" : error?.message || "操作未完成，请稍后再试。", true); }
      finally { busy = false; if (!destroyed) render(); }
    }
    on($("fta-pref-username"), "input", () => { accountDirty = true; });
    on($("fta-pref-password"), "input", () => { accountDirty = true; });
    on($("fta-pref-account-form"), "submit", event => {
      event.preventDefault();
      const username = $("fta-pref-username").value.trim();
      const password = $("fta-pref-password").value;
      const sameSavedAccount = snapshot.session?.hasSavedPassword && username === snapshot.session?.username;
      if (!username) return status("请填写科研通账号。", true);
      if (!password && !sameSavedAccount) return status("请填写密码，或使用网页登录。", true);
      $("fta-pref-password").value = "";
      run(async () => { await app.saveCredentialsAndLogin({ username, password }); accountDirty = false; }, "账号已保存，请在打开的科研通网页完成登录。", true);
    });
    on($("fta-pref-web-login"), "click", () => run(() => app.openLogin(), "请在科研通网页完成登录或验证。"));
    on($("fta-pref-logout"), "click", () => run(async () => { await app.logout(); $("fta-pref-password").value = ""; accountDirty = false; }, "已退出插件中的科研通登录。"));
    for (const id of ["fta-pref-points", "fta-pref-poll", "fta-pref-auto-download"]) on($(id), "input", () => { settingsDirty = true; status("有未保存的更改", false, "fta-pref-save-state"); });
    on($("fta-pref-settings-form"), "submit", event => {
      event.preventDefault();
      const points = Number($("fta-pref-points").value);
      const pollSeconds = Number($("fta-pref-poll").value);
      const autoDownload = $("fta-pref-auto-download").checked;
      if (!Number.isSafeInteger(points) || points < 1 || points > 10000) return status("悬赏积分必须是 1–10000 的整数。", true, "fta-pref-save-state");
      if (!Number.isSafeInteger(pollSeconds) || pollSeconds < 60 || pollSeconds > 3600) return status("检查间隔必须是 60–3600 秒的整数。", true, "fta-pref-save-state");
      run(async () => { await app.saveSettings({ points, pollSeconds, autoDownload }); settingsDirty = false; status("设置已保存", false, "fta-pref-save-state"); }, "设置已保存；已发布的求助未改变。");
    });
    on($("fta-pref-add-form"), "submit", event => {
      event.preventDefault();
      const url = $("fta-pref-request-url").value.trim();
      if (!url) return status("请填写自己的科研通求助详情页链接。", true);
      const target = requestTarget || null;
      run(async () => { await app.addExistingRequest(url, target); $("fta-pref-request-url").value = ""; requestTarget = ""; }, target ? "已将已有求助关联到所选文献，未发布新求助。" : "已添加求助跟踪，未关联文献，也未发布新求助。");
    });
    on($("fta-pref-request-target"), "change", () => { requestTarget = $("fta-pref-request-target").value || ""; });
    on($("fta-pref-refresh-messages"), "click", () => run(() => app.refreshMessages(), "消息已刷新。"));
    for (const node of $("fta-pref-task-filters").querySelectorAll("button")) on(node, "click", () => {
      if (busy) return;
      taskFilter = node.dataset.filter;
      selectedTasks.clear();
      renderTasks();
    });
    on($("fta-pref-select-tasks"), "change", () => {
      if (busy || $("fta-pref-select-tasks").disabled) return;
      const checked = $("fta-pref-select-tasks").checked;
      for (const task of currentTasks().filter(task => matchesFilter(task, taskFilter) && canAssist(task))) {
        if (checked) selectedTasks.add(task.id); else selectedTasks.delete(task.id);
      }
      renderTasks();
    });
    on($("fta-pref-bulk-assist"), "click", () => {
      const ids = currentTasks().filter(task => matchesFilter(task, taskFilter) && canAssist(task) && selectedTasks.has(task.id)).map(task => task.id);
      if (!ids.length || typeof app.requestAssist !== "function") return;
      const points = currentPoints();
      run(async () => {
        const result = await app.requestAssist(ids, { points });
        selectedTasks.clear();
        return result;
      }, assistMessage);
    });
    const unsubscribe = app.subscribe(render);
    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      $("fta-pref-password").value = "";
      if (typeof unsubscribe === "function") unsubscribe();
      for (const unbind of bindings) unbind();
      delete root.dataset.fulltextMounted;
    };
    cleanup = destroy;
    window.addEventListener("unload", destroy, { once: true });
    render();
  }
  window.addEventListener("load", event => { if (event.target?.id === ROOT_ID) mount(event.target); }, true);
  window.addEventListener("showing", event => { if (event.target?.id === ROOT_ID && !event.target.dataset.fulltextMounted) mount(event.target); }, true);
  const existing = document.getElementById(ROOT_ID);
  if (existing) mount(existing);
  this.FulltextPreferences = { mount, destroy: () => { if (cleanup) cleanup(); } };
}).call(this);
