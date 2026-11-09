/* Updates use the installed add-on's native Zotero/Gecko update pipeline. */
(function (root) {
  "use strict";
  const PLUGIN_ID = "fulltext-assistant@local.invalid";
  const RELEASE_NOTES_URL = "https://github.com/zhangyehao/zotero-fulltext-assistant/releases/latest";

  function create({ AddonManager, ChromeUtils = root.ChromeUtils, Services, Zotero, pluginID = PLUGIN_ID,
    version = "", emit = () => {}, setTimeout: schedule = root.setTimeout,
    clearTimeout: unschedule = root.clearTimeout, now = () => Date.now(),
    checkTimeoutMs = 90000, installTimeoutMs = 180000 } = {}) {
    if (pluginID !== PLUGIN_ID) throw new TypeError("Unexpected update target");
    if (typeof schedule !== "function" || typeof unschedule !== "function") throw new TypeError("Update timers are required");
    let manager = AddonManager, addon = null, initialized = false, initializing = null, destroyed = false;
    let checkRun = null, installRun = null, candidate = null, activeInstall = null, ownedInstall = null;
    let addonListening = false, installListening = false, timingOut = null, settingsSequence = 0;
    const data = { state: "idle", currentVersion: String(version), availableVersion: "", checkedAt: null,
      autoUpdate: false, globalUpdatesEnabled: true, progress: null, errorCode: "", message: "尚未检查更新。",
      restartRequired: false, releaseNotesAvailable: true, releaseNotesURL: RELEASE_NOTES_URL };

    function snapshot() {
      if (initialized && manager && addon) { try { settings(); } catch (_) {} }
      return { ...data, progress: data.progress ? { ...data.progress } : null,
        canCheck: !destroyed && !checkRun && !installRun && !activeInstall,
        canInstall: initialized && !destroyed && !checkRun && !installRun && !activeInstall && !!candidate,
        stopped: destroyed };
    }
    function publish(patch = {}) {
      if (destroyed) return snapshot();
      Object.assign(data, patch);
      try { emit(snapshot()); } catch (_) { /* UI errors must not interrupt native installation. */ }
      return snapshot();
    }
    function complete(which) {
      const run = which === "check" ? checkRun : installRun;
      if (!run) return;
      if (run.timer !== null) unschedule(run.timer);
      if (which === "check") checkRun = null; else installRun = null;
      run.resolve(snapshot());
    }
    function operation(which, timeout, expire) {
      let resolve;
      const run = { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value), timer: null };
      if (which === "check") checkRun = run; else installRun = run;
      run.timer = schedule(() => { if (!destroyed && (which === "check" ? checkRun : installRun) === run) expire(run); }, timeout);
      return run;
    }
    function fail(code, message, which) {
      publish({ state: "error", errorCode: code, message });
      if (which) complete(which);
      return publish();
    }
    function owns(value) { return value?.existingAddon?.id === pluginID || value?.addon?.id === pluginID; }
    function isState(value, ...names) { return names.some(name => manager?.[name] !== undefined && value?.state === manager[name]); }
    function isBusy(value) {
      return isState(value, "STATE_DOWNLOADING", "STATE_CHECKING_UPDATE", "STATE_AWAITING_PROMPT", "STATE_PROMPTS_DONE", "STATE_READY", "STATE_INSTALLING", "STATE_POSTPONED");
    }
    function newer(value) {
      if (!value?.version || typeof Services?.vc?.compare !== "function") return false;
      try { return Services.vc.compare(String(value.version), data.currentVersion) > 0; } catch (_) { return false; }
    }
    function settings() {
      data.autoUpdate = addon.applyBackgroundUpdates === manager.AUTOUPDATE_ENABLE ||
        addon.applyBackgroundUpdates !== manager.AUTOUPDATE_DISABLE && manager.shouldAutoUpdate(addon);
      data.globalUpdatesEnabled = manager.updateEnabled !== false;
    }
    async function readAddon() {
      const value = await manager.getAddonByID(pluginID);
      if (destroyed) return null;
      if (!value || value.id !== pluginID) throw new Error("ADDON_NOT_FOUND");
      addon = value;data.currentVersion = String(value.version || version);settings();return value;
    }
    function progress(value) {
      const received = Number.isFinite(value?.progress) && value.progress >= 0 ? value.progress : 0;
      const total = Number.isFinite(value?.maxProgress) && value.maxProgress > 0 ? value.maxProgress : null;
      return { received, total, percent: total ? Math.min(100, Math.max(0, Math.floor(received / total * 100))) : null };
    }
    function observe(value, state) {
      if (destroyed || !owns(value)) return;
      if (activeInstall && activeInstall !== value) return;
      candidate = null;activeInstall = value;
      publish({ state, availableVersion: String(value.version || data.availableVersion), progress: progress(value), errorCode: "",
        message: state === "downloading" ? "正在通过 Zotero 下载更新。" : "正在通过 Zotero 安装更新。" });
      complete("check");
    }
    function terminal(value, code, message) {
      if (destroyed || activeInstall !== value || timingOut === value) return;
      activeInstall = null;ownedInstall = null;candidate = null;
      fail(code, message, "install");
    }
    const installListener = {
      onDownloadStarted(value) { observe(value, "downloading"); },
      onDownloadProgress(value) {
        if (!destroyed && activeInstall === value) publish({ progress: progress(value) });
      },
      onDownloadEnded(value) { observe(value, "installing"); },
      onInstallStarted(value) { observe(value, "installing"); },
      onDownloadFailed(value) { terminal(value, "DOWNLOAD_FAILED", "Zotero 未能下载或验证更新，请重新检查后重试。"); },
      onInstallFailed(value) { terminal(value, "INSTALL_FAILED", "Zotero 未能安装更新，请重新检查后重试。"); },
      onDownloadCancelled(value) { terminal(value, "DOWNLOAD_CANCELLED", "更新下载已取消，可以重新检查。"); },
      onInstallCancelled(value) { terminal(value, "INSTALL_CANCELLED", "更新安装已取消，可以重新检查。"); },
      onInstallPostponed(value) {
        if (destroyed || !owns(value) || activeInstall && activeInstall !== value) return;
        activeInstall = value;candidate = null;
        publish({ state: "installing", restartRequired: true, message: "Zotero 已暂缓应用更新，请在插件管理器中确认是否需要重启。" });
        complete("check");complete("install");publish();
      },
      onInstallEnded(value, installed) {
        if (destroyed || activeInstall !== value) return;
        activeInstall = null;ownedInstall = null;candidate = null;
        if (installed?.id !== pluginID || !installed.version || String(installed.version) !== String(value.version)) {
          fail("INSTALL_IDENTITY", "无法核实安装结果，请在 Zotero 插件管理器中检查。", "install");return;
        }
        data.currentVersion = String(installed.version || data.currentVersion);
        publish({ state: "installed", availableVersion: data.currentVersion, progress: null, restartRequired: false, errorCode: "", message: "更新已安装。" });
        complete("install");publish();
      },
    };
    const addonListener = {
      onPropertyChanged(value, properties) {
        if (destroyed || value?.id !== pluginID || !properties.includes("applyBackgroundUpdates")) return;
        addon = value;settings();publish();
      },
    };
    async function discoverActive() {
      if (typeof manager.getAllInstalls !== "function") return false;
      const installs = await manager.getAllInstalls();
      if (destroyed) return false;
      const value = installs.find(install => owns(install) && isBusy(install));
      if (!value) return false;
      if (isState(value, "STATE_POSTPONED")) installListener.onInstallPostponed(value);
      else observe(value, isState(value, "STATE_DOWNLOADING", "STATE_CHECKING_UPDATE") ? "downloading" : "installing");
      return true;
    }
    function initialize() {
      if (destroyed || initialized) return Promise.resolve(snapshot());
      if (initializing) return initializing;
      initializing = (async () => {
        try {
          manager ||= ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs").AddonManager;
          await readAddon();if (destroyed) return snapshot();
          manager.addAddonListener(addonListener);addonListening = true;
          manager.addInstallListener(installListener);installListening = true;
          initialized = true;
          if (data.errorCode === "INITIALIZE_FAILED") Object.assign(data, { state: "idle", errorCode: "", message: "尚未检查更新。" });
          await discoverActive();return publish();
        } catch (_) {
          if (addonListening) { try { manager.removeAddonListener(addonListener); } catch (_) {}addonListening = false; }
          if (installListening) { try { manager.removeInstallListener(installListener); } catch (_) {}installListening = false; }
          initialized = false;
          return fail("INITIALIZE_FAILED", "无法读取 Zotero 更新设置，请重试或打开插件管理器。");
        }
        finally { initializing = null; }
      })();
      return initializing;
    }
    function check() {
      if (destroyed) return Promise.resolve(snapshot());
      if (checkRun) return checkRun.promise;
      if (installRun) return installRun.promise;
      if (activeInstall) return Promise.resolve(snapshot());
      const run = operation("check", checkTimeoutMs, () => { candidate = null;fail("CHECK_TIMEOUT", "检查更新超时，可以重新检查。", "check"); });
      candidate = null;
      publish({ state: "checking", availableVersion: "", progress: null, restartRequired: false, errorCode: "", message: "正在检查更新…" });
      const current = () => !destroyed && checkRun === run;
      (async () => {
        await initialize();if (!current()) return;
        if (!initialized) { complete("check");return; }
        await readAddon();if (!current()) return;
        if (await discoverActive() || !current()) return;
        let found = null, invalid = false;
        addon.findUpdates({
          onUpdateAvailable(value, install) {
            if (!current()) return;
            if (value?.id !== pluginID || !owns(install)) { invalid = true;return; }
            if (newer(install)) found = install;
          },
          onUpdateFinished(value, error) {
            if (!current()) return;
            if (value?.id !== pluginID || invalid) { fail("CHECK_IDENTITY", "更新结果与当前插件不一致，请重试。", "check");return; }
            if (error) { candidate = null;fail("CHECK_FAILED", "Zotero 未能取得有效更新信息，请检查网络后重试。", "check");return; }
            candidate = found;data.checkedAt = new Date(now()).toISOString();
            publish({ state: found ? "available" : "current", availableVersion: found ? String(found.version) : "", errorCode: "",
              message: found ? "发现新版本，可以下载并安装。" : "当前已是可用的最新兼容版本。" });
            complete("check");publish();
          },
        }, manager.UPDATE_WHEN_USER_REQUESTED);
      })().catch(() => { if (current()) fail("CHECK_FAILED", "Zotero 未能检查更新，可以重试。", "check"); });
      return run.promise;
    }
    function install() {
      if (destroyed) return Promise.resolve(snapshot());
      if (installRun) return installRun.promise;
      if (checkRun || activeInstall) return Promise.resolve(snapshot());
      if (!candidate) return Promise.resolve(fail("CHECK_REQUIRED", "请先检查更新，再安装可用的新版本。"));
      const value = candidate;
      if (!owns(value) || !newer(value) || !isState(value, "STATE_AVAILABLE", "STATE_DOWNLOADED")) {
        candidate = null;return Promise.resolve(fail("UPDATE_STALE", "更新状态已改变，请重新检查。"));
      }
      const run = operation("install", installTimeoutMs, () => {
        // Native installation may be replacing this very plugin. Never cancel
        // STATE_INSTALLING or make app shutdown wait for its own replacement.
        const cancellable = ownedInstall === value && isState(value, "STATE_AVAILABLE", "STATE_DOWNLOADING", "STATE_DOWNLOADED");
        if (cancellable) { timingOut = value;try { value.cancel(); } catch (_) {}finally { timingOut = null; } }
        if (isState(value, "STATE_CANCELLED", "STATE_DOWNLOAD_FAILED", "STATE_INSTALL_FAILED")) { activeInstall = null;ownedInstall = null; }
        candidate = null;
        fail("INSTALL_TIMEOUT", activeInstall ? "原生更新处理超时，请在 Zotero 插件管理器中检查；完成前不会重复安装。" : "更新下载超时，可以重新检查后重试。", "install");
      });
      candidate = null;activeInstall = value;ownedInstall = value;
      publish({ state: "downloading", errorCode: "", progress: progress(value), message: "正在通过 Zotero 下载更新。" });
      try {
        const promise = value.install();
        if (promise?.catch) promise.catch(() => { if (!destroyed && installRun === run) terminal(value, "INSTALL_FAILED", "Zotero 未能安装更新，请重新检查后重试。"); });
      } catch (_) { terminal(value, "INSTALL_FAILED", "Zotero 未能开始更新，请重新检查后重试。"); }
      return run.promise;
    }
    async function setAutoUpdate(enabled) {
      if (typeof enabled !== "boolean") throw new TypeError("Automatic updates must be boolean");
      const sequence = ++settingsSequence;
      await initialize();if (destroyed || sequence !== settingsSequence) return snapshot();
      try {
        await readAddon();if (destroyed || sequence !== settingsSequence) return snapshot();
        addon.applyBackgroundUpdates = enabled ? manager.AUTOUPDATE_ENABLE : manager.AUTOUPDATE_DISABLE;
        settings();
        if (data.errorCode === "SETTINGS_FAILED") Object.assign(data, { state: candidate ? "available" : "idle", errorCode: "", message: "自动更新设置已保存。" });
        return publish();
      } catch (_) { return fail("SETTINGS_FAILED", "无法保存 Zotero 自动更新设置，请重试。"); }
    }
    function openReleaseNotes() {
      if (destroyed) return false;
      Zotero.launchURL(RELEASE_NOTES_URL);return true;
    }
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (addonListening) { try { manager.removeAddonListener(addonListener); } catch (_) {}addonListening = false; }
      if (installListening) { try { manager.removeInstallListener(installListener); } catch (_) {}installListening = false; }
      complete("check");complete("install");candidate = null;activeInstall = null;ownedInstall = null;
    }
    return Object.freeze({ initialize, getSnapshot: snapshot, check, install, setAutoUpdate, openReleaseNotes, destroy });
  }
  const api = Object.freeze({ create, PLUGIN_ID, RELEASE_NOTES_URL });
  root.FulltextUpdate = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
