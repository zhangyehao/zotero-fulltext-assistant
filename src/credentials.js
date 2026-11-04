/* Secrets are stored by Gecko Login Manager, never in plugin preferences or JSON files. */
(function (global) {
  "use strict";
  const ORIGIN = "chrome://fulltext-assistant";
  const ACCOUNT_REALM = "AbleSci account";
  const SESSION_REALM = "AbleSci session cookies";
  const SESSION_USER = "plugin-session-v1";

  function create({ Services }) {
    if (!Services?.logins) throw new Error("当前 Zotero 的安全凭据存储不可用。");
    let writes = Promise.resolve();
    const ready = async () => { if (Services.logins.initializationPromise) await Services.logins.initializationPromise; };
    const find = realm => Services.logins.findLogins(ORIGIN, null, realm);
    function login(realm, username, password) {
      const value = Components.classes["@mozilla.org/login-manager/loginInfo;1"].createInstance(Components.interfaces.nsILoginInfo);
      value.init(ORIGIN, null, realm, username, password, "", "");
      return value;
    }
    function change(operation) {
      const result = writes.catch(() => {}).then(async () => {
        try { await ready(); return await operation(); }
        catch (_) { throw new Error("无法写入 Zotero 安全凭据存储；请确认主密码已解锁后重试。"); }
      });
      writes = result;
      return result;
    }
    async function read(realm) {
      try { await writes.catch(() => {}); await ready(); return find(realm); }
      catch (_) { throw new Error("无法读取 Zotero 安全凭据存储；请确认主密码已解锁后重试。"); }
    }
    async function put(realm, username, password) {
      return change(async () => {
        const previous = find(realm);
        const value = login(realm, username, password);
        if (previous.length) Services.logins.modifyLogin(previous[0], value);
        else await Services.logins.addLoginAsync(value);
        for (const duplicate of previous.slice(1)) Services.logins.removeLogin(duplicate);
      });
    }
    const removeRealm = realm => change(() => { for (const value of find(realm)) Services.logins.removeLogin(value); });
    return {
      async getSummary() {
        const values = await read(ACCOUNT_REALM);
        return { saved: values.length > 0, username: values[0]?.username || "" };
      },
      async save({ username, password }) {
        username = typeof username === "string" ? username.trim() : "";
        if (!username || username.length > 320 || typeof password !== "string" || !password || password.length > 4096) {
          throw new Error("请填写有效的科研通账号和密码。");
        }
        await put(ACCOUNT_REALM, username, password);
        return { saved: true, username };
      },
      async getForLogin() {
        const values = await read(ACCOUNT_REALM);
        if (!values.length) return null;
        return { username: values[0].username, password: values[0].password };
      },
      remove() { return removeRealm(ACCOUNT_REALM); },
      async readSession() {
        const values = await read(SESSION_REALM);
        if (!values.length) return null;
        try {
          const value = JSON.parse(values[0].password);
          return value?.version === 1 && Array.isArray(value.cookies) ? value : null;
        }
        catch (_) { return null; }
      },
      async writeSession(value) {
        if (!value || value.version !== 1 || !Array.isArray(value.cookies)) throw new Error("会话备份格式无效。");
        await put(SESSION_REALM, SESSION_USER, JSON.stringify(value));
      },
      clearSession() { return removeRealm(SESSION_REALM); },
    };
  }
  global.FulltextCredentials = { create };
})(globalThis);
