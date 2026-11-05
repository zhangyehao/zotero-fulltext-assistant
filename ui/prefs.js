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
    let activePage = "tasks";
    let seenCaptureStamp = "";
    let taskFilter = "unfinished";
    let requestTarget = "";
    let bindingState = null;
    const selectedTasks = new Set();
    const bindings = [];
    const pageTabs = [...$("fta-pref-tabs").querySelectorAll('[role="tab"]')];
    const taskLabels = {
      queued: "排队中", pending: "排队中", finding: "查找全文", searching: "查找全文", resolving: "正在获取",
      not_found: "未找到全文", needs_login: "需网页登录",
      checking_account: "检查账号", submitting: "正在求助", submission_unknown: "提交待核实",
      pending_login: "需要登录", ready_to_check: "待检查", waiting: "等待应助",
      available: "文件可下载", downloading: "正在下载", validating: "校验文件",
      needs_review: "需要核对", paused: "已暂停", imported: "已获取", completed: "已获取",
      error: "需要处理", failed: "需要处理", captcha: "需要验证", closed: "求助已关闭",
      browser_waiting: "等待恢复", browser_scanning: "等待恢复", browser_downloading: "等待恢复",
      manual_waiting: "等待浏览器下载", manual_review: "待核对 PDF"
    };
    const accountLabels = { authenticated: "已登录", logged_in: "已登录", signed_out: "未登录", logged_out: "未登录", pending_login: "需要登录", expired: "登录已过期", checking: "正在登录", logging_in: "正在登录", captcha: "需要验证", error: "登录失败", unknown: "待验证", unverified: "待验证" };
    const filterLabels = { unfinished: "未完成", all: "全部历史", success: "已获取", login: "需网页登录", fallback: "待兜底", active: "进行中" };
    const sourceLabels = { publisher: "出版社网页", rendered_publisher: "出版社网页", open_access: "开放获取", existing: "已有附件", ablesci: "科研通", local_file: "本地 PDF", edge_browser: "Edge 浏览器", browser_download: "浏览器下载" };
    const browserNotes = {
      manual_waiting: "已开始检查下载文件夹。请在默认浏览器完成验证并点击 PDF 下载，保存到配置文件夹；明确匹配的新 PDF 会自动添加到原文献。",
      manual_review: "无法自动确认所选 PDF 的论文身份。请先预览并核对标题、作者和 DOI，再明确确认。",
      browser_waiting: "请通过默认浏览器下载全文，或发起科研通求助。",
      browser_scanning: "请通过默认浏览器下载全文，或发起科研通求助。",
      browser_downloading: "请通过默认浏览器下载全文，或发起科研通求助。"
    };
    const manualDownloadMessage = result => result?.alreadyImported
      ? "PDF 已保存到原文献，无需再次下载。可在“已获取”中打开全文。"
      : result?.watching === false
        ? "已打开默认浏览器，但下载文件夹检查尚未启动。请先添加下载文件夹，或点击“选择已下载的PDF”导入。"
        : "已在默认浏览器打开论文，并开始检查下载文件夹。请自行完成网站验证、点击 PDF 下载并保存到配置文件夹；明确匹配的新 PDF 会自动入库，插件不会代你操作浏览器。";
    const isBrowserActive = task => task.state === "manual_waiting";
    const isBrowserRoute = task => ["manual", "browser"].includes(task.acquisitionMode) || ["manual_waiting", "manual_review", "browser_waiting", "browser_scanning", "browser_downloading"].includes(task.state);
    const isAcquired = task => ["imported", "completed"].includes(task.state);
    const isAssistComplete = task => Boolean(task.assistReceipt && task.assistReceipt.adoption === "accepted" && task.assistReceipt.messages === "done" && !task.assistReceipt.needsReconcile);
    const needsAssistCompletion = task => isAcquired(task) && Boolean(task.assistReceipt) && !isAssistComplete(task);
    const currentTasks = () => Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
    const currentPoints = () => {
      const value = String($("fta-pref-points").value || "").trim();
      const points = /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
      return Number.isSafeInteger(points) && points <= 10000 ? points : null;
    };
    const pointsText = () => currentPoints() === null ? "请填写有效积分" : currentPoints() + " 积分";
    const isFallback = task => !task.requestURL && !task.requestID && !task.attachmentID && ["not_found", "needs_login", "pending_login", "paused", "error", "failed", "needs_review", "captcha", "manual_waiting", "manual_review", "browser_waiting", "browser_scanning", "browser_downloading"].includes(task.state);
    const canAssist = task => isFallback(task) && Boolean(String(task.doi || "").trim());
    function matchesFilter(task, filter) {
      if (filter === "unfinished") return !isAcquired(task) || needsAssistCompletion(task);
      if (filter === "success") return isAcquired(task);
      if (filter === "login") return ["needs_login", "pending_login", "captcha"].includes(task.state);
      if (filter === "fallback") return isFallback(task);
      if (filter === "active") return isBrowserActive(task) || ["waiting", "submitting", "downloading", "queued", "finding", "searching", "resolving", "checking_account", "validating", "ready_to_check"].includes(task.state);
      return true;
    }
    function on(node, name, handler) { node.addEventListener(name, handler); bindings.push(() => node.removeEventListener(name, handler)); }
    function renderNavigation() {
      root.dataset.activePage = activePage;
      for (const tab of pageTabs) {
        const selected = tab.dataset.page === activePage;
        tab.setAttribute("aria-selected", String(selected));
        tab.setAttribute("tabindex", selected ? "0" : "-1");
        $(tab.getAttribute("aria-controls")).hidden = !selected;
      }
      $("fta-pref-tab-settings").dataset.dirty = String(settingsDirty);
      $("fta-pref-tab-settings").setAttribute("aria-label", settingsDirty ? "下载设置，有未保存的更改" : "下载设置");
    }
    function selectPage(page, focus = false) {
      const tab = pageTabs.find(node => node.dataset.page === page);
      if (destroyed || !tab) return;
      activePage = page;
      renderNavigation();
      if (focus) {
        tab.focus();
        tab.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      }
    }
    function status(message, error = false, target = "fta-pref-status") {
      $(target).textContent = String(message || "");
      $(target).dataset.error = String(error);
    }
    function dateText(value, includeYear = false) {
      if (!value) return "";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { ...(includeYear ? { year: "numeric" } : {}), month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
    }
    function make(name, className, text) {
      const node = document.createElementNS("http://www.w3.org/1999/xhtml", name);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = String(text);
      return node;
    }
    function titleText(value) {
      // Strip only Zotero inline formatting. Never parse source markup; leave
      // unknown tags and mathematical comparisons/angle brackets as safe text.
      return String(value || "").replace(/<\/(?:i|b|em|strong|sub|sup|span)\s*>|<(?:i|b|em|strong|sub|sup|span)(?:\s+[a-z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/gi, "");
    }
    function button(label, method, args, disabled = false, success = "") {
      const node = make("button", "", label);
      node.type = "button";
      const budgetAction = ["requestAssist", "retryTask"].includes(method) && Object.prototype.hasOwnProperty.call(args[args.length - 1] || {}, "points");
      const points = budgetAction ? args[args.length - 1].points : null;
      node.disabled = busy || disabled || typeof app[method] !== "function" || budgetAction && (points === null || typeof app.saveSettings !== "function");
      node.addEventListener("click", () => {
        if (node.disabled) return;
        run(async () => {
          if (budgetAction) await saveActionPoints(points);
          return app[method](...args);
        }, success);
      });
      return node;
    }
    async function saveActionPoints(points) {
      if (points === null || !Number.isSafeInteger(points) || points < 1 || points > 10000) throw new Error("悬赏积分必须是 1–10000 的整数。");
      if (currentPoints() !== points) throw new Error("悬赏积分已变化，请核对更新后的按钮金额再操作。");
      await app.saveSettings({ points });
      const saved = app.getSnapshot()?.settings || {};
      settingsDirty = currentPoints() !== saved.points || Number($("fta-pref-poll").value) !== saved.pollSeconds || $("fta-pref-auto-download").checked !== (saved.autoDownload !== false);
      status(settingsDirty ? "求助积分已保存；其他设置仍有未保存的更改" : "设置已保存", false, "fta-pref-save-state");
    }
    function assistMessage(result) {
      if (!Number.isSafeInteger(result?.accepted)) return "已转入科研通求助流程，进度见任务列表。";
      const accepted = result.accepted;
      const skipped = Number.isSafeInteger(result.skipped) ? result.skipped : 0;
      return (accepted ? "已将 " + accepted + " 篇转入科研通求助流程。" : "没有新增求助任务。") + (skipped ? "已跳过 " + skipped + " 项，请查看当前任务状态。" : "进度见任务列表。");
    }
    function directoryPauseNote(result) {
      return Number.isSafeInteger(result?.paused) && result.paused > 0 ? " 已暂停 " + result.paused + " 个等待下载的任务；请点击各任务的“浏览器下载并自动入库”，按新目录重新开始检查。" : "";
    }
    function renderCaptureSummary() {
      const summary = snapshot.captureSummary;
      const stamp = summary?.id ?? summary?.at ?? "";
      if (stamp && stamp !== seenCaptureStamp) {
        seenCaptureStamp = stamp;
        selectPage("tasks");
      }
      const box = $("fta-pref-batch-summary");
      box.hidden = !summary;
      const message = summary ? String(summary.message || "本次选择已处理，结果见任务列表。") : "";
      const time = summary ? dateText(summary.at) : "";
      if ($("fta-pref-batch-message").textContent !== message) $("fta-pref-batch-message").textContent = message;
      if ($("fta-pref-batch-time").textContent !== time) $("fta-pref-batch-time").textContent = time;
      box.dataset.tone = Number(summary?.failed) > 0 ? "warning" : "";
    }
    function renderDirectories() {
      const list = $("fta-pref-download-directories");
      list.replaceChildren();
      const values = Array.isArray(snapshot.settings?.downloadDirectories) ? snapshot.settings.downloadDirectories : snapshot.settings?.downloadDirectory ? [snapshot.settings.downloadDirectory] : [];
      const directories = [...new Set(values.filter(value => typeof value === "string" && value.trim()))];
      if (!directories.length) list.append(make("p", "fta-note", "尚未配置下载文件夹，请添加浏览器保存 PDF 的位置。"));
      for (const directory of directories) {
        const row = make("div", "fta-actions fta-inline-field");
        const path = make("input");
        path.type = "text"; path.readOnly = true; path.value = directory; path.title = directory;
        path.setAttribute("aria-label", "下载文件夹路径");
        row.append(path, button("移除", "removeDownloadDirectory", [directory], false, result => (result?.changed === false ? "下载文件夹配置未改变。" : "已移除该下载文件夹。文件夹内的文件保持不变。") + directoryPauseNote(result)));
        list.append(row);
      }
    }
    function renderSelection() {
      const eligible = currentTasks().filter(task => matchesFilter(task, taskFilter) && canAssist(task));
      $("fta-pref-bulk-actions").hidden = !eligible.length;
      $("fta-pref-bulk-note").hidden = !eligible.length;
      const selected = eligible.filter(task => selectedTasks.has(task.id));
      const all = $("fta-pref-select-tasks");
      all.disabled = busy || !eligible.length || typeof app.requestAssist !== "function";
      all.checked = eligible.length > 0 && selected.length === eligible.length;
      all.indeterminate = selected.length > 0 && selected.length < eligible.length;
      const action = $("fta-pref-bulk-assist");
      const points = currentPoints();
      action.disabled = busy || !selected.length || points === null || typeof app.requestAssist !== "function" || typeof app.saveSettings !== "function";
      action.dataset.points = points === null ? "" : String(points);
      action.textContent = (selected.length ? "为所选 " + selected.length + " 篇发起科研通求助" : "为所选文献发起科研通求助") + (points === null ? "（请填写有效积分）" : "（每篇 " + points + " 积分）");
      $("fta-pref-selection-summary").textContent = selected.length ? "已选 " + selected.length + " 篇 · " + (points === null ? "请填写 1–10000 的整数积分" : "本次悬赏合计 " + selected.length * points + " 积分") : "未选择文献";
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
        const name = titleText(task.title) || task.doi || "未命名文献";
        const option = make("option", "", name + (task.doi && task.doi !== name ? " — " + task.doi : ""));
        option.value = task.id;
        option.selected = task.id === requestTarget;
        select.append(option);
      }
    }
    function openBinding(task) {
      bindingState = null;
      return run(async () => {
        const result = await app.getBindingCandidates(task.id);
        if (destroyed) return;
        const candidates = [];
        const seen = new Set();
        for (const candidate of Array.isArray(result) ? result : []) {
          const itemID = Number(candidate?.itemID);
          if (!Number.isSafeInteger(itemID) || itemID <= 0 || seen.has(itemID)) continue;
          seen.add(itemID);
          candidates.push({ ...candidate, itemID });
        }
        bindingState = { taskId: task.id, candidates, itemID: "" };
      }, "请选择要保存全文的文献并确认关联。");
    }
    function renderBinding(task, row) {
      if (bindingState?.taskId !== task.id) return;
      const state = bindingState;
      const panel = make("div", "fta-binding-panel");
      panel.setAttribute("role", "group");
      panel.setAttribute("aria-label", "关联文献");
      const label = make("label", "", "选择保存全文的文献");
      label.htmlFor = "fta-pref-binding-target";
      const select = make("select");
      select.id = "fta-pref-binding-target";
      select.disabled = busy || !state.candidates.length;
      const placeholder = make("option", "", "请选择文献（不自动关联）");
      placeholder.value = "";
      placeholder.selected = !state.itemID;
      select.append(placeholder);
      for (const candidate of state.candidates) {
        const name = titleText(candidate.title) || candidate.doi || "未命名文献";
        const option = make("option", "", [name, candidate.doi && candidate.doi !== name ? candidate.doi : "", candidate.libraryName].filter(Boolean).join(" — "));
        option.value = String(candidate.itemID);
        option.selected = option.value === state.itemID;
        select.append(option);
      }
      const note = make("p", "fta-note", state.candidates.length ? "请核对标题和 DOI。只有确认关联后，全文才能保存到这篇文献。" : "没有找到 DOI 相同且可写入附件的文献。请先在 Zotero 文库添加对应文献并补全 DOI，再重新打开关联选择。");
      const actions = make("div", "fta-actions");
      const confirm = make("button", "fta-primary", "确认关联");
      confirm.type = "button";
      confirm.disabled = busy || !state.itemID || typeof app.bindExistingTask !== "function";
      select.addEventListener("change", () => {
        if (busy || bindingState !== state) return;
        const value = select.value || "";
        state.itemID = state.candidates.some(candidate => String(candidate.itemID) === value) ? value : "";
        confirm.disabled = !state.itemID || typeof app.bindExistingTask !== "function";
      });
      confirm.addEventListener("click", () => {
        if (busy || bindingState !== state || !state.itemID) return;
        const itemID = Number(state.itemID);
        if (!state.candidates.some(candidate => candidate.itemID === itemID)) return;
        const autoDownload = snapshot.settings?.autoDownload !== false;
        run(async () => { await app.bindExistingTask(task.id, itemID); bindingState = null; }, autoDownload ? "文献已关联，下载进度见任务列表。" : "文献已关联，可点击“下载到文库”。");
      });
      const cancel = make("button", "", "取消");
      cancel.type = "button";
      cancel.disabled = busy;
      cancel.addEventListener("click", () => { if (!busy) { bindingState = null; renderTasks(); } });
      actions.append(confirm, cancel);
      panel.append(label, select, note, actions);
      row.append(panel);
    }
    function renderTasks() {
      const tasks = currentTasks();
      const queuePositions = new Map(tasks.filter(task => task.state === "queued").map((task, index) => [task.id, index + 1]));
      const visible = tasks.filter(task => matchesFilter(task, taskFilter));
      if (taskFilter === "success") visible.sort((a, b) => String(b.completedAt || b.importedAt || b.updatedAt || "").localeCompare(String(a.completedAt || a.importedAt || a.updatedAt || "")));
      if (bindingState && !visible.some(task => task.id === bindingState.taskId && task.state === "available" && !task.itemID)) bindingState = null;
      const eligibleIDs = new Set(visible.filter(canAssist).map(task => task.id));
      for (const id of selectedTasks) if (!eligibleIDs.has(id)) selectedTasks.delete(id);
      const list = $("fta-pref-task-list");
      list.replaceChildren();
      $("fta-pref-task-count").textContent = String(tasks.length);
      $("fta-pref-task-empty").hidden = visible.length > 0;
      $("fta-pref-task-empty").textContent = tasks.length ? taskFilter === "unfinished" ? "当前没有未完成任务。已获取的记录可在“已获取”中查看。" : "当前筛选没有任务。" : "还没有任务。在文库多选文献，右击“全文助手 → 批量获取全文”开始批量获取。";
      list.hidden = !visible.length;
      const summary = ["显示 " + visible.length + "/" + tasks.length + " 项"];
      const acquiring = tasks.filter(task => ["finding", "searching", "resolving", "downloading", "validating"].includes(task.state)).length;
      const waitingAssist = tasks.filter(task => task.state === "waiting").length;
      const waitingBrowser = tasks.filter(isBrowserActive).length;
      if (acquiring) summary.push("正在获取 " + acquiring + " 项");
      if (queuePositions.size) summary.push("排队 " + queuePositions.size + " 项");
      if (waitingAssist) summary.push("等待应助 " + waitingAssist + " 项");
      if (waitingBrowser) summary.push("等待浏览器下载 " + waitingBrowser + " 项");
      $("fta-pref-task-summary").textContent = summary.join(" · ");
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
        const name = titleText(task.title) || task.doi || "未命名文献";
        if (isFallback(task)) {
          const checkbox = make("input", "fta-task-select");
          checkbox.type = "checkbox";
          checkbox.checked = selectedTasks.has(task.id);
          checkbox.disabled = busy || !canAssist(task) || typeof app.requestAssist !== "function";
          checkbox.setAttribute("aria-label", "选择文献：" + name);
          if (!canAssist(task)) checkbox.title = "请先在原文献条目补全 DOI";
          checkbox.addEventListener("change", () => {
            if (busy || checkbox.disabled) return;
            if (checkbox.checked) selectedTasks.add(task.id); else selectedTasks.delete(task.id);
            renderSelection();
          });
          main.append(checkbox);
        }
        main.append(make("div", "fta-row-title", name));
        const acquired = isAcquired(task);
        const assistPending = needsAssistCompletion(task);
        const receiptLabel = assistPending ? task.assistReceipt.needsReconcile ? "已获取 · 采纳待核实" : task.assistReceipt.adoption === "accepted" ? "已采纳 · 待已读" : "已获取 · 待采纳" : acquired && isAssistComplete(task) ? "已采纳 · 对应消息已读" : "";
        const unboundAvailable = task.state === "available" && !task.itemID;
        const badge = make("span", "fta-status-badge", receiptLabel || (unboundAvailable ? "待关联文献" : task.state === "queued" ? "排队中 · 第 " + queuePositions.get(task.id) + " 位" : taskLabels[task.state] || "待处理"));
        if (acquired) badge.dataset.tone = "success";
        if (["error", "failed"].includes(task.state)) badge.dataset.tone = "error";
        if (["pending_login", "needs_login", "not_found", "needs_review", "captcha", "submission_unknown", "manual_review"].includes(task.state)) badge.dataset.tone = "warning";
        if (unboundAvailable || assistPending) badge.dataset.tone = "warning";
        main.append(badge);
        row.append(main);
        const completedDate = acquired ? dateText(task.completedAt || task.importedAt || task.updatedAt, true) : "";
        const routeLabel = task.downloadRoute === "highspeed" ? "免积分高速" : task.downloadRoute === "normal" ? "普通线路" : "";
        const showRoute = acquired ? task.source === "ablesci" : ["downloading", "validating"].includes(task.state) && Boolean(task.source === "ablesci" || task.requestID || task.requestURL);
        const route = showRoute ? routeLabel : "";
        const pointsLabel = task.requestID && task.requestedPoints ? "悬赏 " + task.requestedPoints + " 积分" : "";
        const meta = (acquired ? [completedDate ? "完成 " + completedDate : "完成日期未记录", "来源：" + (sourceLabels[task.source] || "未记录"), route, task.doi] : [task.doi, task.requestID ? "求助 " + task.requestID : "", pointsLabel, route ? "来源：科研通" : "", route, task.lastCheckedAt ? "最近检查 " + dateText(task.lastCheckedAt) : ""]).filter(Boolean);
        if (meta.length) row.append(make("div", "fta-row-meta", meta.join(" · ")));
        const note = unboundAvailable ? "应助文件已就绪，但此任务仅跟踪求助，尚未关联 Zotero 文献。请先关联文献，才能下载到文库。" : assistPending ? task.assistReceipt.lastError || (task.assistReceipt.needsReconcile ? "PDF 已入库；采纳结果尚未核实，请先核实网站状态。" : task.assistReceipt.adoption === "accepted" ? "应助文件已采纳；仍需将这份文件对应的上传消息标记已读。" : "PDF 已入库；仍需采纳这份应助文件并标记对应上传消息已读。") : acquired ? task.source === "ablesci" && !task.assistReceipt ? task.lastError || "旧版记录可核验后补采纳：仅当网站文件与已保存 PDF 完全一致且论文身份匹配时，才采纳并处理对应消息。" : "" : task.message || task.lastError || browserNotes[task.state];
        if (note) row.append(make("p", "fta-row-note", note));
        const actions = make("div", "fta-row-actions");
        const done = ["imported", "completed", "closed"].includes(task.state);
        const hasRequest = Boolean(task.requestID || task.requestURL);
        if (!acquired && (!isBrowserRoute(task) || hasRequest)) actions.append(button("立即检查", "checkTask", [task.id], done));
        if (task.state === "available" && task.itemID) actions.append(button("下载到文库", "downloadTask", [task.id], false, "下载结果已更新。"));
        if (unboundAvailable) {
          const bind = make("button", "", "关联文献");
          bind.type = "button";
          bind.disabled = busy || typeof app.getBindingCandidates !== "function" || typeof app.bindExistingTask !== "function";
          bind.addEventListener("click", () => { if (!busy && !bind.disabled) openBinding(task); });
          actions.append(bind);
        }
        const openMethod = typeof app.openTask === "function" ? "openTask" : "openRequest";
        const canOpen = openMethod === "openTask" ? Boolean(task.attachmentID || task.requestURL || task.officialURL || task.doi) : Boolean(task.requestURL);
        actions.append(button(task.attachmentID ? "打开全文" : hasRequest ? "查看已有求助" : "打开网页", openMethod, [task.id], !canOpen));
        if (acquired && task.attachmentID && hasRequest) actions.append(button("查看已有求助", "openRequest", [task.id]));
        if (assistPending) actions.append(button(task.assistReceipt.needsReconcile ? "核实采纳状态" : "重试采纳与已读", "retryAssistCompletion", [task.id], false, "采纳与对应消息的处理结果已更新，请查看任务状态。"));
        if (acquired && task.source === "ablesci" && hasRequest && task.attachmentID && !task.assistReceipt) actions.append(button("核验并补采纳", "verifyAssistCompletion", [task.id], false, result => result?.completed ? "已核验原文件，采纳与对应消息已读均已完成。" : result?.message || "核验结果已更新，请查看任务提示。"));
        if (task.itemID && !acquired && (isFallback(task) || isBrowserRoute(task) || ["needs_login", "needs_review", "error", "failed", "pending_login", "captcha", "paused"].includes(task.state))) {
          if (!hasRequest) actions.append(button("浏览器下载并自动入库", "openSystemBrowserTask", [task.id], false, manualDownloadMessage));
          actions.append(button("选择已下载的PDF", "importLocalPDF", [task.id], false, result => result?.cancelled ? "已取消选择文件。" : result?.needsReview ? "请先预览所选 PDF，核对后再确认导入。" : "本地 PDF 处理结果已更新。"));
        }
        if (task.state === "manual_review") {
          const assistReview = Boolean(task.assistReview?.fileID && task.assistReview?.createdAt);
          if (task.pendingFilename) row.append(make("p", "fta-note", "待核对文件：" + task.pendingFilename));
          if (task.pendingTitle) row.append(make("p", "fta-note", "待关联文献：" + titleText(task.pendingTitle)));
          if (task.pendingSummary) row.append(make("p", "fta-note", task.pendingSummary));
          if (assistReview) row.append(make("p", "fta-note", "确认后将入库并采纳这份应助文件，结算该求助的原悬赏" + (Number.isSafeInteger(task.requestedPoints) && task.requestedPoints > 0 ? "（" + task.requestedPoints + " 积分）" : "") + "；随后只将对应上传消息标记已读。"));
          actions.append(button("预览待核对 PDF", "previewDownloadedPDF", [task.id], !task.pendingFilename, "请核对 PDF 的标题、作者和 DOI，再决定是否导入。"));
          actions.append(button(assistReview ? "确认对应论文并入库、采纳" : "我已核对，是这篇论文", "confirmDownloadedPDF", [task.id], !task.pendingFilename, assistReview ? "核验与入库结果已更新，采纳及对应消息状态见任务列表。" : "PDF 已保存到原文献。"));
          actions.append(button("取消这次导入", "dismissDownloadedPDF", [task.id], false, assistReview ? "已取消这次应助文件导入，任务保留；未确认的文件不会因此采纳。" : "已取消，任务保留。可重新选择文件，或点击“浏览器下载并自动入库”重新开始检查。"));
        }
        if (isBrowserActive(task) && !hasRequest) actions.append(button("暂停监控", "pauseTask", [task.id], false, "已暂停下载文件夹检查；可重新点击“浏览器下载并自动入库”恢复。"));
        else if (["paused", "error", "failed", "not_found", "needs_login", "pending_login", "needs_review"].includes(task.state) && (!isBrowserRoute(task) || hasRequest)) {
          const unsubmitted = !task.requestID && !task.requestURL;
          actions.append(button(unsubmitted ? "按 " + pointsText() + "重试" : "重试", "retryTask", unsubmitted ? [task.id, { points: currentPoints() }] : [task.id], false, "任务已恢复。"));
        }
        else if (!acquired && !isBrowserRoute(task)) actions.append(button("暂停", "pauseTask", [task.id], done, task.requestURL ? "已暂停本地检查，网站上的求助仍然保留。" : "任务已暂停。"));
        if (isFallback(task)) {
          actions.append(button("科研通求助（" + pointsText() + "）", "requestAssist", [[task.id], { points: currentPoints() }], !canAssist(task), assistMessage));
          if (!canAssist(task)) actions.append(make("span", "fta-secondary", "补全 DOI 后可求助"));
        }
        row.append(actions);
        if (unboundAvailable) renderBinding(task, row);
        list.append(row);
      }
      renderSelection();
    }
    function renderMessages() {
      const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
      const info = snapshot.messagesStatus || {};
      const list = $("fta-pref-message-list");
      list.replaceChildren();
      $("fta-pref-message-empty").hidden = messages.length > 0;
      $("fta-pref-message-empty").textContent = info.state === "loaded" ? "暂无消息。" : "尚未读取科研通消息。";
      const lastRefreshed = dateText(info.lastCheckedAt);
      $("fta-pref-messages-refreshed").textContent = lastRefreshed ? "最近刷新 " + lastRefreshed : "尚未刷新";
      $("fta-pref-messages-state").textContent = String(info.message || (info.state === "loading" ? "正在刷新消息…" : info.state === "error" ? "消息刷新未完成，请稍后再试。" : info.state === "loaded" || lastRefreshed ? "" : "登录后可查看科研通应助提醒。"));
      $("fta-pref-messages-state").hidden = !$("fta-pref-messages-state").textContent;
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
      const publisherSession = snapshot.publisherSession || {};
      $("fta-pref-version").textContent = snapshot.version ? "v" + snapshot.version : "";
      $("fta-pref-account-state").textContent = accountLabels[session.status] || "待验证";
      $("fta-pref-account-state").dataset.tone = ["authenticated", "logged_in"].includes(session.status) ? "success" : ["captcha", "expired", "pending_login"].includes(session.status) ? "warning" : "";
      const boundName = ["authenticated", "logged_in"].includes(session.status) ? String(session.displayName || "").trim() : "";
      $("fta-pref-account-identity").hidden = !boundName;
      $("fta-pref-account-identity").textContent = boundName ? "当前绑定：" + boundName : "";
      $("fta-pref-account-message").textContent = String(session.message || "登录后可发起求助、查看应助进度并下载文件。");
      const publisherStatus = $("fta-pref-publisher-session");
      publisherStatus.hidden = typeof publisherSession.initialized !== "boolean";
      publisherStatus.dataset.error = String(Boolean(publisherSession.error));
      const savedAt = dateText(publisherSession.savedAt, true);
      publisherStatus.textContent = publisherSession.error ? "机构登录：保存或恢复未完成，请在机构登录窗口重新登录。" : !publisherSession.initialized ? "机构登录：正在读取登录保存状态…" : publisherSession.hasBackup ? "机构登录：已在本机加密保存" + (savedAt ? "（" + savedAt + "）" : "") + "。网站会话过期后需重新登录。" : publisherSession.enabled ? "机构登录：已启用保存。网站会话过期后需重新登录。" : "机构登录：尚未保存。可在专用窗口保留“记住此窗口的机构登录”并完成登录。";
      if (!accountDirty) $("fta-pref-username").value = session.username || "";
      $("fta-pref-password").placeholder = session.hasSavedPassword ? "已保存密码；留空使用已保存的密码" : "输入密码";
      if (!settingsDirty) {
        $("fta-pref-points").value = String(settings.points ?? 10);
        $("fta-pref-poll").value = String(settings.pollSeconds ?? 60);
        $("fta-pref-auto-download").checked = settings.autoDownload !== false;
      }
      renderNavigation();
      renderCaptureSummary();
      renderDirectories();
      renderTasks();
      renderRequestTargets();
      renderMessages();
      const methodButtons = { "fta-pref-save-login": "saveCredentialsAndLogin", "fta-pref-web-login": "openLogin", "fta-pref-logout": "logout", "fta-pref-save-settings": "saveSettings", "fta-pref-add-request": "addExistingRequest", "fta-pref-refresh-messages": "refreshMessages", "fta-pref-choose-directory": "chooseDownloadDirectory", "fta-pref-detect-directories": "detectDownloadDirectories" };
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
    for (const tab of pageTabs) {
      on(tab, "click", () => selectPage(tab.dataset.page));
      on(tab, "keydown", event => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const index = pageTabs.indexOf(tab);
        let next;
        if (event.key === "ArrowRight") next = (index + 1) % pageTabs.length;
        else if (event.key === "ArrowLeft") next = (index + pageTabs.length - 1) % pageTabs.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = pageTabs.length - 1;
        else return;
        event.preventDefault();
        selectPage(pageTabs[next].dataset.page, true);
      });
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
    on($("fta-pref-choose-directory"), "click", () => {
      if ($("fta-pref-choose-directory").disabled) return;
      run(() => app.chooseDownloadDirectory(), result => result?.cancelled ? "已取消添加下载文件夹。" : (result?.changed === false ? "该下载文件夹已在列表中。" : "已添加下载文件夹。请将浏览器下载的 PDF 保存到列表中的任一文件夹。") + directoryPauseNote(result));
    });
    on($("fta-pref-detect-directories"), "click", () => {
      if ($("fta-pref-detect-directories").disabled) return;
      run(() => app.detectDownloadDirectories(), result => (Number.isSafeInteger(result?.added) && result.added > 0 ? "发现并添加了 " + result.added + " 个新下载目录。" : "未发现新的下载目录，现有配置保持不变。") + directoryPauseNote(result));
    });
    on($("fta-pref-logout"), "click", () => run(async () => { await app.logout(); $("fta-pref-password").value = ""; accountDirty = false; }, "已退出插件中的科研通登录。"));
    for (const id of ["fta-pref-points", "fta-pref-poll", "fta-pref-auto-download"]) on($(id), "input", () => {
      settingsDirty = true;
      status(currentPoints() === null ? "悬赏积分必须是 1–10000 的整数。" : "有未保存的更改", currentPoints() === null, "fta-pref-save-state");
      $("fta-pref-points").setAttribute("aria-invalid", String(currentPoints() === null));
      renderNavigation();
      renderTasks();
    });
    on($("fta-pref-settings-form"), "submit", event => {
      event.preventDefault();
      const points = currentPoints();
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
      bindingState = null;
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
      if (busy || $("fta-pref-bulk-assist").disabled) return;
      const ids = currentTasks().filter(task => matchesFilter(task, taskFilter) && canAssist(task) && selectedTasks.has(task.id)).map(task => task.id);
      if (!ids.length || typeof app.requestAssist !== "function") return;
      const points = $("fta-pref-bulk-assist").dataset.points ? Number($("fta-pref-bulk-assist").dataset.points) : null;
      run(async () => {
        await saveActionPoints(points);
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
