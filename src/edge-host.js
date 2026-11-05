/* A visible Edge instance with its own persistent profile and loopback-only CDP.
 * Never opens, copies or reads the user's ordinary Edge profile or cookie stores.
 */
(function (scope) {
  "use strict";
  const PROFILE_NAME = "fulltext-assistant-edge";
  const MAX_MESSAGE = 32 * 1024 * 1024;
  const DISCONNECTED_MESSAGE = "专用 Edge 连接已断开，自动获取已停止。请重试，或在默认浏览器中手动下载 PDF 后导入。";
  const COOKIE_METHOD = /^(?:Network\.(?:getAllCookies|getCookies|setCookie|setCookies|deleteCookies|clearBrowserCookies)|Storage\.(?:getCookies|setCookies|clearCookies))$/;
  const normalize = value => String(value).replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
  function error(message, name = "EdgeConnectionError") { const value = new Error(message); value.name = name; return value; }
  function webURL(value) {
    const parsed = new URL(String(value));
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw error("Edge 只允许打开普通 HTTP(S) 论文网页。", "EdgeInputError");
    return parsed.href;
  }
  function parseActivePort(text) {
    if (typeof text !== "string" || text.length > 2048) return null;
    const lines = text.trim().split(/\r?\n/);
    if (lines.length !== 2 || !/^\d+$/.test(lines[0]) || !/^\/devtools\/browser\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lines[1])) return null;
    const port = Number(lines[0]);
    return Number.isInteger(port) && port >= 1024 && port <= 65535 ? "ws://127.0.0.1:" + port + lines[1] : null;
  }
  function nativeRuntime({Zotero, Services, IOUtils, PathUtils}) {
    const Components = scope.Components || globalThis.Components;
    const ChromeUtils = scope.ChromeUtils || globalThis.ChromeUtils;
    const {classes: Cc, interfaces: Ci} = Components;
    const timers = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
    return {
      platform: Services.appinfo.OS,
      profileBase: PathUtils.profileDir || Services.dirsvc.get("ProfD", Ci.nsIFile).path,
      now: () => Date.now(), delay: ms => Zotero.Promise.delay(ms), setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
      realPath(value) {
        const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);file.initWithPath(value);
        file.normalize();
        // ESR140 nsIFile.isSymlink() is a no-op for real Windows symlinks and
        // junctions. Check the native reparse-point flag instead of trusting it.
        const {ctypes} = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
        const library = ctypes.open("kernel32.dll");
        try {
          const attributes = library.declare("GetFileAttributesW", ctypes.winapi_abi, ctypes.uint32_t, ctypes.char16_t.ptr)(file.path);
          if (attributes === 0xffffffff || attributes & 0x400) throw error("专用 Edge 资料目录不可访问，或是符号链接/目录联接。", "EdgeProfileError");
        } finally {library.close();}
        return file.path;
      },
      async checkPolicy() {
        for (const root of [Ci.nsIWindowsRegKey.ROOT_KEY_LOCAL_MACHINE, Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER]) {
          const key = Cc["@mozilla.org/windows-registry-key;1"].createInstance(Ci.nsIWindowsRegKey);
          try {
            key.open(root, "SOFTWARE\\Policies\\Microsoft\\Edge", Ci.nsIWindowsRegKey.ACCESS_READ);
            if (key.hasValue("RemoteDebuggingAllowed") && key.readIntValue("RemoteDebuggingAllowed") === 0) throw error("组织策略禁用了 Edge 远程调试，无法启用自动导入桥接。", "EdgePolicyError");
            if (key.hasValue("DeveloperToolsAvailability") && key.readIntValue("DeveloperToolsAvailability") === 2) throw error("组织策略禁用了 Edge 开发工具，无法启用自动导入桥接。", "EdgePolicyError");
            if (key.hasValue("UserDataDir") && key.readStringValue("UserDataDir")) throw error("组织策略固定了 Edge 资料目录，无法保证独立登录环境。", "EdgePolicyError");
          } catch (cause) { if (cause.name === "EdgePolicyError") throw cause; }
          finally { try {key.close();} catch (_) {} }
        }
      },
      async findExecutable() {
        const folders = [Services.env.get("ProgramFiles(x86)"), Services.env.get("ProgramFiles"), Services.env.get("LOCALAPPDATA")].filter(Boolean);
        for (const folder of [...new Set(folders)]) {
          const file = PathUtils.join(folder, "Microsoft", "Edge", "Application", "msedge.exe");
          try { if ((await IOUtils.stat(file)).type === "regular") return file; } catch (_) {}
        }
        throw error("未找到已安装的 Microsoft Edge，请先安装 Edge。", "EdgeUnavailableError");
      },
      launch(executable, args, onExit) {
        const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);file.initWithPath(executable);
        const process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);process.init(file);
        process.runwAsync(args, args.length, {observe() {onExit();}}, false);return process;
      },
      connect(endpoint, callbacks, {timeoutMs = 5000} = {}) {
        return new Promise((resolve, reject) => {
          const channel = Cc["@mozilla.org/network/protocol;1?name=ws"].createInstance(Ci.nsIWebSocketChannel);
          let started = false, stopped = false;
          const fail = () => error("无法连接专用 Edge 的本机调试通道。");
          const timer = timers.setTimeout(() => {if (!started && !stopped) {stopped = true;try {channel.close(1000, "");} catch (_) {}reject(fail());}}, timeoutMs);
          const listener = {
            QueryInterface: ChromeUtils.generateQI(["nsIWebSocketListener"]),
            onStart() {
              if (stopped) {try {channel.close(1000, "");} catch (_) {}return;}
              started = true;timers.clearTimeout(timer);
              resolve({send(text) {channel.sendMsg(text);}, close() {if (!stopped) {stopped = true;channel.close(1000, "");}}});
            },
            onStop() {timers.clearTimeout(timer);if (stopped) return;stopped = true;if (!started) reject(fail());callbacks.onClose();},
            onMessageAvailable(context, text) {if (!stopped) callbacks.onMessage(text);},
            onBinaryMessageAvailable() {}, onAcknowledge() {},
            onServerClose(context, code) {try {channel.close(code, "");} catch (_) {}},
          };
          try {
            channel.initLoadInfo(null, Services.scriptSecurityManager.getSystemPrincipal(), null,
              Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL, Ci.nsIContentPolicy.TYPE_WEBSOCKET);
            // An empty origin is supported by Gecko's privileged channel API.
            // Do not weaken Edge with --remote-allow-origins=*.
            channel.asyncOpen(Services.io.newURI(endpoint), "", {}, 0, listener, null);
          } catch (_) {timers.clearTimeout(timer);stopped = true;reject(fail());}
        });
      },
    };
  }
  function create({Zotero, Services, IOUtils, PathUtils, runtime}) {
    if (!Zotero || !Services || !IOUtils || !PathUtils) throw error("Edge 桥接缺少运行环境。", "EdgeInputError");
    const rt = runtime || nativeRuntime({Zotero, Services, IOUtils, PathUtils});
    if (rt.platform !== "WINNT") throw error("当前 Edge 桥接仅支持 Windows。", "EdgeUnavailableError");
    const base = rt.profileBase;
    if (!/^[A-Za-z]:[\\/]/.test(base || "") || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(base)) throw error("Zotero 资料目录必须是本机绝对路径。", "EdgeProfileError");
    const profileDir = PathUtils.join(base, PROFILE_NAME);
    const portFile = PathUtils.join(profileDir, "DevToolsActivePort");
    const pending = new Map(), sessions = new Map(), events = new Set();
    let socket = null, process = null, starting = null, destroying = null, closing = false, destroyed = false, nextID = 0, generation = 0, lastError = null;
    const active = () => {if (closing || destroyed) throw error("专用 Edge 桥接已关闭。");};
    function disconnect(message = DISCONNECTED_MESSAGE) {
      const old = socket;socket = null;generation++;sessions.clear();lastError = message;
      for (const call of pending.values()) {rt.clearTimeout(call.timer);call.reject(error(message));}pending.clear();
      try {old?.close();} catch (_) {}
    }
    function incoming(text) {
      if (typeof text !== "string" || text.length > MAX_MESSAGE) {disconnect("Edge 返回的数据超过单条消息上限。");return;}
      let message;try {message = JSON.parse(text);} catch (_) {disconnect("Edge 调试通道返回了无效消息。");return;}
      if (message.id !== undefined) {
        const call = pending.get(message.id);if (!call) return;
        pending.delete(message.id);rt.clearTimeout(call.timer);
        if (message.error) {const cause = error("Edge 未能执行 " + call.method + "（" + String(Number(message.error.code) || 0) + "）。", "EdgeProtocolError");cause.code = message.error.code;cause.method = call.method;call.reject(cause);}
        else call.resolve(message.result || {});
      } else if (typeof message.method === "string") {
        if (message.method === "Target.detachedFromTarget") for (const [id, page] of sessions) if (page.sessionId === message.params?.sessionId) sessions.delete(id);
        for (const listener of events) {try {listener({method: message.method, params: message.params || {}, sessionId: message.sessionId});} catch (_) {}}
      }
    }
    function send(method, params = {}, sessionId, timeoutMs = rt.commandTimeoutMs || 20000, allowDuringClose = false) {
      if (destroyed || (closing && method !== "Browser.close" && !allowDuringClose)) return Promise.reject(error("专用 Edge 桥接已关闭。"));
      if (!socket) return Promise.reject(error(DISCONNECTED_MESSAGE));
      if (typeof method !== "string" || !/^[A-Za-z]+\.[A-Za-z]+$/.test(method) || COOKIE_METHOD.test(method)) return Promise.reject(error("此桥接不允许读取、写入或导出浏览器 Cookie。", "EdgeInputError"));
      if ((method === "Page.navigate" || method === "Target.createTarget") && params.url !== "about:blank") {
        try {webURL(params.url);} catch (cause) {return Promise.reject(cause);}
      }
      const id = ++nextID;
      return new Promise((resolve, reject) => {
        const timer = rt.setTimeout(() => {pending.delete(id);reject(error("Edge 执行 " + method + " 超时。", "EdgeTimeoutError"));}, timeoutMs);
        pending.set(id, {resolve, reject, timer, method});
        try {socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));}
        catch (_) {disconnect();}
      });
    }
    async function readEndpoint() {
      try {
        const stat = await IOUtils.stat(portFile);
        if (stat.type !== "regular" || stat.size > 2048) return null;
        return parseActivePort(await IOUtils.readUTF8(portFile));
      } catch (_) {return null;}
    }
    async function connect(endpoint, timeoutMs) {
      const token = ++generation;
      const connected = await rt.connect(endpoint, {onMessage: text => {if (generation === token) incoming(text);}, onClose: () => {if (generation === token) disconnect();}}, {timeoutMs});
      if (generation !== token) {connected.close();throw error("Edge 在建立通道时已退出。");}
      socket = connected;
      try {await send("Browser.getVersion", {}, undefined, 5000, true);lastError = null;}
      catch (cause) {disconnect();throw cause;}
    }
    async function ensureProfile() {
      await rt.checkPolicy?.();
      // Gecko ESR140 IOUtils has no realPath method. Native operation uses
      // nsIFile.normalize + Windows reparse checks; IOUtils is only a test seam.
      const canonical = value => rt.realPath ? rt.realPath(value) : IOUtils.realPath(value);
      const actualBase = await canonical(base);
      await IOUtils.makeDirectory(profileDir, {ignoreExisting: true, permissions: 0o700});
      const stat = await IOUtils.stat(profileDir);
      const actual = await canonical(profileDir);
      if (stat.type !== "directory" || normalize(actual) !== normalize(PathUtils.join(actualBase, PROFILE_NAME))) throw error("专用 Edge 资料目录不能是符号链接或指向外部目录。", "EdgeProfileError");
    }
    function ensureStarted() {
      active();if (socket) return Promise.resolve();if (starting) return starting;
      starting = (async () => {
        await ensureProfile();
        if (closing) throw error("专用 Edge 桥接已关闭。");
        const previous = await readEndpoint();
        if (previous) {try {await connect(previous, 1500);return;} catch (_) {}}
        const executable = await rt.findExecutable();
        if (closing) throw error("专用 Edge 桥接已关闭。");
        if (await IOUtils.exists(portFile)) await IOUtils.remove(portFile, {ignoreAbsent: true});
        if (closing) throw error("专用 Edge 桥接已关闭。");
        process = rt.launch(executable, ["--remote-debugging-port=0", "--user-data-dir=" + profileDir, "--no-first-run", "--new-window", "about:blank"], () => {process = null;});
        const until = rt.now() + (rt.startupTimeoutMs || 20000);
        while (rt.now() < until) {
          const endpoint = await readEndpoint();
          if (endpoint) {try {await connect(endpoint, 2000);return;} catch (_) {}}
          await rt.delay(100);
        }
        throw error("专用 Edge 未能建立本机连接。请确认 Edge 可运行，且组织策略允许远程调试。", "EdgeStartupError");
      })().catch(cause => {lastError = cause.message;throw cause;}).finally(() => {starting = null;});
      return starting;
    }
    async function pages() {active();const result = await send("Target.getTargets");return (result.targetInfos || []).filter(target => target.type === "page");}
    async function attach(targetId) {
      active();if (!socket) throw error(DISCONNECTED_MESSAGE);
      if (sessions.has(targetId)) return sessions.get(targetId);
      if (typeof targetId !== "string" || !(await pages()).some(target => target.targetId === targetId)) throw error("目标页面不属于此专用 Edge 实例。", "EdgeInputError");
      const result = await send("Target.attachToTarget", {targetId, flatten: true});
      const page = {id: targetId, sessionId: result.sessionId};sessions.set(targetId, page);return page;
    }
    return {
      profileDir,
      async open(url) {const checked = webURL(url);await ensureStarted();active();const target = await send("Target.createTarget", {url: checked});return attach(target.targetId);},
      send, pages, attach,
      async focus(page) {active();if (!socket) throw error(DISCONNECTED_MESSAGE);if (!sessions.has(page?.id) || sessions.get(page.id).sessionId !== page.sessionId) throw error("Edge 页面已关闭。", "EdgeInputError");return send("Page.bringToFront", {}, page.sessionId);},
      async closePage(page) {if (!socket || !sessions.has(page?.id)) return;const result = await send("Target.closeTarget", {targetId: page.id});sessions.delete(page.id);return result;},
      onEvent(listener) {if (typeof listener !== "function") throw error("事件监听器无效。", "EdgeInputError");events.add(listener);return () => events.delete(listener);},
      getStatus() {return {running: !!socket || !!process, connected: !!socket, starting: !!starting, persistentProfile: true, error: lastError};},
      destroy() {
        if (destroying) return destroying;closing = true;
        destroying = (async () => {
          if (starting) await starting.catch(() => {});
          let requested = false;
          if (socket) {try {await send("Browser.close", {}, undefined, 3000);requested = true;} catch (_) {}}
          disconnect("专用 Edge 桥接已关闭。");events.clear();destroyed = true;return {closeRequested: requested};
        })();return destroying;
      },
    };
  }
  scope.FulltextEdgeHost = Object.freeze({create, webURL, parseActivePort, PROFILE_NAME});
})(globalThis);
