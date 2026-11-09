/* global window, document, Zotero */
(function () {
  "use strict";
  const ROOT_ID = "fta-preferences";
  let cleanup = null;
  function mount(root) {
    if (!root || root.dataset.fulltextMounted === "true") return;
    const app = window.Zotero?.FulltextAssistant || (typeof Zotero !== "undefined" && Zotero.FulltextAssistant);
    const staticNodes = new Map([...root.querySelectorAll("[id]")].map(node => [node.id, node]));
    const $ = id => staticNodes.get(id) || root.querySelector("#" + id);
    let renderDepth = 0;
    const localize = () => { if (!renderDepth) app?.localize?.(root); };
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
    let sourceSettingsDirty = false;
    let sourceCredentialsDirty = false;
    let autoUpdateSaving = false;
    let checkInStartupError = "";
    let destroyed = false;
    let activePage = "tasks";
    let seenCaptureStamp = "";
    let taskFilter = "unfinished";
    let taskQuery = "", messageQuery = "", messageFilter = "all";
    let taskPage = 0, messagePage = 0, taskPageSize = 25, messagePageSize = 25;
    let visibleTaskPage = [], visibleTaskMatches = [];
    const taskRows = new Map(), messageRows = new Map();
    let requestTargetsKey = "", directoriesKey = "", spendingKey = "";
    let searchTimer = null;
    let requestTarget = "";
    let bindingState = null;
    let currentBatchIDs = new Set();
    const selectedTasks = new Set();
    const expandedDownloadDetails = new Set();
    const expandedDownloadDiagnostics = new Set();
    const expandedDOIChecks = new Set();
    const expandedSourceDetails = new Set();
    const copyTimers = new Set();
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
    const sourceLabels = { publisher: "出版社网页", rendered_publisher: "出版社网页", open_access: "开放获取", existing: "已有附件", ablesci: "科研通", local_file: "本地 PDF", edge_browser: "Edge 浏览器", browser_download: "浏览器下载", openalex: "OpenAlex", pmc: "PubMed Central", core: "CORE", semanticScholar: "Semantic Scholar", custom: "自定义来源" };
    const sourceProviderIDs = ["publisher", "openAccess", "openalex", "pmc", "core", "semanticScholar", "custom"];
    const sourceKeyIDs = ["openalex", "core", "semanticScholar"];
    const sourceSettingIDs = [...sourceProviderIDs.map(id => "fta-pref-source-" + id), "fta-pref-source-version", "fta-pref-source-templates", "fta-pref-openalex-content", "fta-pref-openalex-limit", "fta-pref-core-content", "fta-pref-core-limit"];
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
    const searchTerms = value => String(value || "").normalize("NFKC").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const includesTerms = (terms, values) => { const text = values.filter(Boolean).join(" ").normalize("NFKC").toLocaleLowerCase();return terms.every(term => text.includes(term)); };
    const matchesTaskSearch = task => includesTerms(searchTerms(taskQuery), [titleText(task.title), task.doi, task.requestID, task.discoveryProvider, task.pdfHost]);
    function reconcileRows(list, rows) {
      // Move only changed rows. Unchanged controls retain focus, selection and
      // scroll anchoring while background progress updates other records.
      let next = list.firstChild;
      for (const row of rows) {
        if (row === next) next = next.nextSibling;
        else list.insertBefore(row, next);
      }
      while (next) { const unused = next;next = next.nextSibling;unused.remove(); }
    }
    function pagination(kind, count, page, size, total = count) {
      const pages = Math.max(1, Math.ceil(count / size));
      page = Math.max(0, Math.min(page, pages - 1));
      $("fta-pref-" + kind + "-previous").disabled = busy || page === 0;
      $("fta-pref-" + kind + "-next").disabled = busy || page + 1 >= pages;
      $("fta-pref-" + kind + "-page-size").disabled = busy;
      $("fta-pref-" + kind + "-pagination").hidden = !count;
      $("fta-pref-" + kind + "-page-status").textContent = "第 " + (page + 1) + "/" + pages + " 页 · " + (count ? page * size + 1 : 0) + "–" + Math.min(count, (page + 1) * size) + " / " + count + " 项";
      $("fta-pref-" + kind + "-page-status").title = "匹配 " + count + " 项，共 " + total + " 项；分页不会删除记录。";
      return page;
    }
    function sourceText(task) {
      const provider = task.discoveryProvider === "open_access" ? "Zotero 开放获取" : task.discoveryProvider === "pmc" ? "PMC / Europe PMC" : sourceLabels[task.discoveryProvider] || sourceLabels[task.source] || "未记录";
      const result = [(task.discoveryProvider ? "发现来源：" : "来源：") + provider];
      // pdfHost is supplied only after a real PDF response. Never infer it from
      // the DOI/landing URL or display URL credentials, paths or query strings.
      const host = String(task.pdfHost || "").toLowerCase();
      if (/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host) || /^\[[0-9a-f:]{2,45}\]$/.test(host)) result.push("PDF：" + host);
      return result;
    }
    const currentPoints = () => {
      const value = String($("fta-pref-points").value || "").trim();
      const points = /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
      return Number.isSafeInteger(points) && points <= 10000 ? points : null;
    };
    const pointsText = () => currentPoints() === null ? "请填写有效积分" : currentPoints() + (snapshot.settings?.acceptSiteMinimum === true ? " 积分起" : " 积分");
    const canOfferAssist = task => !task.requestURL && !task.requestID && !task.submissionReview && !task.attachmentID && ["not_found", "needs_login", "pending_login", "paused", "error", "failed", "needs_review", "captcha", "manual_waiting", "manual_review", "browser_waiting", "browser_scanning", "browser_downloading"].includes(task.state);
    const isFallback = task => canOfferAssist(task) && !["needs_login", "pending_login", "captcha", "manual_waiting"].includes(task.state);
    const canAssist = task => canOfferAssist(task) && Boolean(String(task.doi || "").trim());
    const isBatchFilter = filter => ["active", "login", "fallback", "success"].includes(filter);
    const batchIDs = () => currentBatchIDs;
    const scopedTasks = filter => isBatchFilter(filter) ? currentTasks().filter(task => batchIDs().has(task.id)) : filter === "all" ? currentTasks().filter(isAcquired) : currentTasks();
    function matchesFilter(task, filter) {
      if (isBatchFilter(filter) && !batchIDs().has(task.id)) return false;
      if (filter === "unfinished") return !isAcquired(task) || needsAssistCompletion(task);
      if (filter === "success" || filter === "all") return isAcquired(task);
      if (filter === "login") return ["needs_login", "pending_login", "captcha"].includes(task.state);
      if (filter === "fallback") return isFallback(task);
      if (filter === "active") return !isAcquired(task) && !isFallback(task) && !["needs_login", "pending_login", "captcha"].includes(task.state) && (isBrowserActive(task) || ["waiting", "available", "submitting", "submission_unknown", "downloading", "queued", "finding", "searching", "resolving", "checking_account", "validating", "ready_to_check", "manual_review"].includes(task.state));
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
      $("fta-pref-tab-settings").dataset.dirty = String(sourceSettingsDirty || sourceCredentialsDirty);
      $("fta-pref-tab-settings").setAttribute("aria-label", sourceSettingsDirty || sourceCredentialsDirty ? "设置，有未保存的更改" : "设置");
      $("fta-pref-tab-account").dataset.dirty = String(settingsDirty);
      $("fta-pref-tab-account").setAttribute("aria-label", settingsDirty ? "科研通设置，有未保存的更改" : "科研通设置");
      localize();
    }
    function selectPage(page, focus = false) {
      const tab = pageTabs.find(node => node.dataset.page === page);
      if (destroyed || !tab) return;
      activePage = page;
      renderNavigation();
      renderActivePage();
      if (focus) {
        tab.focus();
        tab.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      }
    }
    function status(message, error = false, target = "fta-pref-status") {
      $(target).textContent = String(message || "");
      $(target).dataset.error = String(error);
      localize();
    }
    function dateText(value, includeYear = false) {
      if (!value) return "";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(snapshot.settings?.language === "en" ? "en-US" : snapshot.settings?.language === "zh-TW" ? "zh-TW" : "zh-CN", { ...(includeYear ? { year: "numeric" } : {}), month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
    }
    function make(name, className, text) {
      const node = document.createElementNS("http://www.w3.org/1999/xhtml", name);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = String(text);
      return node;
    }
    function raw(node) { node.setAttribute("data-i18n-skip", "true"); return node; }
    function copyControl(text, label, className = "") {
      const wrap = make("span", "fta-copy-wrap");
      const action = make("button", "fta-copy-button " + className);
      action.type = "button"; action.title = label; action.setAttribute("aria-label", label);
      action.disabled = typeof app.copyText !== "function";
      action.append(raw(make("span", "", text)));
      const hint = make("span", "fta-copy-hint"); hint.setAttribute("role", "status");hint.setAttribute("aria-live", "polite");
      let pendingTimer = null;
      action.addEventListener("click", async () => {
        if (destroyed || action.disabled) return;
        try {
          await app.copyText(text);
          if (destroyed || !wrap.isConnected) return;
          hint.textContent = "已复制";localize();
          if (pendingTimer !== null) { window.clearTimeout(pendingTimer);copyTimers.delete(pendingTimer); }
          const timer = window.setTimeout(() => { copyTimers.delete(timer);pendingTimer = null;if (!destroyed) hint.textContent = ""; }, 1800);
          pendingTimer = timer;
          copyTimers.add(timer);
        } catch (error) { if (!destroyed) { hint.textContent = "";status(error?.message || "复制失败，请重试。", true); } }
      });
      wrap.append(action, hint);return wrap;
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
      settingsDirty = currentPoints() !== saved.points || Number($("fta-pref-poll").value) !== saved.pollSeconds || $("fta-pref-auto-download").checked !== (saved.autoDownload !== false) || $("fta-pref-site-minimum").checked !== (saved.acceptSiteMinimum === true) || $("fta-pref-checkin-reminder").checked !== (saved.checkInReminder !== false);
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
    function renderSourceSettings() {
      const settings = snapshot.sourceSettings || {}, enabled = settings.enabled || {};
      if (!sourceSettingsDirty) {
        for (const provider of sourceProviderIDs) $("fta-pref-source-" + provider).checked = typeof enabled[provider] === "boolean" ? enabled[provider] : provider !== "custom";
        const preference = ["published", "accepted", "any"].includes(settings.versionPreference) ? settings.versionPreference : "accepted";
        const versionOptions = [...$("fta-pref-source-version").querySelectorAll("option")];
        for (const option of versionOptions) option.selected = false;
        const selectedVersion = versionOptions.find(option => option.value === preference);
        if (selectedVersion) selectedVersion.selected = true;
        $("fta-pref-source-templates").value = Array.isArray(settings.customTemplates) ? settings.customTemplates.join("\n") : "";
        $("fta-pref-openalex-content").checked = settings.openalexContentEnabled === true;
        $("fta-pref-openalex-limit").value = String(settings.openalexDailyLimit ?? 100);
        $("fta-pref-core-content").checked = settings.coreContentEnabled === true;
        $("fta-pref-core-limit").value = String(settings.coreDailyLimit ?? 20);
      }
      for (const id of sourceSettingIDs) $(id).disabled = busy || typeof app.saveSourceSettings !== "function";
      $("fta-pref-openalex-limit").disabled = busy || typeof app.saveSourceSettings !== "function" || !$("fta-pref-openalex-content").checked;
      $("fta-pref-core-limit").disabled = busy || typeof app.saveSourceSettings !== "function" || !$("fta-pref-core-content").checked;
      $("fta-pref-save-sources").disabled = busy || typeof app.saveSourceSettings !== "function";
      for (const provider of sourceKeyIDs) {
        const saved = snapshot.sourceCredentials?.[provider] === true;
        const field = $("fta-pref-key-" + provider), clear = $("fta-pref-key-" + provider + "-clear");
        // Never read a secret from a snapshot or refill password controls.
        field.placeholder = saved ? "已保存；留空保留原密钥" : "输入 API 密钥";
        $("fta-pref-key-" + provider + "-state").textContent = saved ? "已保存密钥" : "未保存密钥";
        field.disabled = busy || typeof app.saveSourceCredentials !== "function" || clear.checked;
        clear.disabled = busy || typeof app.saveSourceCredentials !== "function" || !saved;
      }
      $("fta-pref-save-source-keys").disabled = busy || typeof app.saveSourceCredentials !== "function";
    }
    function sourceSettingsInput() {
      const limitText = String($("fta-pref-openalex-limit").value || "").trim();
      const limit = /^[1-9]\d*$/.test(limitText) ? Number(limitText) : NaN;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("OpenAlex 每日下载上限必须是 1–1000 的整数。");
      const coreLimit = Number($("fta-pref-core-limit").value);
      if (!Number.isSafeInteger(coreLimit) || coreLimit < 1 || coreLimit > 1000) throw new Error("CORE 每日直供下载上限必须是 1–1000 的整数。");
      const versionPreference = $("fta-pref-source-version").value;
      if (!["published", "accepted", "any"].includes(versionPreference)) throw new Error("请选择有效的全文版本偏好。");
      const customTemplates = [...new Set(String($("fta-pref-source-templates").value || "").split(/[;\r\n]+/).map(value => value.trim()).filter(Boolean))];
      for (const template of customTemplates) {
        let url;
        try { url = new URL(template.replaceAll("{doi}", "10.0000/example")); } catch (_) {}
        if (!template.includes("{doi}") || !url || url.protocol !== "https:" || url.username || url.password) throw new Error("每个自定义网址必须使用 HTTPS、包含 {doi}，且不能含账号密码。");
      }
      const enabled = {};
      for (const provider of sourceProviderIDs) enabled[provider] = $("fta-pref-source-" + provider).checked === true;
      if (enabled.custom && !customTemplates.length) throw new Error("请先填写自定义 DOI 网址模板，或关闭此来源。");
      return { enabled, versionPreference, customTemplates, openalexContentEnabled: $("fta-pref-openalex-content").checked === true, openalexDailyLimit: limit, coreContentEnabled: $("fta-pref-core-content").checked === true, coreDailyLimit: coreLimit };
    }
    function renderUpdater() {
      const info = snapshot.updateStatus || {}, state = info.state || "idle";
      const working = ["checking", "downloading", "installing"].includes(state);
      const labels = { idle: "尚未检查更新", checking: "正在检查更新…", current: "已是最新版本", available: "有可用更新", downloading: "正在下载更新…", installing: "正在安装更新…", installed: "更新已安装", error: "更新失败，可重试" };
      const version = String(info.currentVersion || snapshot.version || "");
      const availableVersion = String(info.availableVersion || "");
      $("fta-pref-updater").dataset.state = state;
      $("fta-pref-version").textContent = version ? "v" + version : "";
      let message = labels[state] || "更新状态待核实";
      if (state === "available" && availableVersion) message = "可更新至 v" + availableVersion;
      if (state === "downloading" && Number.isFinite(info.progress?.percent)) message = "正在下载更新 · " + Math.max(0, Math.min(100, Math.round(info.progress.percent))) + "%";
      $("fta-pref-update-state").textContent = message;
      $("fta-pref-update-state").dataset.error = String(state === "error");
      $("fta-pref-update-version").textContent = version ? "当前版本：v" + version : "当前版本尚未读取";
      $("fta-pref-update-message").textContent = String(info.message || (info.restartRequired ? "请在 Zotero 插件管理器中确认是否需要重启。" : ""));
      $("fta-pref-update-message").hidden = !$("fta-pref-update-message").textContent;
      $("fta-pref-update-message").dataset.error = String(state === "error");
      $("fta-pref-update-checked").textContent = info.checkedAt ? "最近检查更新 " + dateText(info.checkedAt, true) : "尚未检查更新";
      $("fta-pref-check-update").disabled = busy || working || info.canCheck !== true || typeof app.checkForUpdates !== "function";
      $("fta-pref-check-update").setAttribute("aria-busy", String(state === "checking"));
      if (!autoUpdateSaving) $("fta-pref-auto-update").checked = info.autoUpdate === true;
      $("fta-pref-auto-update").disabled = busy || working || typeof app.setAutoUpdate !== "function" || typeof info.autoUpdate !== "boolean";
      $("fta-pref-update-global-note").hidden = info.globalUpdatesEnabled !== false;
      $("fta-pref-release-notes").disabled = busy || typeof app.openReleaseNotes !== "function" || info.releaseNotesAvailable !== true;
      $("fta-pref-install-update").hidden = !["available", "downloading", "installing"].includes(state) && info.canInstall !== true;
      $("fta-pref-install-update").disabled = busy || working || info.canInstall !== true || typeof app.installUpdate !== "function";
    }
    function renderCaptureSummary() {
      const summary = snapshot.currentBatch?.summary || snapshot.captureSummary;
      const stamp = summary?.id ?? summary?.at ?? "";
      if (stamp && stamp !== seenCaptureStamp) {
        seenCaptureStamp = stamp;
        taskPage = 0;
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
      const key = JSON.stringify([snapshot.settings?.downloadDirectories, snapshot.settings?.downloadDirectory, busy, typeof app.removeDownloadDirectory, snapshot.settings?.language]);
      if (directoriesKey === key) return;
      directoriesKey = key;
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
      const eligible = visibleTaskMatches.filter(canAssist);
      $("fta-pref-bulk-actions").hidden = !eligible.length;
      $("fta-pref-bulk-note").hidden = !eligible.length;
      const selected = eligible.filter(task => selectedTasks.has(task.id));
      const all = $("fta-pref-select-tasks");
      all.disabled = busy || !eligible.length || typeof app.requestAssist !== "function";
      const pageEligible = visibleTaskPage.filter(canAssist), pageSelected = pageEligible.filter(task => selectedTasks.has(task.id));
      all.disabled ||= !pageEligible.length;
      all.checked = pageEligible.length > 0 && pageSelected.length === pageEligible.length;
      all.indeterminate = pageSelected.length > 0 && pageSelected.length < pageEligible.length;
      const action = $("fta-pref-bulk-assist");
      const points = currentPoints();
      action.disabled = busy || !selected.length || points === null || typeof app.requestAssist !== "function" || typeof app.saveSettings !== "function";
      action.dataset.points = points === null ? "" : String(points);
      action.textContent = (selected.length ? "为所选 " + selected.length + " 篇发起科研通求助" : "为所选文献发起科研通求助") + (points === null ? "（请填写有效积分）" : "（每篇 " + pointsText() + "）");
      $("fta-pref-selection-summary").textContent = selected.length ? "已选 " + selected.length + " 篇 · " + (points === null ? "请填写 1–10000 的整数积分" : (snapshot.settings?.acceptSiteMinimum === true ? "基础悬赏合计 " + selected.length * points + " 积分；可能按网站最低积分上调" : "本次悬赏合计 " + selected.length * points + " 积分")) : "未选择文献";
      localize();
    }
    function renderRequestTargets() {
      if (activePage !== "tasks") return;
      const available = currentTasks().filter(task => task.itemID && !task.requestID && !task.requestURL);
      if (requestTarget && !available.some(task => task.id === requestTarget)) requestTarget = "";
      const terms = searchTerms($("fta-pref-request-search").value);
      const matching = terms.length ? available.filter(task => includesTerms(terms, [titleText(task.title), task.doi])) : available;
      const offered = matching.slice(0, 50);
      const selected = available.find(task => task.id === requestTarget);
      if (selected && !offered.some(task => task.id === selected.id)) offered.unshift(selected);
      $("fta-pref-request-search-note").textContent = matching.length > 50 ? "匹配 " + matching.length + " 项，先显示 50 项；请输入标题或 DOI 缩小范围。" : "匹配 " + matching.length + " 项。";
      const key = JSON.stringify([offered.map(task => [task.id, task.title, task.doi]), requestTarget, snapshot.settings?.language]);
      if (requestTargetsKey === key) return;
      requestTargetsKey = key;
      const select = $("fta-pref-request-target");
      select.replaceChildren();
      const unbound = make("option", "", "只跟踪，不关联文献");
      unbound.value = "";
      unbound.selected = !requestTarget;
      select.append(unbound);
      for (const task of offered) {
        const name = titleText(task.title) || task.doi || "未命名文献";
        const option = make("option", "", name + (task.doi && task.doi !== name ? " — " + task.doi : ""));
        option.value = task.id;
        raw(option);
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
        raw(option);
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
      if (activePage !== "tasks") return;
      const tasks = currentTasks();
      const scopeTasks = scopedTasks(taskFilter);
      const queuePositions = new Map(tasks.filter(task => task.state === "queued").map((task, index) => [task.id, index + 1]));
      const matching = tasks.filter(task => matchesFilter(task, taskFilter));
      const terms = searchTerms(taskQuery);
      const visible = terms.length ? matching.filter(task => includesTerms(terms, [titleText(task.title), task.doi, task.requestID, task.discoveryProvider, task.pdfHost])) : matching;
      if (taskFilter === "success" || taskFilter === "all") visible.sort((a, b) => String(b.completedAt || b.importedAt || b.updatedAt || "").localeCompare(String(a.completedAt || a.importedAt || a.updatedAt || "")));
      if (bindingState && !visible.some(task => task.id === bindingState.taskId && task.state === "available" && !task.itemID)) bindingState = null;
      const eligibleIDs = new Set(visible.filter(canAssist).map(task => task.id));
      for (const id of selectedTasks) if (!eligibleIDs.has(id)) selectedTasks.delete(id);
      const list = $("fta-pref-task-list");
      // Snapshot refreshes rebuild rows. Read the live state before replacing
      // them so a user's latest toggle survives even before its toggle event.
      for (const details of list.querySelectorAll(".fta-download-details")) {
        const id = details.closest(".fta-row")?.dataset.taskId;
        if (id) {
          if (details.hasAttribute("open")) expandedDownloadDetails.add(id);
          else expandedDownloadDetails.delete(id);
        }
      }
      for (const details of list.querySelectorAll(".fta-download-diagnostics")) {
        const id = details.closest(".fta-row")?.dataset.taskId;
        if (id) {
          if (details.hasAttribute("open")) expandedDownloadDiagnostics.add(id);
          else expandedDownloadDiagnostics.delete(id);
        }
      }
      for (const details of list.querySelectorAll(".fta-doi-check")) {
        const id = details.closest(".fta-row")?.dataset.taskId;
        if (id) { if (details.hasAttribute("open")) expandedDOIChecks.add(id);else expandedDOIChecks.delete(id); }
      }
      for (const details of list.querySelectorAll(".fta-source-diagnostics")) {
        const id = details.closest(".fta-row")?.dataset.taskId;
        if (id) { if (details.hasAttribute("open")) expandedSourceDetails.add(id);else expandedSourceDetails.delete(id); }
      }
      const taskIDs = new Set(tasks.map(task => String(task.id)));
      for (const id of expandedDownloadDetails) if (!taskIDs.has(id)) expandedDownloadDetails.delete(id);
      for (const id of expandedDownloadDiagnostics) if (!taskIDs.has(id)) expandedDownloadDiagnostics.delete(id);
      for (const id of expandedDOIChecks) if (!taskIDs.has(id)) expandedDOIChecks.delete(id);
      for (const id of expandedSourceDetails) if (!taskIDs.has(id)) expandedSourceDetails.delete(id);
      taskPage = pagination("task", visible.length, taskPage, taskPageSize, matching.length);
      visibleTaskMatches = visible;
      visibleTaskPage = visible.slice(taskPage * taskPageSize, (taskPage + 1) * taskPageSize);
      const nextRows = [], nextIDs = new Set(visibleTaskPage.map(task => String(task.id)));
      for (const id of taskRows.keys()) if (!nextIDs.has(id)) taskRows.delete(id);
      $("fta-pref-task-count").textContent = String(scopeTasks.length);
      $("fta-pref-task-scope").textContent = isBatchFilter(taskFilter)
        ? snapshot.currentBatch?.id ? "当前批次 · " + dateText(snapshot.currentBatch.createdAt, true) + " · 仅统计最近一次批量获取所涉及的任务。" : "尚未记录当前批次。旧任务仍保留在“未完成”和“全部历史”中；从文库再次批量获取后可查看本批次分类。"
        : taskFilter === "all" ? "全部历史 · 跨批次的已获取记录，按完成时间从新到旧排列。" : "未完成 · 跨批次保留所有未完成任务，包括已入库但采纳或对应消息尚未完成的任务。";
      $("fta-pref-task-empty").hidden = visible.length > 0;
      $("fta-pref-task-empty").textContent = terms.length && !visible.length ? "没有匹配的任务。试试其他标题、DOI 或求助编号。" : tasks.length ? taskFilter === "unfinished" ? "当前没有未完成任务。跨批次的已获取记录可在“全部历史”中查看。" : isBatchFilter(taskFilter) && !snapshot.currentBatch?.id ? "从文库发起一次批量获取后，这里会显示当前批次的任务。" : "当前筛选没有任务。" : "还没有任务。在文库多选文献，右击“全文助手 → 批量获取全文”开始批量获取。";
      list.hidden = !visible.length;
      const summary = ["显示 " + visible.length + "/" + scopeTasks.length + " 项"];
      const acquiring = scopeTasks.filter(task => ["finding", "searching", "resolving", "downloading", "validating"].includes(task.state)).length;
      const waitingAssist = scopeTasks.filter(task => task.state === "waiting").length;
      const waitingBrowser = scopeTasks.filter(isBrowserActive).length;
      const scopeQueued = scopeTasks.filter(task => task.state === "queued").length;
      if (acquiring) summary.push("正在获取 " + acquiring + " 项");
      if (scopeQueued) summary.push("排队 " + scopeQueued + " 项");
      if (waitingAssist) summary.push("等待应助 " + waitingAssist + " 项");
      if (waitingBrowser) summary.push("等待浏览器下载 " + waitingBrowser + " 项");
      $("fta-pref-task-summary").textContent = summary.join(" · ");
      for (const node of $("fta-pref-task-filters").querySelectorAll("button")) {
        const filter = node.dataset.filter;
        node.textContent = filterLabels[filter] + " " + tasks.filter(task => matchesFilter(task, filter)).length;
        node.setAttribute("aria-pressed", String(filter === taskFilter));
        node.disabled = busy;
      }
      const capabilities = Object.keys(app).filter(key => typeof app[key] === "function").sort().join(",");
      const common = [busy, currentPoints(), snapshot.settings?.acceptSiteMinimum, snapshot.settings?.language, capabilities];
      for (const task of visibleTaskPage) {
        const id = String(task.id);
        const binding = bindingState?.taskId === task.id ? { taskId: bindingState.taskId, candidates: bindingState.candidates } : null;
        const key = JSON.stringify([task, common, queuePositions.get(task.id), selectedTasks.has(task.id), binding]);
        const cached = taskRows.get(id);
        if (cached?.key === key) { nextRows.push(cached.node);continue; }
        const row = make("article", "fta-row");
        row.dataset.taskId = String(task.id);
        const main = make("div", "fta-row-main");
        const name = titleText(task.title) || task.doi || "未命名文献";
        if (canOfferAssist(task)) {
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
        const title = make("div", "fta-row-title");title.append(copyControl(name, "复制标题"));main.append(title);
        const acquired = isAcquired(task);
        const submissionReview = task.submissionReview?.requestID && task.submissionReview?.requestURL ? task.submissionReview : null;
        const assistPending = needsAssistCompletion(task);
        const receiptLabel = assistPending ? task.assistReceipt.needsReconcile ? "已获取 · 采纳待核实" : task.assistReceipt.adoption === "accepted" ? "已采纳 · 待已读" : "已获取 · 待采纳" : acquired && isAssistComplete(task) ? "已采纳 · 对应消息已读" : "";
        const unboundAvailable = task.state === "available" && !task.itemID;
        const badge = make("span", "fta-status-badge", submissionReview ? "已发布求助待核对" : receiptLabel || (unboundAvailable ? "待关联文献" : task.state === "queued" ? "排队中 · 第 " + queuePositions.get(task.id) + " 位" : taskLabels[task.state] || "待处理"));
        if (acquired) badge.dataset.tone = "success";
        if (["error", "failed"].includes(task.state)) badge.dataset.tone = "error";
        if (["pending_login", "needs_login", "not_found", "needs_review", "captcha", "submission_unknown", "manual_review"].includes(task.state)) badge.dataset.tone = "warning";
        if (unboundAvailable || assistPending || submissionReview) badge.dataset.tone = "warning";
        main.append(badge);
        row.append(main);
        const completedDate = acquired ? dateText(task.completedAt || task.importedAt || task.updatedAt, true) : "";
        const routeLabel = task.downloadRoute === "highspeed" ? "免积分高速" : task.downloadRoute === "normal" ? "普通线路" : "";
        const showRoute = acquired ? task.source === "ablesci" : ["downloading", "validating"].includes(task.state) && Boolean(task.source === "ablesci" || task.requestID || task.requestURL);
        const route = showRoute ? routeLabel : "";
        const hasRequest = Boolean(task.requestID || task.requestURL);
        const knownPoints = task.pointsVerified === true && Number.isSafeInteger(task.requestedPoints) && task.requestedPoints > 0;
        const pointsLabel = hasRequest || task.source === "ablesci" ? knownPoints ? task.assistReceipt?.adoption === "accepted" ? "已支出 " + task.requestedPoints + " 积分" : "悬赏 " + task.requestedPoints + " 积分（待采纳）" : "积分待核实" : "";
        const fulltextVersionLabels = { published: "全文版本：出版版", accepted: "全文版本：作者接受稿", submitted: "全文版本：预印本", unknown: "全文版本：版本未核实" };
        const versionLabel = acquired && (task.fulltextVersion || ["openalex", "pmc", "core", "semanticScholar", "custom"].includes(task.source)) ? fulltextVersionLabels[task.fulltextVersion] || fulltextVersionLabels.unknown : "";
        const meta = (acquired ? [completedDate ? "完成 " + completedDate : "完成日期未记录", ...sourceText(task), versionLabel, task.source === "ablesci" ? pointsLabel : "", route, task.doi] : [task.doi, task.requestID ? "求助 " + task.requestID : "", pointsLabel, route ? "来源：科研通" : "", route, task.lastCheckedAt ? "最近检查 " + dateText(task.lastCheckedAt) : ""]).filter(Boolean);
        if (meta.length) {
          const metadata = make("div", "fta-row-meta");
          meta.forEach((part, index) => { if (index) metadata.append(document.createTextNode(" · "));metadata.append(part === task.doi ? copyControl(task.doi, "复制 DOI", "fta-doi-copy") : make("span", "", part)); });
          row.append(metadata);
        }
        const note = unboundAvailable ? "应助文件已就绪，但此任务仅跟踪求助，尚未关联 Zotero 文献。请先关联文献，才能下载到文库。" : assistPending ? task.assistReceipt.lastError || (task.assistReceipt.needsReconcile ? "PDF 已入库；采纳结果尚未核实，请先核实网站状态。" : task.assistReceipt.adoption === "accepted" ? "应助文件已采纳；仍需将这份文件对应的上传消息标记已读。" : "PDF 已入库；仍需采纳这份应助文件并标记对应上传消息已读。") : acquired ? hasRequest && !task.assistReceipt ? task.lastError || "此任务有关联求助。可核验科研通文件：仅当网站文件与已保存 PDF 完全一致且论文身份匹配时，才记录科研通来源、采纳并处理对应消息。" : "" : task.message || task.lastError || browserNotes[task.state];
        if (note) row.append(make("p", "fta-row-note", note));
        if (submissionReview) {
          const review = make("div", "fta-submission-review");
          review.setAttribute("role", "group");review.setAttribute("aria-label", "已发布求助待核对");
          for (const [label, value] of [["条目 DOI：", submissionReview.expectedDOI || task.doi], ["网站 DOI：", submissionReview.receivedDOI]]) {
            const line = make("p", "fta-review-doi");line.append(make("span", "", label));
            line.append(value ? copyControl(String(value), "复制 DOI") : make("span", "", "未提供"));review.append(line);
          }
          review.append(make("p", "fta-note", "网站已返回求助记录，但尚未通过 DOI 核验。请对照 Zotero 条目与网站详情；确认条目 DOI 写错时，先修改原条目，再点击“立即检查”。"));
          review.append(make("p", "fta-note", "检查只核对这条已发布求助，不会重新发布。DOI 确实不一致时，不会关联或采纳。"));
          row.append(review);
        }
        if (task.doiCheck) {
          const check = task.doiCheck;
          const details = make("details", "fta-doi-check");
          const checkLabels = { match: "网站文献信息 · DOI 一致", doi_mismatch: "网站文献信息 · DOI 不一致", doi_missing: "网站文献信息 · 网站未提供 DOI", doi_invalid: "网站文献信息 · 网站 DOI 无效" };
          details.append(make("summary", "", checkLabels[check.reason] || "网站文献信息 · 待核实"));
          if (expandedDOIChecks.has(String(task.id))) details.setAttribute("open", "");
          for (const [label, value, copyLabel] of [["条目 DOI：", check.expectedDOI, "复制 DOI"], ["网站 DOI：", check.receivedDOI, "复制 DOI"], ["条目标题：", check.expectedTitle, "复制标题"], ["网站标题：", check.receivedTitle, "复制标题"]]) {
            const line = make("p", "fta-review-doi");line.append(make("span", "", label));
            line.append(value ? copyControl(String(value), copyLabel) : make("span", "", "未提供"));details.append(line);
          }
          const checkNotes = {
            match: "DOI 一致，请核对标题后重试。此检查不会发布求助。",
            doi_mismatch: "网站返回的 DOI 与条目不同。请先核对出版社原文和 Zotero 条目；此检查不会发布求助，也不会确认两篇文献相同。",
            doi_missing: "网站查询未提供 DOI，尚不能确认文献身份。请核对原文后再重试；此检查不会发布求助。",
            doi_invalid: "网站返回的 DOI 无法验证，尚不能确认文献身份。请核对原文后再重试；此检查不会发布求助。"
          };
          details.append(make("p", "fta-note", checkNotes[check.reason] || "文献信息尚未核实；此检查不会发布求助。"));
          if (check.checkedAt) details.append(make("p", "fta-note", "最近核对 " + dateText(check.checkedAt, true)));
          row.append(details);
        }
        const access = acquired && (task.source === "ablesci" || hasRequest) ? null : task.accessHint;
        if (access?.scope === "article" && access.institutionalConfirmed === true) row.append(make("p", "fta-note", "此论文已确认机构访问。"));
        else if (access?.scope === "host_hint") row.append(make("p", "fta-note", "同一站点曾有成功记录，仅供参考；当前论文的访问权限仍需验证。"));
        else if (access?.scope === "article" && access.kind === "browser_success") row.append(make("p", "fta-note", "此论文曾通过浏览器获取全文；尚未确认机构权限。"));
        const evidenceLabels = { institutional_entry: "页面提供机构登录入口；这不代表当前账号拥有此论文权限。", institutional_hint: "页面可能提供机构访问方式，当前论文的权限仍需验证。", login_hint: "页面提示登录；登录成功仍不代表此论文可下载。", request_restricted: "页面提示访问受限，可在浏览器核对机构访问方式。", human_verification: "页面要求真人验证，请在日常浏览器自行完成。", automatic_not_found: "自动查找未找到可用全文，可在浏览器继续核对。" };
        if (!acquired && evidenceLabels[task.accessEvidence?.kind]) row.append(make("p", "fta-note", evidenceLabels[task.accessEvidence.kind]));
        const actions = make("div", "fta-row-actions");
        const done = ["imported", "completed", "closed"].includes(task.state);
        if (!acquired && (!isBrowserRoute(task) || hasRequest || submissionReview)) actions.append(button("立即检查", "checkTask", [task.id], done));
        if (submissionReview) actions.append(button("打开已发布求助核对", "openSubmissionReview", [task.id], false, "请核对网站 DOI 与原文献；如需修正，请修改 Zotero 条目后再点“立即检查”。"));
        if (!acquired && !hasRequest && !submissionReview && task.doi && ["error", "not_found", "needs_review"].includes(task.state)) actions.append(button("核对网站文献信息", "inspectDOI", [task.id], false, () => {
          const updatedRow = [...$("fta-pref-task-list").children].find(node => node.dataset.taskId === String(task.id));
          updatedRow?.querySelector(".fta-doi-check")?.setAttribute("open", "");
          expandedDOIChecks.add(String(task.id));
          return "网站文献信息已核对，请查看本任务的 DOI 和标题对比；未发布求助。";
        }));
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
        if (acquired && hasRequest && task.attachmentID && !task.assistReceipt) actions.append(button("核验科研通文件", "verifyAssistCompletion", [task.id], false, result => result?.completed ? "已核验原文件，采纳与对应消息已读均已完成。" : result?.message || "核验结果已更新，请查看任务提示。"));
        if (acquired && !hasRequest && ["browser_download", "local_file"].includes(task.source) && !access?.institutionalConfirmed && typeof app.confirmInstitutionalAccess === "function") actions.append(button("这是通过机构获取", "confirmInstitutionalAccess", [task.id], false, "已确认机构访问方式。"));
        if (acquired && access?.scope === "article" && access.institutionalConfirmed && typeof app.forgetInstitutionalAccess === "function") actions.append(button("撤销机构确认", "forgetInstitutionalAccess", [task.id], false, "已撤销此论文的机构访问确认。"));
        if (!submissionReview && task.itemID && !acquired && (hasRequest || isFallback(task) || isBrowserRoute(task) || ["needs_login", "needs_review", "error", "failed", "pending_login", "captcha", "paused"].includes(task.state))) {
          if (!hasRequest) actions.append(button("浏览器下载并自动入库", "openSystemBrowserTask", [task.id], false, manualDownloadMessage));
          actions.append(button("选择已下载的PDF", "importLocalPDF", [task.id], false, result => result?.cancelled ? "已取消选择文件。" : result?.needsReview ? "请先预览所选 PDF，核对后再确认导入。" : "本地 PDF 处理结果已更新。"));
        }
        if (task.state === "manual_review") {
          const assistReview = Boolean(task.assistReview?.fileID && task.assistReview?.createdAt);
          if (task.pendingFilename) row.append(make("p", "fta-note", "待核对文件：" + task.pendingFilename));
          if (task.pendingTitle) row.append(make("p", "fta-note", "待关联文献：" + titleText(task.pendingTitle)));
          if (task.pendingSummary) row.append(make("p", "fta-note", task.pendingSummary));
          if (assistReview) row.append(make("p", "fta-note", "确认后将入库并采纳这份应助文件，结算该求助的原悬赏" + (knownPoints ? "（" + task.requestedPoints + " 积分）" : "") + "；随后只将对应上传消息标记已读。"));
          else if (hasRequest) row.append(make("p", "fta-note", "请明确确认所选文件对应这篇论文。入库后还会核验科研通文件；只有文件完全一致才归为科研通并采纳，无法核验时保留本地来源。"));
          actions.append(button("预览待核对 PDF", "previewDownloadedPDF", [task.id], !task.pendingFilename, "请核对 PDF 的标题、作者和 DOI，再决定是否导入。"));
          actions.append(button(assistReview ? "确认对应论文并入库、采纳" : "我已核对，是这篇论文", "confirmDownloadedPDF", [task.id], !task.pendingFilename, assistReview ? "核验与入库结果已更新，采纳及对应消息状态见任务列表。" : "PDF 已保存到原文献。"));
          actions.append(button("取消这次导入", "dismissDownloadedPDF", [task.id], false, assistReview ? "已取消这次应助文件导入，任务保留；未确认的文件不会因此采纳。" : "已取消，任务保留。可重新选择文件，或点击“浏览器下载并自动入库”重新开始检查。"));
        }
        if (!submissionReview && !acquired && task.itemID && (hasRequest || ["manual_waiting", "paused"].includes(task.state))) actions.append(button("检查已下载文件", "recheckDownloadedPDFs", [task.id], false, "下载检查结果已更新，请查看任务中的检查详情。"));
        if (isBrowserActive(task)) actions.append(button("暂停监控", "pauseTask", [task.id], false, hasRequest ? "已暂停下载文件夹检查，已有求助保留；可点击“检查已下载文件”继续。" : "已暂停下载文件夹检查；可重新点击“浏览器下载并自动入库”恢复。"));
        else if (!submissionReview && ["paused", "error", "failed", "not_found", "needs_login", "pending_login", "needs_review"].includes(task.state) && (!isBrowserRoute(task) || hasRequest)) {
          const unsubmitted = !task.requestID && !task.requestURL;
          actions.append(button(unsubmitted ? "按 " + pointsText() + "重试" : "重试", "retryTask", unsubmitted ? [task.id, { points: currentPoints() }] : [task.id], false, "任务已恢复。"));
        }
        else if (!submissionReview && !acquired && !isBrowserRoute(task)) actions.append(button("暂停", "pauseTask", [task.id], done, task.requestURL ? "已暂停本地检查，网站上的求助仍然保留。" : "任务已暂停。"));
        if (canOfferAssist(task)) {
          actions.append(button("科研通求助（" + pointsText() + "）", "requestAssist", [[task.id], { points: currentPoints() }], !canAssist(task), assistMessage));
          if (!canAssist(task)) actions.append(make("span", "fta-secondary", "补全 DOI 后可求助"));
          if (snapshot.settings?.acceptSiteMinimum === true) row.append(make("p", "fta-note", "已启用自动接受网站最低积分；最终悬赏可能高于按钮中的基础积分。"));
        }
        row.append(actions);
        renderSourceDiagnostics(task, row);
        if (!acquired) renderDownloadDetails(task, row);
        if (unboundAvailable) renderBinding(task, row);
        taskRows.set(id, { key, node: row });
        nextRows.push(row);
      }
      reconcileRows(list, nextRows);
      renderSelection();
    }
    function renderSourceDiagnostics(task, row) {
      const records = Array.isArray(task.sourceDiagnostics) ? task.sourceDiagnostics.filter(value => value && typeof value === "object").slice(0, 24) : [];
      if (!records.length) return;
      const messages = {
        invalid_doi: "需要有效的 DOI 或 PMCID。", no_result: "此来源未返回可下载候选。", no_pdf: "记录中没有可用 PDF。",
        metadata_only: "此来源的 API 结果仅用于发现链接，仍需实际下载并核验 PDF。", key_required: "此操作需要先配置 API 密钥。", content_disabled: "未启用此来源的内容下载。",
        daily_limit: "本机下载计数不可用或已达到每日上限。", version_filtered: "候选版本不符合当前偏好，已跳过。", unknown_version: "此来源未说明全文版本，版本待核实。",
        doi_mismatch: "来源记录的 DOI 与目标文献不一致。", unsafe_url: "网址不是受支持的公共 HTTPS 地址，已拒绝。", dns_unavailable: "无法核实目标是否为公共网络地址。",
        private_address: "目标指向私有或保留地址，已拒绝。", invalid_template: "模板必须是公共 HTTPS 网址，{doi} 不能位于主机名中。", template_limit: "仅使用前 8 个不同的模板。",
        human_verification: "此页面需要人工验证，请在浏览器完成。", login_required: "此来源要求身份验证，或当前请求权限不足。", response_too_large: "来源响应超过本次检查的大小限制。",
        invalid_response: "来源响应格式无法识别。", unexpected_redirect: "跳转目标尚未核实，已停止。", rate_limited: "此来源要求稍后重试，本次已暂停查询。",
        timeout: "此来源查询或下载超时，可稍后重试。", network_error: "此来源网络请求失败，可稍后重试。", disabled: "此来源已关闭。", key_storage: "无法读取已配置的 API 密钥。", endpoint_backoff: "此端点因访问限制或限流暂缓重复请求，其他来源仍会继续。",
        source_not_enabled: "此候选的来源已关闭，未继续下载。", untrusted_candidate: "无法确认候选来源，已停止下载。", credentials_in_url: "网址包含凭据，已拒绝。", retracted: "此来源将该版本标记为已撤稿，已跳过。",
        pdf_mismatch: "PDF 的 DOI 或标题与目标论文冲突，已拒绝自动入库。", pdf_unknown: "已取得 PDF，但 DOI 和标题证据不足，需要预览核对。",
        download_restricted: "此来源下载受限，可尝试其他来源或浏览器下载。", download_failed: "此来源下载失败，未取得可用全文。"
      };
      const details = make("details", "fta-source-diagnostics");
      if (expandedSourceDetails.has(String(task.id))) details.setAttribute("open", "");
      details.append(make("summary", "", "来源检查详情"));
      details.append(make("p", "fta-note", "候选链接不代表已取得全文；以 PDF 核对和入库结果为准。"));
      const list = make("dl", "fta-source-diagnostic-list");
      for (const record of records) {
        const item = make("div", "fta-source-diagnostic-row");
        item.append(make("dt", "", sourceLabels[record.source] || (record.source === "openAccess" ? "Zotero 开放获取" : "其他来源")));
        item.append(make("dd", "", messages[record.code] || String(record.message || "此来源检查未完成，请查看任务提示。")));
        list.append(item);
      }
      details.append(list);row.append(details);
    }
    function renderDownloadDetails(task, row) {
      const downloadStatus = task.downloadStatus;
      const storedCandidates = Array.isArray(task.downloadCandidates) ? task.downloadCandidates : [];
      // Ranking and identity classification are supplied by the PDF checker.
      // Older unknown records must not become recommendations merely because
      // they were stored in a candidate list by a previous plugin version.
      const score = candidate => Number.isFinite(candidate.candidateScore) && candidate.candidateScore >= 0 && candidate.candidateScore <= 1 ? candidate.candidateScore : -1;
      const candidates = storedCandidates.filter(candidate => candidate?.id && candidate.related === true)
        .sort((a, b) => score(b) - score(a)).slice(0, 3);
      const categoryLabels = { mismatch: "明确不匹配", unrelated: "低相关", unreadable: "识别不足" };
      const diagnostics = (Array.isArray(task.downloadDiagnostics) ? task.downloadDiagnostics : [])
        .filter(record => record && Object.hasOwn(categoryLabels, record.category)).slice(0, 5);
      if (!downloadStatus && !storedCandidates.length && !diagnostics.length) return;
      const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
      const scanned = count(downloadStatus?.scanned);
      const related = count(downloadStatus?.related);
      const unreadable = count(downloadStatus?.unreadable);
      const unrelated = count(downloadStatus?.unrelated);
      const mismatch = count(downloadStatus?.mismatched ?? downloadStatus?.mismatch);
      const classified = [scanned, related, unreadable, unrelated, mismatch].every(value => value !== null);
      const details = make("details", "fta-download-details");
      details.append(make("summary", "", "下载检查详情"));
      if (expandedDownloadDetails.has(String(task.id))) details.setAttribute("open", "");
      if (classified) details.append(make("p", "fta-download-counts", "已检查 " + scanned + " 个 PDF；相关候选 " + related + " 个，已排除 " + (unrelated + mismatch) + " 个，识别不足 " + unreadable + " 个。"));
      else {
        if (scanned !== null) details.append(make("p", "fta-note", "已检查 " + scanned + " 个 PDF。"));
        details.append(make("p", "fta-note", "此记录尚无完整的相关性分类，请重新检查已下载文件。"));
      }
      if (downloadStatus?.lastScanAt) details.append(make("p", "fta-note", "最近检查 " + dateText(downloadStatus.lastScanAt)));
      if (candidates.length) {
        details.append(make("p", "fta-candidate-heading", "推荐核对"));
        details.append(make("p", "fta-note", "仅展示最相关的 " + candidates.length + " 个候选。请预览核对；预览不会自动确认或导入。"));
        for (const candidate of candidates) {
          const candidateRow = make("div", "fta-download-candidate");
          candidateRow.dataset.candidateId = String(candidate.id);
          candidateRow.append(raw(make("span", "fta-candidate-name", candidate.filename || "PDF")));
          renderPDFEvidence(candidate, candidateRow);
          candidateRow.append(button("预览并核对", "reviewDownloadCandidate", [task.id, candidate.id], false, "请核对 PDF 的标题、作者和 DOI，再决定是否导入。"));
          details.append(candidateRow);
        }
      } else if (classified) details.append(make("p", "fta-note", "尚未找到足够相关的候选。"));
      if (diagnostics.length || classified && unreadable + unrelated + mismatch > 0) {
        const diagnostic = make("details", "fta-download-diagnostics");
        diagnostic.append(make("summary", "", "已排除与识别不足"));
        if (expandedDownloadDiagnostics.has(String(task.id))) diagnostic.setAttribute("open", "");
        if (classified) diagnostic.append(make("p", "fta-note", "明确不匹配 " + mismatch + " 个；低相关 " + unrelated + " 个；识别不足 " + unreadable + " 个。"));
        diagnostic.append(make("p", "fta-note", "已排除的文件不会作为推荐候选。识别不足表示证据不够，不能据此断定文件错误；如确认是目标论文，可选择已下载的 PDF 预览并核对。"));
        if (diagnostics.length) diagnostic.append(make("p", "fta-note", "以下仅显示部分诊断记录。"));
        for (const record of diagnostics) {
          const recordRow = make("div", "fta-download-diagnostic");
          const heading = make("div", "fta-diagnostic-heading");
          heading.append(raw(make("span", "fta-diagnostic-name", record.filename || "PDF")), make("span", "fta-diagnostic-category", categoryLabels[record.category]));
          recordRow.append(heading);
          renderPDFEvidence(record, recordRow);
          diagnostic.append(recordRow);
        }
        details.append(diagnostic);
      }
      row.append(details);
    }
    function renderPDFEvidence(record, container) {
      const evidence = record.evidence || {};
      const basisLabels = {
        article_doi_match: "本文 DOI 一致", article_doi_mismatch: "本文 DOI 不同",
        front_title_match: "首页完整标题一致", front_title_similar: "首页标题相近，待核对", front_title_different: "首页标题不同",
        identity_conflict: "DOI 与标题证据冲突", title_outside_front_matter: "目标标题仅在后续版面或参考文献区域",
        no_reliable_identity: "没有可靠的本文身份信息", no_extractable_text: "未提取到可核验文字", extraction_failed: "文字提取失败或不可用"
      };
      const metadata = make("div", "fta-pdf-evidence");
      const line = (label, value, className, isRaw = false) => {
        const paragraph = make("p", className);paragraph.append(make("span", "fta-evidence-label", label));
        const content = make("span", "", value);paragraph.append(isRaw ? raw(content) : content);metadata.append(paragraph);
      };
      line("识别标题：", record.detectedTitle ? titleText(record.detectedTitle) : "未可靠识别", "fta-detected-title", Boolean(record.detectedTitle));
      const dois = Array.isArray(record.detectedDOIs) ? record.detectedDOIs.filter(value => typeof value === "string" && value).slice(0, 5) : [];
      line("识别 DOI：", dois.length ? dois.join(" · ") : "未可靠识别", "fta-detected-dois", dois.length > 0);
      const basis = Array.isArray(evidence.candidateBasis) ? [...new Set(evidence.candidateBasis)].filter(value => Object.hasOwn(basisLabels, value)) : [];
      if (basis.length) {
        const paragraph = make("p", "fta-evidence-basis");paragraph.append(make("span", "fta-evidence-label", "判定依据："));
        basis.forEach((value, index) => { if (index) paragraph.append(document.createTextNode(" · "));paragraph.append(make("span", "", basisLabels[value])); });
        metadata.append(paragraph);
      }
      if (Number.isFinite(record.titleSimilarity) && record.titleSimilarity >= 0 && record.titleSimilarity <= 1) {
        const similarity = make("p", "fta-title-similarity", "标题相似度 " + Math.round(record.titleSimilarity * 100) + "%");
        similarity.title = "文字相似度用于辅助筛选，不是论文匹配概率。";metadata.append(similarity);
      }
      if (record.message) metadata.append(make("p", "fta-note", record.message));
      container.append(metadata);
    }
    function renderCheckIn() {
      const info = snapshot.checkIn || {}, currentDate = new Date();
      const localDay = date => date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
      const today = localDay(currentDate), checkedDate = new Date(info.checkedAt || "");
      const queriedToday = Number.isFinite(checkedDate.getTime()) && localDay(checkedDate) === today;
      const todayKnown = info.day === today;
      const signedOut = info.state === "signed_out" || ["signed_out", "logged_out"].includes(snapshot.session?.status);
      const hasBalance = !signedOut && Number.isSafeInteger(info.balance) && info.balance >= 0;
      $("fta-pref-checkin-balance").textContent = hasBalance ? info.balance + " 积分" : "—";
      $("fta-pref-checkin-balance-label").textContent = hasBalance && (["error", "idle"].includes(info.state) || !queriedToday) ? "上次查询余额" : "可用积分";
      $("fta-pref-checkin-state").textContent = signedOut ? "登录后查询" : info.state === "checking" ? "正在查询…" : todayKnown && info.signed === true ? "今日已签到" : todayKnown && info.signed === false ? "今日未签到" : todayKnown && info.checkedAt && ["loaded", "error"].includes(info.state) ? "今日状态待核实" : info.day && !todayKnown ? "今日状态待刷新" : "尚未查询";
      $("fta-pref-checkin-reward").textContent = !signedOut && todayKnown && info.signed === true ? info.rewardVerified === true && Number.isSafeInteger(info.reward) && info.reward >= 0 ? "已到账 " + info.reward + " 积分" : "到账待核实" : "—";
      $("fta-pref-checkin-open").textContent = !signedOut && todayKnown && info.signed === true ? "查看签到页面" : "去网页签到";
      $("fta-pref-checkin-refreshed").textContent = info.checkedAt ? "最近查询 " + dateText(info.checkedAt, true) : "尚未查询";
      const message = checkInStartupError || (signedOut ? "登录科研通后可查询余额与今日签到。" : String(info.message || ""));
      $("fta-pref-checkin-message").textContent = message;
      $("fta-pref-checkin-message").hidden = !message;
      $("fta-pref-checkin-message").dataset.error = String(Boolean(checkInStartupError) || info.state === "error");
    }
    function renderSpending() {
      if (activePage !== "account") return;
      const time = value => { const parsed = Date.parse(value || "");return Number.isFinite(parsed) ? parsed : 0; };
      const records = currentTasks().filter(task => isAcquired(task) && task.source === "ablesci" && task.requestID && task.assistReceipt?.adoption === "accepted" && (!task.assistReceipt.requestID || task.assistReceipt.requestID === task.requestID))
        .sort((a, b) => time(b.assistReceipt.acceptedAt) - time(a.assistReceipt.acceptedAt) || time(b.updatedAt) - time(a.updatedAt) || String(a.id).localeCompare(String(b.id)));
      const key = JSON.stringify([records.map(task => [task.id, task.requestID, task.title, task.doi, task.requestedPoints, task.pointsVerified, task.assistReceipt?.acceptedAt]), snapshot.settings?.language]);
      if (spendingKey === key) return;
      spendingKey = key;
      // A website request ID represents one settlement, including when the same
      // request is retained in multiple local item/account histories.
      const requests = new Map();
      for (const task of records) if (!requests.has(task.requestID)) requests.set(task.requestID, task);
      const accepted = [...requests.values()];
      const amountKnown = task => task.pointsVerified === true && Number.isSafeInteger(task.requestedPoints) && task.requestedPoints > 0 && task.requestedPoints <= 10000;
      const known = accepted.filter(amountKnown), unknown = accepted.length - known.length;
      const total = known.reduce((sum, task) => sum + task.requestedPoints, 0);
      $("fta-pref-spending-total").textContent = total + " 积分";
      $("fta-pref-spending-count").textContent = accepted.length + " 篇";
      $("fta-pref-spending-average").textContent = known.length ? (total / known.length).toFixed(1) + " 积分" : "—";
      $("fta-pref-spending-coverage").textContent = "金额已核实 " + known.length + " 篇；金额待核实 " + unknown + " 篇，未计入支出和均价。";
      const list = $("fta-pref-spending-list");list.replaceChildren();
      $("fta-pref-spending-empty").hidden = accepted.length > 0;
      for (const task of accepted.slice(0, 10)) {
        const row = make("article", "fta-spending-record");row.dataset.requestId = String(task.requestID);
        const title = make("div", "fta-spending-title");title.append(copyControl(titleText(task.title) || task.doi || "未命名文献", "复制标题"));row.append(title);
        const metadata = make("div", "fta-row-meta");
        const acceptedAt = dateText(task.assistReceipt.acceptedAt, true);
        metadata.append(make("span", "", acceptedAt ? "采纳 " + acceptedAt : "采纳时间未记录"), document.createTextNode(" · "), make("span", "", amountKnown(task) ? "已支出 " + task.requestedPoints + " 积分" : "积分待核实（未计入积分统计）"));
        if (task.doi) metadata.append(document.createTextNode(" · "), copyControl(task.doi, "复制 DOI"));
        row.append(metadata);list.append(row);
      }
    }
    function renderMessages() {
      if (activePage !== "messages") return;
      const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
      const terms = searchTerms(messageQuery);
      const matching = messages.filter(message => (messageFilter === "all" || messageFilter === "read" && message.read === true || messageFilter === "unread" && message.read !== true) && includesTerms(terms, [message.title, message.text, message.summary]));
      const info = snapshot.messagesStatus || {};
      const list = $("fta-pref-message-list");
      messagePage = pagination("message", matching.length, messagePage, messagePageSize, messages.length);
      const pageMessages = matching.slice(messagePage * messagePageSize, (messagePage + 1) * messagePageSize);
      const nextRows = [], nextIDs = new Set(pageMessages.map(message => String(message.id)));
      for (const id of messageRows.keys()) if (!nextIDs.has(id)) messageRows.delete(id);
      $("fta-pref-message-empty").hidden = matching.length > 0;
      $("fta-pref-message-empty").textContent = messages.length ? "没有匹配的消息。请调整搜索词或筛选条件。" : info.state === "loaded" ? "暂无消息。" : "尚未读取科研通消息。";
      const lastRefreshed = dateText(info.lastCheckedAt);
      $("fta-pref-messages-refreshed").textContent = lastRefreshed ? "最近刷新 " + lastRefreshed : "尚未刷新";
      $("fta-pref-messages-state").textContent = String(info.message || (info.state === "loading" ? "正在刷新消息…" : info.state === "error" ? "消息刷新未完成，请稍后再试。" : info.state === "loaded" || lastRefreshed ? "" : "登录后可查看科研通应助提醒。"));
      $("fta-pref-messages-state").hidden = !$("fta-pref-messages-state").textContent;
      $("fta-pref-messages-state").dataset.error = String(info.state === "error");
      for (const message of pageMessages) {
        const id = String(message.id), key = JSON.stringify([message, busy, snapshot.settings?.language, typeof app.openMessage]);
        const cached = messageRows.get(id);
        if (cached?.key === key) { nextRows.push(cached.node);continue; }
        const row = make("article", "fta-row");
        row.dataset.messageId = id;
        const main = make("div", "fta-row-main");
        main.append(message.title ? raw(make("div", "fta-row-title", message.title)) : make("div", "fta-row-title", "科研通消息"));
        main.append(make("span", "fta-row-meta", dateText(message.createdAt)));
        row.append(main);
        const summary = String(message.text || message.summary || "").trim();
        if (summary) row.append(raw(make("p", "fta-message-summary", summary.slice(0, 220) + (summary.length > 220 ? "…" : ""))));
        const actions = make("div", "fta-row-actions");
        actions.append(button("查看", "openMessage", [message.id]));
        row.append(actions);
        messageRows.set(id, { key, node: row });nextRows.push(row);
      }
      reconcileRows(list, nextRows);
      localize();
    }
    function renderActivePage() {
      if (activePage === "tasks") { renderTasks();renderRequestTargets(); }
      else if (activePage === "messages") renderMessages();
      else if (activePage === "account") renderSpending();
      localize();
    }
    function renderSnapshot() {
      if (destroyed) return;
      snapshot = app.getSnapshot() || {};
      currentBatchIDs = new Set(Array.isArray(snapshot.currentBatch?.taskIDs) ? snapshot.currentBatch.taskIDs : []);
      const session = snapshot.session || {};
      const settings = snapshot.settings || {};
      const language = ["zh-CN", "zh-TW", "en"].includes(settings.language) ? settings.language : "zh-CN";
      for (const option of $("fta-pref-language").querySelectorAll("option")) option.selected = option.value === language;
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
        $("fta-pref-site-minimum").checked = settings.acceptSiteMinimum === true;
        $("fta-pref-checkin-reminder").checked = settings.checkInReminder !== false;
      }
      renderNavigation();
      renderCaptureSummary();
      renderDirectories();
      renderSourceSettings();
      renderUpdater();
      renderCheckIn();
      renderActivePage();
      const methodButtons = { "fta-pref-save-login": "saveCredentialsAndLogin", "fta-pref-web-login": "openLogin", "fta-pref-logout": "logout", "fta-pref-save-settings": "saveSettings", "fta-pref-add-request": "addExistingRequest", "fta-pref-refresh-messages": "refreshMessages", "fta-pref-choose-directory": "chooseDownloadDirectory", "fta-pref-detect-directories": "detectDownloadDirectories" };
      for (const [id, method] of Object.entries(methodButtons)) $(id).disabled = busy || typeof app[method] !== "function";
      for (const id of ["fta-pref-username", "fta-pref-password", "fta-pref-points", "fta-pref-poll", "fta-pref-auto-download", "fta-pref-site-minimum", "fta-pref-checkin-reminder", "fta-pref-request-url", "fta-pref-request-target", "fta-pref-request-search", "fta-pref-message-filter"]) $(id).disabled = busy;
      $("fta-pref-checkin-refresh").disabled = busy || snapshot.checkIn?.state === "checking" || snapshot.checkIn?.state === "signed_out" || !["authenticated", "logged_in"].includes(snapshot.session?.status) || typeof app.refreshCheckIn !== "function";
      $("fta-pref-checkin-open").disabled = busy || typeof app.openCheckIn !== "function";
      $("fta-pref-language").disabled = busy || typeof app.saveSettings !== "function";
      localize();
    }
    function render() {
      if (destroyed) return;
      renderDepth++;
      try { renderSnapshot(); }
      finally { renderDepth--;localize(); }
    }
    async function run(action, message = "", sensitive = false, options = {}) {
      if (busy || destroyed) return;
      const target = options.target || "fta-pref-status";
      busy = true; render(); status("正在处理…", false, target);
      try { const result = await action(); if (!destroyed) status(typeof message === "function" ? message(result) : message || "已更新。", false, target); return result; }
      catch (error) { if (!destroyed) status(options.errorMessage || (sensitive ? "登录未完成，请检查账号密码或使用网页登录完成验证。" : error?.message || "操作未完成，请稍后再试。"), true, target); }
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
    const sourceChanged = () => {
      if (busy) return;
      sourceSettingsDirty = true;
      status("有未保存的更改", false, "fta-pref-source-save-state");
      renderSourceSettings();renderNavigation();
    };
    for (const id of sourceSettingIDs) {
      on($(id), "input", sourceChanged);
      on($(id), "change", sourceChanged);
    }
    on($("fta-pref-source-settings-form"), "submit", event => {
      event.preventDefault();
      if (busy || $("fta-pref-save-sources").disabled) return;
      let settings;
      try { settings = sourceSettingsInput(); }
      catch (error) { return status(error.message, true, "fta-pref-source-save-state"); }
      run(async () => { await app.saveSourceSettings(settings); sourceSettingsDirty = false; }, "全文来源设置已保存。", false, { target: "fta-pref-source-save-state" });
    });
    const sourceCredentialChanged = () => {
      if (busy) return;
      sourceCredentialsDirty = true;
      status("有未保存的更改", false, "fta-pref-source-key-state");
      renderSourceSettings();renderNavigation();
    };
    for (const provider of sourceKeyIDs) {
      on($("fta-pref-key-" + provider), "input", sourceCredentialChanged);
      on($("fta-pref-key-" + provider + "-clear"), "change", sourceCredentialChanged);
    }
    on($("fta-pref-source-credentials-form"), "submit", event => {
      event.preventDefault();
      if (busy || $("fta-pref-save-source-keys").disabled) return;
      const values = {};
      for (const provider of sourceKeyIDs) {
        const value = String($("fta-pref-key-" + provider).value || "").trim();
        if ($("fta-pref-key-" + provider + "-clear").checked) values[provider] = null;
        else if (value) values[provider] = value;
      }
      if (!Object.keys(values).length) {
        sourceCredentialsDirty = false;renderNavigation();
        return status("未修改 API 密钥；已保存的密钥保持不变。", false, "fta-pref-source-key-state");
      }
      run(async () => {
        await app.saveSourceCredentials(values);
        for (const provider of sourceKeyIDs) { $("fta-pref-key-" + provider).value = "";$("fta-pref-key-" + provider + "-clear").checked = false; }
        sourceCredentialsDirty = false;
      }, "API 密钥已保存。", false, { target: "fta-pref-source-key-state", errorMessage: "API 密钥保存未完成，请检查输入或凭据存储后重试。输入已保留。" });
    });
    function checkedUpdateResult(result) {
      const info = result && typeof result === "object" ? result : app.getSnapshot()?.updateStatus;
      if (info?.state === "error") throw new Error(info.message || "更新操作未完成，请重试。");
      return result;
    }
    on($("fta-pref-check-update"), "click", () => {
      if ($("fta-pref-check-update").disabled) return;
      run(async () => checkedUpdateResult(await app.checkForUpdates()), "更新检查已完成，请查看版本状态。", false, { target: "fta-pref-update-action-status" });
    });
    on($("fta-pref-install-update"), "click", () => {
      if ($("fta-pref-install-update").disabled || snapshot.updateStatus?.canInstall !== true) return;
      run(async () => checkedUpdateResult(await app.installUpdate()), "更新操作已完成，请查看版本状态。", false, { target: "fta-pref-update-action-status" });
    });
    on($("fta-pref-release-notes"), "click", () => {
      if ($("fta-pref-release-notes").disabled) return;
      run(() => app.openReleaseNotes(), "已打开更新日志。", false, { target: "fta-pref-update-action-status" });
    });
    on($("fta-pref-auto-update"), "change", () => {
      if (busy || $("fta-pref-auto-update").disabled) return;
      const enabled = $("fta-pref-auto-update").checked === true;
      autoUpdateSaving = true;
      run(async () => {
        try {
          const result = await app.setAutoUpdate(enabled), info = result && typeof result === "object" ? result : app.getSnapshot()?.updateStatus;
          if (info?.errorCode === "SETTINGS_FAILED" || info?.autoUpdate !== enabled) throw new Error(info?.message || "无法保存 Zotero 自动更新设置，请重试。");
        } finally { autoUpdateSaving = false; }
      }, "自动更新设置已保存。", false, { target: "fta-pref-update-action-status" });
    });
    on($("fta-pref-username"), "input", () => { accountDirty = true; });
    on($("fta-pref-password"), "input", () => { accountDirty = true; });
    on($("fta-pref-language"), "change", () => {
      if (busy) return;
      const language = $("fta-pref-language").value;
      if (!["zh-CN", "zh-TW", "en"].includes(language)) return;
      run(() => app.saveSettings({ language }), "界面语言已保存；其他未保存的输入保持不变。");
    });
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
    on($("fta-pref-checkin-refresh"), "click", () => {
      if ($("fta-pref-checkin-refresh").disabled) return;
      checkInStartupError = "";
      run(() => app.refreshCheckIn({ force: true }), result => result?.state === "signed_out" ? "登录科研通后可查询余额与今日签到。" : "签到查询结果已更新，请查看余额、今日状态与奖励到账情况。");
    });
    on($("fta-pref-checkin-open"), "click", () => {
      if ($("fta-pref-checkin-open").disabled) return;
      run(() => app.openCheckIn(), "请在官方网页自行完成签到；返回后可刷新核实奖励到账。");
    });
    on($("fta-pref-choose-directory"), "click", () => {
      if ($("fta-pref-choose-directory").disabled) return;
      run(() => app.chooseDownloadDirectory(), result => result?.cancelled ? "已取消添加下载文件夹。" : (result?.changed === false ? "该下载文件夹已在列表中。" : "已添加下载文件夹。请将浏览器下载的 PDF 保存到列表中的任一文件夹。") + directoryPauseNote(result));
    });
    on($("fta-pref-detect-directories"), "click", () => {
      if ($("fta-pref-detect-directories").disabled) return;
      run(() => app.detectDownloadDirectories(), result => (Number.isSafeInteger(result?.added) && result.added > 0 ? "发现并添加了 " + result.added + " 个新下载目录。" : "未发现新的下载目录，现有配置保持不变。") + directoryPauseNote(result));
    });
    on($("fta-pref-logout"), "click", () => run(async () => { await app.logout(); $("fta-pref-password").value = ""; accountDirty = false; }, "已退出插件中的科研通登录。"));
    for (const id of ["fta-pref-points", "fta-pref-poll", "fta-pref-auto-download", "fta-pref-site-minimum", "fta-pref-checkin-reminder"]) on($(id), "input", () => {
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
      const acceptSiteMinimum = $("fta-pref-site-minimum").checked;
      const checkInReminder = $("fta-pref-checkin-reminder").checked;
      if (!Number.isSafeInteger(points) || points < 1 || points > 10000) return status("悬赏积分必须是 1–10000 的整数。", true, "fta-pref-save-state");
      if (!Number.isSafeInteger(pollSeconds) || pollSeconds < 60 || pollSeconds > 3600) return status("检查间隔必须是 60–3600 秒的整数。", true, "fta-pref-save-state");
      run(async () => { await app.saveSettings({ points, pollSeconds, autoDownload, acceptSiteMinimum, checkInReminder }); settingsDirty = false; status("设置已保存", false, "fta-pref-save-state"); }, "设置已保存；已发布的求助未改变。");
    });
    on($("fta-pref-add-form"), "submit", event => {
      event.preventDefault();
      const url = $("fta-pref-request-url").value.trim();
      if (!url) return status("请填写自己的科研通求助详情页链接。", true);
      const target = requestTarget || null;
      run(async () => { await app.addExistingRequest(url, target); $("fta-pref-request-url").value = ""; requestTarget = ""; }, target ? "已将已有求助关联到所选文献，未发布新求助。" : "已添加求助跟踪，未关联文献，也未发布新求助。");
    });
    on($("fta-pref-request-target"), "change", () => { requestTarget = $("fta-pref-request-target").value || ""; });
    on($("fta-pref-request-search"), "input", () => { renderRequestTargets();localize(); });
    on($("fta-pref-refresh-messages"), "click", () => run(() => app.refreshMessages(), "消息已刷新。"));
    for (const kind of ["task", "message"]) {
      on($("fta-pref-" + kind + "-search"), "input", () => {
        if (kind === "task") { taskQuery = $("fta-pref-task-search").value;taskPage = 0;selectedTasks.clear();bindingState = null; }
        else { messageQuery = $("fta-pref-message-search").value;messagePage = 0; }
        if (searchTimer !== null) window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(() => { searchTimer = null;if (!destroyed) renderActivePage(); }, 120);
      });
      on($("fta-pref-" + kind + "-page-size"), "change", () => {
        if (busy) return;
        const size = $("fta-pref-" + kind + "-page-size").value === "50" ? 50 : 25;
        if (kind === "task") { taskPageSize = size;taskPage = 0; } else { messagePageSize = size;messagePage = 0; }
        renderActivePage();
      });
      for (const [direction, step] of [["previous", -1], ["next", 1]]) on($("fta-pref-" + kind + "-" + direction), "click", () => {
        if (busy || $("fta-pref-" + kind + "-" + direction).disabled) return;
        if (kind === "task") { taskPage += step;bindingState = null; } else messagePage += step;
        renderActivePage();
      });
    }
    on($("fta-pref-message-filter"), "change", () => {
      if (busy) return;
      messageFilter = ["all", "read", "unread"].includes($("fta-pref-message-filter").value) ? $("fta-pref-message-filter").value : "all";
      messagePage = 0;renderActivePage();
    });
    for (const node of $("fta-pref-task-filters").querySelectorAll("button")) on(node, "click", () => {
      if (busy) return;
      taskFilter = node.dataset.filter;
      taskPage = 0;
      selectedTasks.clear();
      bindingState = null;
      selectPage("tasks");
    });
    on($("fta-pref-select-tasks"), "change", () => {
      if (busy || $("fta-pref-select-tasks").disabled) return;
      const checked = $("fta-pref-select-tasks").checked;
      for (const task of visibleTaskPage.filter(canAssist)) {
        if (checked) selectedTasks.add(task.id); else selectedTasks.delete(task.id);
      }
      renderTasks();
    });
    on($("fta-pref-bulk-assist"), "click", () => {
      if (busy || $("fta-pref-bulk-assist").disabled) return;
      const ids = currentTasks().filter(task => matchesFilter(task, taskFilter) && matchesTaskSearch(task) && canAssist(task) && selectedTasks.has(task.id)).map(task => task.id);
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
      for (const provider of sourceKeyIDs) $("fta-pref-key-" + provider).value = "";
      if (typeof unsubscribe === "function") unsubscribe();
      for (const unbind of bindings) unbind();
      for (const timer of copyTimers) window.clearTimeout(timer);copyTimers.clear();
      if (searchTimer !== null) window.clearTimeout(searchTimer);
      taskRows.clear();messageRows.clear();
      delete root.dataset.fulltextMounted;
    };
    cleanup = destroy;
    window.addEventListener("unload", destroy, { once: true });
    render();
    if (typeof app.preferencesOpened === "function") Promise.resolve().then(() => app.preferencesOpened()).catch(error => {
      if (destroyed) return;
      checkInStartupError = String(error?.message || "签到状态检查未完成，可点击刷新重试。");
      render();
    });
  }
  window.addEventListener("load", event => { if (event.target?.id === ROOT_ID) mount(event.target); }, true);
  window.addEventListener("showing", event => { if (event.target?.id === ROOT_ID && !event.target.dataset.fulltextMounted) mount(event.target); }, true);
  const existing = document.getElementById(ROOT_ID);
  if (existing) mount(existing);
  this.FulltextPreferences = { mount, destroy: () => { if (cleanup) cleanup(); } };
}).call(this);
