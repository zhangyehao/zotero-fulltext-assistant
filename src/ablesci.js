/*
 * AbleSci adapter. Default DOM/API contracts were verified from public pages and
 * authenticated, locally redacted captures on 2026-11-04. Page scripts are parsed,
 * never executed; publication is journaled and download always selects normal.
 *
 * Evidence read 2026-11-04:
 * https://www.ablesci.com/assist/detail (public request detail contract)
 * https://www.ablesci.com/my/assist-my (anonymous request redirects to /site/login)
 * https://www.ablesci.com/assist/create (anonymous request redirects to /site/login)
 * https://staticlocone.ablesci.com/assets/css/global_local.css?v=20241008v1
 * https://staticlocone.ablesci.com/assets/csrf/20260914v1/csrf.js
 * https://staticlocone.ablesci.com/assets/activity/20260915v1/activity.js
 * The last script treats /my/get-message as an unread-state mutation. Message
 * summaries therefore come only from the server-rendered GET /my/message list.
 */
(function (root) {
  "use strict";
  const ORIGIN = "https://www.ablesci.com";
  const PATHS = Object.freeze({ account: "/my/assist-my", ownRequests: "/my/assist-my", create: "/assist/create", login: "/site/login", messages: "/my/message", downloadSettings: "/my/assist-my-set" });
  const REMOTE_STATES = ["waiting", "uploaded", "finished", "closed"];
  const FILE_STATES = ["waiting", "accept", "reject", "withdraw"];
  const NORMAL_DOWNLOAD_ORIGINS = Object.freeze(["https://filehub2.ablesci.com", "https://filehub3.ablesci.com", "https://filehub4.ablesci.com"]);

  class AbleSciError extends Error {
    constructor(code, message, options = {}) {
      super(message);
      this.name = "AbleSciError";
      this.code = code;
      this.retryable = options.retryable === true;
      this.reconcileRequired = options.reconcileRequired === true;
      if (Number.isInteger(options.httpStatus)) this.httpStatus = options.httpStatus;
    }
  }

  function fail(code, message, options) { throw new AbleSciError(code, message, options); }
  function shortText(value, limit = 2000) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit); }
  function siteURL(value, base = ORIGIN) {
    let url;
    try { url = new URL(value, base); } catch (_) { fail("INVALID_URL", "科研通地址无效。"); }
    if (url.origin !== ORIGIN || url.username || url.password) fail("INVALID_URL", "请求只允许访问已验证的科研通站点。");
    return url.href;
  }
  function requestIdentity(value) {
    if (typeof value !== "string") fail("INVALID_REQUEST", "缺少求助编号。");
    const isID = /^[A-Za-z0-9]{1,128}$/.test(value);
    const id = isID ? value : new URL(siteURL(value)).searchParams.get("id");
    if (!id || !/^[A-Za-z0-9]{1,128}$/.test(id)) fail("INVALID_REQUEST", "求助编号格式无效。");
    if (!isID) {
      const url = new URL(siteURL(value));
      if (url.pathname !== "/assist/detail" || url.search !== "?id=" + id || url.hash) fail("INVALID_REQUEST", "必须提供完整、单一的求助详情地址。");
    }
    return { requestID: id, requestURL: ORIGIN + "/assist/detail?id=" + id };
  }
  function ownID(href, expectedPath) {
    try {
      const url = new URL(siteURL(href));
      const id = url.searchParams.get("id");
      return url.pathname === expectedPath && /^[A-Za-z0-9]+$/.test(id || "") ? id : null;
    } catch (_) { return null; }
  }
  function getClassState(element, prefix, allowed) {
    if (!element) return null;
    const found = allowed.filter(state => element.classList.contains(prefix + state));
    return found.length === 1 ? found[0] : null;
  }

  function accountScope(doc) {
    const scopes = new Set();
    for (const script of doc.querySelectorAll("script:not([src])")) {
      const expression = /window\.AbleActivity\.start\(\s*\{\s*scope\s*:\s*["']([A-Za-z0-9]+)["']/g;
      for (const match of script.textContent.matchAll(expression)) scopes.add(match[1]);
    }
    if (scopes.size > 1) fail("ACCOUNT_UNVERIFIED", "页面包含不一致的登录账号标识。");
    return scopes.size ? [...scopes][0] : null;
  }

  function parseAccount(doc, pageURL) {
    const url = new URL(siteURL(pageURL));
    if (url.pathname === PATHS.login || doc.querySelector(".able-head-user-guest")) {
      return { authenticated: false, accountID: null, username: "", displayName: "", points: null, message: "请在插件内登录科研通。", loginURL: ORIGIN + PATHS.login };
    }
    if (url.pathname !== PATHS.account) fail("ACCOUNT_UNVERIFIED", "尚未读取受保护的“我的求助”页面。");
    const nav = doc.querySelector(".able-head-user");
    const links = nav ? Array.from(nav.querySelectorAll("a[href]")) : [];
    const profile = links.find(link => ownID(link.getAttribute("href"), "/user/home"));
    const logout = links.find(link => {
      try {
        const path = new URL(siteURL(link.getAttribute("href"))).pathname;
        return /\/(?:logout|signout)$/.test(path);
      } catch (_) { return false; }
    });
    const scopeID = accountScope(doc);
    const profileID = profile && ownID(profile.getAttribute("href"), "/user/home");
    if (profileID && scopeID && profileID !== scopeID) fail("ACCOUNT_UNVERIFIED", "账号导航与登录活动标识不一致。");
    const accountID = scopeID || profileID;
    if (!accountID || !logout) fail("ACCOUNT_UNVERIFIED", "账号导航结构尚未核实，不能确认当前求助账号。");
    const username = shortText(nav.querySelector(".top-right-menu-wrapper > span")?.textContent || profile?.textContent, 120);
    const pointsText = shortText(doc.querySelector("#user-point-now, #point-has")?.textContent);
    const points = /^\d+$/.test(pointsText) ? Number(pointsText) : null;
    return { authenticated: true, accountID, username, displayName: username, points, message: "已核实当前账号。", evidence: "protected-own-requests-page-and-account-navigation" };
  }

  function parseRequest(doc, pageURL, model) {
    const identity = requestIdentity(pageURL);
    const page = doc.querySelector(".assist-detail-page");
    if (!page) fail("STRUCTURE_CHANGED", "未找到科研通求助详情结构，尚不能判定状态。");
    const hiddenID = page.querySelector(".assist-id-val");
    if (!hiddenID || hiddenID.getAttribute("value") !== identity.requestID) fail("REQUEST_MISMATCH", "求助页面编号与目标任务不一致。");
    const badge = page.querySelector(".assist-badge");
    const remoteState = getClassState(badge, "assist-badge-", REMOTE_STATES);
    if (!remoteState) fail("STRUCTURE_CHANGED", "求助状态标记发生变化，已停止自动判断。");
    const detail = page.querySelector(".assist-detail");
    const titleNode = detail && detail.querySelector(".assist-title [data-clipboard-text]");
    const titleCell = detail && detail.querySelector(".assist-title");
    const doiNode = detail && detail.querySelector(".assist-doi [data-clipboard-text]");
    let doi = "";
    if (doiNode) {
      try { doi = model.normalizeDOI(doiNode.getAttribute("data-clipboard-text")); }
      catch (_) { fail("DOI_MISMATCH", "详情页 DOI 字段无法校验。"); }
    }
    let ownerID = null, points = null, downloadText = "";
    for (const row of detail ? detail.querySelectorAll("table.stable tr") : []) {
      const cells = row.querySelectorAll("td");
      if (cells.length !== 2) continue;
      const label = shortText(cells[0].textContent);
      if (label === "求助人") {
        const owner = Array.from(cells[1].querySelectorAll("a[href]")).find(a => ownID(a.getAttribute("href"), "/user/home"));
        ownerID = owner ? ownID(owner.getAttribute("href"), "/user/home") : null;
        const match = shortText(cells[1].textContent).match(/悬赏\s*(\d+)\s*积分/);
        points = match ? Number(match[1]) : null;
      }
      if (label === "下载") downloadText = shortText(cells[1].textContent);
    }
    const files = [];
    for (const entry of page.querySelectorAll("#assist-timeline .layui-timeline-item")) {
      const info = entry.querySelector(".file-info");
      if (!info) continue;
      const idNode = entry.querySelector(".assist-file-id");
      const fileID = idNode && idNode.getAttribute("value");
      const anchor = info.querySelector("a.name");
      if (!fileID || !/^[A-Za-z0-9]+$/.test(fileID) || !anchor) fail("STRUCTURE_CHANGED", "应助文件的标识或入口发生变化。");
      const status = getClassState(info.querySelector(".assistfile-badge"), "assistfile-badge-", FILE_STATES);
      if (!status) fail("STRUCTURE_CHANGED", "应助文件状态无法核实。");
      const forbidden = anchor.classList.contains("assist-download-forbidden");
      let downloadURL = null;
      if (!forbidden && !["reject", "withdraw"].includes(status)) {
        try { downloadURL = siteURL(anchor.getAttribute("href"), identity.requestURL); } catch (_) {}
      }
      const filename = shortText(anchor.textContent, 255);
      files.push({ id: fileID, name: filename, fileID, filename, sizeText: shortText(info.querySelector(".size")?.textContent, 80), status, downloadURL, permissionRequired: forbidden });
    }
    const expired = /文件已从服务器自动删除|文件已删除|文件已过期|超过.*下载期限/.test(downloadText);
    let state = "waiting";
    if (files.some(file => ["waiting", "accept"].includes(file.status))) state = "available";
    if (expired || remoteState === "closed" || (remoteState === "finished" && state !== "available")) state = "closed";
    const official = detail && detail.querySelector(".assist-url a[href]");
    let officialURL = "";
    try {
      const url = new URL(official?.getAttribute("href"));
      if (/^https?:$/.test(url.protocol) && !url.username && !url.password) officialURL = url.href;
    } catch (_) {}
    return { ...identity, title: shortText(titleNode?.getAttribute("data-clipboard-text") || titleCell?.firstElementChild?.textContent), doi, officialURL, ownerID, points, remoteState, state, files, expired, downloadText, permissionRequired: files.some(file => file.permissionRequired), evidence: "scoped-request-badge-and-file-records" };
  }

  function csrf(doc) {
    const name = doc.querySelector('meta[name="csrf-param"]')?.getAttribute("content");
    const token = doc.querySelector('meta[name="csrf-token"]')?.getAttribute("content");
    if (!name || !token || !/^[A-Za-z0-9_-]+$/.test(name)) fail("CSRF_UNAVAILABLE", "页面未提供有效的提交校验信息，请重新登录后再试。");
    return { name, token };
  }

  function parseOwnRequests(doc, pageURL, account) {
    const url = new URL(siteURL(pageURL));
    if (url.pathname !== PATHS.ownRequests || accountScope(doc) !== account.accountID) fail("ACCOUNT_MISMATCH", "我的求助页面与当前登录账号不一致。");
    const list = doc.querySelector(".assist-list");
    const tab = doc.querySelector("#LAY_mine .layui-this");
    if (!list || !tab || shortText(tab.textContent) !== "我的求助") fail("STRUCTURE_CHANGED", "未找到本人求助列表，无法确认是否已经发布。");
    const items = [];
    for (const row of list.querySelectorAll("table.layui-table tbody tr")) {
      const links = Array.from(row.querySelectorAll(".list-subject a[href]"));
      const anchor = links.find(link => ownID(link.getAttribute("href"), "/assist/detail"));
      if (!anchor) fail("STRUCTURE_CHANGED", "求助列表行缺少已核实的详情入口。");
      const requestID = ownID(anchor.getAttribute("href"), "/assist/detail");
      if (!items.some(item => item.requestID === requestID)) items.push({ requestID, title: shortText(anchor.textContent, 2000) });
    }
    if (!items.length && !list.querySelector("table.layui-table, .fly-none")) fail("STRUCTURE_CHANGED", "无法确认求助列表是否为空。");
    const pagination = doc.querySelector(".pages .pagination");
    let nextURL = null;
    if (pagination) {
      const next = pagination.querySelector("li.next");
      if (!next) fail("INCOMPLETE_SEARCH", "分页缺少下一页状态，不能安全确认列表完整。");
      if (!next.classList.contains("disabled")) {
        const anchor = next.querySelector("a[href]");
        if (!anchor) fail("INCOMPLETE_SEARCH", "下一页入口无法核实。");
        const target = new URL(siteURL(anchor.getAttribute("href"), pageURL));
        if (target.pathname !== PATHS.ownRequests || Number(target.searchParams.get("page")) !== Number(url.searchParams.get("page") || 1) + 1) fail("INCOMPLETE_SEARCH", "分页页码不连续，不能安全确认列表完整。");
        nextURL = target.href;
      }
    }
    return { items, nextURL, complete: true };
  }

  function parseJSON(response) {
    let result;
    try { result = JSON.parse(response.text); } catch (_) { fail("INVALID_RESPONSE", "科研通返回了非预期的数据，可能需要在登录窗口完成验证。"); }
    if (!result || typeof result !== "object" || Array.isArray(result)) fail("INVALID_RESPONSE", "科研通返回的数据结构无法核实。");
    if (typeof result.code === "string" && /^(?:0|1|2)$/.test(result.code)) result.code = Number(result.code);
    return result;
  }
  function integer(value, label, allowZero = false) {
    if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < (allowZero ? 0 : 1)) fail("STRUCTURE_CHANGED", label + "无法核实。");
    return Number(value);
  }
  function plainMessage(value, parseHTML) { return shortText(parseHTML("<div>" + String(value || "") + "</div>").body.textContent, 700); }
  function scriptText(doc) { return Array.from(doc.querySelectorAll("script:not([src])")).map(node => node.textContent).join("\n"); }

  function parseMessages(doc, account) {
    if (accountScope(doc) !== account.accountID) fail("ACCOUNT_MISMATCH", "消息列表与当前登录账号不一致。");
    const page = doc.querySelector(".user-message-page");
    if (!page || !page.querySelector("table.layui-table, .fly-none")) fail("STRUCTURE_CHANGED", "消息列表结构发生变化。");
    const messages = [];
    for (const row of page.querySelectorAll("tr.message-item")) {
      const id = row.getAttribute("id"), input = row.querySelector('input[name="messageID"]'), subject = row.querySelector(".message-link");
      if (!/^[A-Za-z0-9]+$/.test(id || "") || input?.getAttribute("value") !== id || !subject) fail("STRUCTURE_CHANGED", "消息标识或标题无法核实。");
      const titleNode = subject.cloneNode(true);
      for (const badge of titleNode.querySelectorAll(".message-badge-noread")) badge.remove();
      const read = row.classList.contains("message-readed"), unread = row.classList.contains("message-noread");
      if (read === unread) fail("STRUCTURE_CHANGED", "消息已读状态无法核实。");
      messages.push({ id, title: shortText(titleNode.textContent, 240), text: "", createdAt: shortText(row.querySelector(".message-time")?.textContent, 80), url: ORIGIN + PATHS.messages + "#" + id, read, requestID: null });
    }
    return messages;
  }

  function parseDownloadPage(doc, pageURL, file, account) {
    const url = new URL(siteURL(pageURL));
    if (url.pathname !== "/assist/download" || url.searchParams.get("id") !== file.fileID || accountScope(doc) !== account.accountID) fail("DOWNLOAD_MISMATCH", "文件下载页与当前文件或账号不一致。");
    const page = doc.querySelector('.download-progress-page[data-download-blob-check="chunked-v1"]');
    if (!page || shortText(page.querySelector(".download-progress-file-name")?.textContent, 255) !== file.filename) fail("DOWNLOAD_MISMATCH", "下载页面文件名与应助文件不一致。");
    if (!/普通下载线路始终保持免积分|普通下载不扣积分/.test(page.textContent)) fail("UNVERIFIED_CONTRACT", "当前页面没有确认普通线路免费，未请求下载令牌。");
    let config;
    try { config = JSON.parse(scriptText(doc).match(/\bconst\s+config\s*=\s*(\{[^\r\n]*\})\s*;/)?.[1]); }
    catch (_) { fail("STRUCTURE_CHANGED", "下载页面的普通线路配置无法核实。"); }
    if (config.hashid !== file.fileID || siteURL(config.tokenUrl) !== ORIGIN + "/file/request-download-token" || !Array.isArray(config.normalServers) || !Array.isArray(config.allowedNodeHosts)) fail("STRUCTURE_CHANGED", "普通下载令牌或文件配置发生变化。");
    const normalServers = config.normalServers.filter(server => /^\d+$/.test(String(server.id)) && Array.from(page.querySelectorAll(".download-progress-normal-button[data-server-id]")).some(button => button.getAttribute("data-server-id") === String(server.id)));
    const server = normalServers.find(value => String(value.id) === String(config.defaultServerId)) || normalServers[0];
    if (!server) fail("DOWNLOAD_NOT_AVAILABLE", "页面没有提供可核实的普通下载线路。");
    const allowedOrigins = NORMAL_DOWNLOAD_ORIGINS.filter(origin => config.allowedNodeHosts.includes(new URL(origin).hostname));
    if (!allowedOrigins.length) fail("STRUCTURE_CHANGED", "页面没有列出已核实的普通下载服务器。");
    return { tokenURL: siteURL(config.tokenUrl), fileID: file.fileID, serverID: String(server.id), expectedSize: integer(config.expectedSize, "文件字节数"), allowedOrigins };
  }

  function defaultContracts(model) {
    return {
      ownRequests: parseOwnRequests,
      messages: {
        prepare: () => ({ url: ORIGIN + PATHS.messages, method: "GET", marksRead: false, responseType: "text" }),
        parse(response, parseHTML, { account }) {
          if (new URL(response.url).pathname === PATHS.login) fail("LOGIN_REQUIRED", "读取消息时登录已失效。");
          if (new URL(response.url).pathname !== PATHS.messages) fail("STRUCTURE_CHANGED", "消息页面跳转到了未核实位置。");
          return { messages: parseMessages(parseHTML(response.text), account) };
        },
      },
      downloadOrigins: NORMAL_DOWNLOAD_ORIGINS,
      async download({ file, account, page, query }) {
        const target = new URL(siteURL(file.downloadURL));
        if (target.pathname !== "/assist/download" || target.search !== "?id=" + file.fileID || target.hash) fail("DOWNLOAD_MISMATCH", "应助文件入口不是已核实的下载页面。");
        // This GET renders configuration only. No page scripts run here, so smart
        // high-speed preferences cannot silently choose a paid token request.
        const document = await page(target.href);
        const config = parseDownloadPage(document.doc, document.response.url, file, account);
        const result = await query(document.doc, config.tokenURL, { type: "assistFile", id: file.fileID, channel: "normal", highspeed: "0", fallback: "0", file_server: config.serverID, remove_sensitive: "1" });
        const data = result.data;
        if (Number(result.code) !== 0 || !data) fail("DOWNLOAD_NOT_AVAILABLE", "普通下载令牌获取失败，请稍后重试。", { retryable: true });
        if (data.channel !== "normal" || data.transport !== "normal" || typeof data.token !== "string" || !data.token || typeof data.output_filename !== "string" || !data.output_filename) fail("INVALID_DOWNLOAD_RESPONSE", "下载令牌未确认普通免费线路或缺少文件信息。");
        let url;
        try { url = new URL(data.host, ORIGIN); } catch (_) { fail("INVALID_DOWNLOAD_URL", "下载服务器地址无效。"); }
        if (url.protocol !== "https:" || url.username || url.password || !config.allowedOrigins.includes(url.origin)) fail("INVALID_DOWNLOAD_URL", "下载令牌指向未核实的普通下载服务器。");
        url.searchParams.set("token", data.token);
        return { url: url.href, costPoints: 0, expectedSize: Number(data.expected_size) > 0 ? integer(data.expected_size, "下载文件字节数") : config.expectedSize, allowedOrigins: config.allowedOrigins, filename: shortText(data.output_filename, 255) };
      },
      submission: {
        async prepare({ doc, url, doi, points, account, query, delay, checkCancelled }) {
          if (accountScope(doc) !== account.accountID) fail("ACCOUNT_MISMATCH", "创建页面的登录账号发生变化。");
          const form = doc.querySelector("#assist-create-form"), code = scriptText(doc);
          if (!form || String(form.getAttribute("method")).toLowerCase() !== "post" || new URL(siteURL(form.getAttribute("action"), url)).pathname !== PATHS.create || doc.querySelector("#action-url")?.getAttribute("value") !== PATHS.create) fail("STRUCTURE_CHANGED", "创建求助的真实表单发生变化。");
          for (const name of ["onekey", "Assist[doi]", "Assist[title]", "Assist[url]", "Assist[type]", "Assist[point]", "Assist[note]", "Assist[remark]", "Assist[suppl]", "Assist[close_at]"]) {
            if (!Array.from(form.querySelectorAll("[name]")).some(node => node.getAttribute("name") === name)) fail("STRUCTURE_CHANGED", "创建表单缺少字段：" + name);
          }
          for (const endpoint of ["onekey-query", "paper-lookup-status", "/assist/query-lowest-point", "/assist/check-before-assist-create"]) {
            if (!code.includes(endpoint)) fail("STRUCTURE_CHANGED", "页面的文献查询或发布检查步骤发生变化。");
          }
          const balance = integer(doc.querySelector("#point-has")?.textContent.trim(), "当前可用积分", true);
          if (points > balance) fail("INSUFFICIENT_POINTS", "悬赏积分超过当前账号可用积分，未发起求助。");
          let lookup = await query("/assist/onekey-query", { onekey: doi });
          if (lookup.code === 0 && lookup.job_uuid && lookup.status === "queued") {
            const jobID = lookup.job_uuid;
            if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobID)) fail("INVALID_RESPONSE", "文献查询任务标识无法核实。");
            for (let attempt = 0; attempt < 30; attempt++) {
              await delay(1500); checkCancelled();
              lookup = await query("/assist/paper-lookup-status", { job_uuid: jobID });
              if (!["queued", "running"].includes(lookup.status)) break;
            }
          }
          if (["queued", "running"].includes(lookup.status)) fail("LOOKUP_PENDING", "文献信息仍在查询，未发布求助，请稍后重试。", { retryable: true });
          if (lookup.code !== 0 || !lookup.data) fail("LOOKUP_FAILED", "科研通未能核实该 DOI 的文献信息，未发布求助。");
          const metadata = lookup.data;
          if (model.normalizeDOI(metadata.doi) !== doi) fail("DOI_MISMATCH", "科研通查询结果的 DOI 与 Zotero 条目不一致，未发布求助。");
          const title = shortText(metadata.title, 2000);
          if (!title) fail("LOOKUP_FAILED", "文献查询没有返回标题，未发布求助。");
          const type = String(metadata.type);
          const typeNode = Array.from(form.querySelectorAll('input[name="Assist[type]"]')).find(node => node.getAttribute("value") === type);
          if (!typeNode) fail("STRUCTURE_CHANGED", "文献类型不在当前页面支持的选项内。");
          let officialURL = "";
          if (metadata.url) {
            const target = new URL(metadata.url);
            if (!/^https?:$/.test(target.protocol) || target.username || target.password) fail("INVALID_RESPONSE", "文献官网链接无法核实。");
            officialURL = target.href;
          }
          const lowest = await query("/assist/query-lowest-point", { doi, url: officialURL });
          if (lowest.code !== 0) fail("STRUCTURE_CHANGED", "网站未能确认本篇文献最低悬赏积分。");
          const minimumPoints = Math.max(integer(doc.querySelector("#point-low")?.textContent.trim(), "表单最低积分"), integer(metadata.min_point, "文献最低积分"), integer(typeNode.getAttribute("data-point"), "文献类型最低积分"), integer(lowest.point, "出版社最低积分"), metadata.publisher?.point == null ? 1 : integer(metadata.publisher.point, "出版社规则积分"));
          if (points < minimumPoints) fail("POINTS_TOO_LOW", "网站最低要求为 " + minimumPoints + " 积分，超过当前配置；未发布、未自动加价。");
          const check = await query("/assist/check-before-assist-create", { title, doi, url: officialURL, point: points });
          if (check.code === 2) fail("REQUEST_REVIEW_REQUIRED", "网站要求核对文献信息或重复求助提示，请在科研通页面确认后继续；插件没有自动确认或加价。");
          if (check.code !== 0) fail("REQUEST_REJECTED", "网站未通过发布前检查，未发布求助。");
          const closeNode = form.querySelector('[name="Assist[close_at]"]');
          const closeAt = closeNode.getAttribute("value") || code.match(/\$\(['"]#Assist-close_at['"]\)\.val\(['"](\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})['"]\)/)?.[1];
          if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(closeAt || "")) fail("STRUCTURE_CHANGED", "网站默认自动关闭时间无法核实。");
          const note = "期刊：" + shortText(metadata.journal, 200) + "\r\n作者：" + shortText(metadata.authors, 600) + "\r\n出版日期：" + shortText(metadata.publish_at, 100);
          return { url: siteURL(form.getAttribute("action"), url), method: "POST", minimumPoints, fields: { doi: "Assist[doi]", points: "Assist[point]" }, body: { onekey: doi, "Assist[doi]": doi, "Assist[title]": title, "Assist[url]": officialURL, "Assist[type]": type, "Assist[point]": points, "Assist[note]": note.slice(0, 1000), "Assist[remark]": "", "Assist[suppl]": "0", "Assist[close_at]": closeAt } };
        },
        parse(response, parseHTML) {
          const result = parseJSON(response);
          if (result.code === 0 && result.data?.url) return { kind: "confirmed", ...requestIdentity(siteURL(result.data.url, response.url)) };
          if (result.code === 1) return { kind: "rejected", message: plainMessage(result.msg, parseHTML) || "网站拒绝此次求助。" };
          return { kind: "unknown" };
        },
      },
    };
  }

  function create({ request, parseHTML, model = root.FulltextTaskModel, contracts = {}, intentStore = null, delay = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now(), lookupCacheMs = 20000 }) {
    if (typeof request !== "function" || typeof parseHTML !== "function" || !model) throw new TypeError("request, parseHTML and task model are required");
    contracts = { ...defaultContracts(model), ...contracts };
    const inFlight = new Map();
    const lookupCache = new Map(), lookupPending = new Map();
    const cacheTTL = Math.max(0, Math.min(60000, Number(lookupCacheMs) || 0));
    let cacheEpoch = 0, knownAccountID = null, accountPending = null, accountPage = null, firstListFingerprint = null;
    function invalidateLookups() { cacheEpoch++; lookupCache.clear(); lookupPending.clear(); firstListFingerprint = null; accountPage = null; }
    async function cachedLookup(key, loader) {
      const entry = lookupCache.get(key);
      if (entry && now() - entry.at < cacheTTL) return entry.value;
      if (lookupPending.has(key)) return lookupPending.get(key);
      const epoch = cacheEpoch;
      const pending = (async () => {
        const value = await loader();
        if (epoch === cacheEpoch && cacheTTL) {
          if (lookupCache.size >= 1200) lookupCache.delete(lookupCache.keys().next().value);
          lookupCache.set(key, { value, at: now() });
        }
        return value;
      })();
      lookupPending.set(key, pending);
      try { return await pending; } finally { if (lookupPending.get(key) === pending) lookupPending.delete(key); }
    }

    async function send(spec, write = false) {
      const url = siteURL(spec.url);
      let response;
      try { response = await request({ ...spec, url }); }
      catch (_) {
        fail(write ? "SUBMISSION_UNKNOWN" : "NETWORK", write ? "提交响应未收到；结果待核实，不能自动重复发布。" : "科研通请求未完成，请稍后重试。", { retryable: !write, reconcileRequired: write });
      }
      if (!response || !Number.isInteger(response.status)) fail(write ? "SUBMISSION_UNKNOWN" : "INVALID_RESPONSE", "服务器响应不完整。", { retryable: !write, reconcileRequired: write });
      let finalURL;
      try { finalURL = siteURL(response.url || url); }
      catch (error) {
        if (write) fail("SUBMISSION_UNKNOWN", "提交响应跳转到了未核实地址；不能自动重新发布。", { reconcileRequired: true });
        throw error;
      }
      if (new URL(finalURL).pathname === PATHS.login && new URL(url).pathname !== PATHS.login) {
        if (write) fail("SUBMISSION_UNKNOWN", "提交期间登录状态发生变化，请先核实是否已经发布。", { reconcileRequired: true });
        return { ...response, url: finalURL };
      }
      if (response.status === 429) fail(write ? "SUBMISSION_UNKNOWN" : "RATE_LIMITED", "科研通要求降低请求频率。", { retryable: !write, reconcileRequired: write, httpStatus: response.status });
      if (response.status < 200 || response.status >= 300) fail(write ? "SUBMISSION_UNKNOWN" : "HTTP_ERROR", "科研通返回 HTTP " + response.status + "。", { retryable: !write && response.status >= 500, reconcileRequired: write, httpStatus: response.status });
      return { ...response, url: finalURL };
    }

    async function page(url) {
      const response = await send({ url, method: "GET", responseType: "text" });
      if (typeof response.text !== "string" || response.text.length > 8 * 1024 * 1024) fail("INVALID_RESPONSE", "网页内容不是可解析的文本。");
      return { response, doc: parseHTML(response.text) };
    }
    async function postFormJSON(doc, url, fields) {
      const token = csrf(doc), body = new URLSearchParams();
      for (const [name, value] of Object.entries(fields)) body.set(name, String(value));
      body.set(token.name, token.token);
      const response = await send({ url, method: "POST", body: body.toString(), headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-CSRF-Token": token.token, "X-Requested-With": "XMLHttpRequest", "Accept": "application/json" }, responseType: "text" });
      if (new URL(response.url).pathname === PATHS.login) fail("LOGIN_REQUIRED", "请求期间登录已失效。");
      return parseJSON(response);
    }
    function requireContract(name, check) {
      const contract = contracts[name];
      if (!contract || (check && !check(contract))) fail("UNVERIFIED_CONTRACT", "尚未核实登录后的科研通“" + name + "”接口；没有发送猜测的请求。");
      return contract;
    }
    async function getAccount() {
      if (accountPending) return accountPending;
      const pending = (async () => {
        const result = await page(PATHS.account);
        const parser = typeof contracts.account === "function" ? contracts.account : parseAccount;
        const account = parser(result.doc, result.response.url);
        const accountID = account.authenticated ? account.accountID : null;
        if (accountID !== knownAccountID || !accountID) { invalidateLookups(); knownAccountID = accountID; }
        accountPage = accountID ? { ...result, accountID } : null;
        return account;
      })();
      accountPending = pending;
      try { return await pending; } finally { if (accountPending === pending) accountPending = null; }
    }
    async function requireAccount() {
      const account = await getAccount();
      if (!account.authenticated) fail("LOGIN_REQUIRED", "请先在插件内登录科研通。");
      if (!/^[A-Za-z0-9]+$/.test(account.accountID || "")) fail("ACCOUNT_UNVERIFIED", "当前账号标识尚未确认。");
      return account;
    }
    async function getRequest(id) {
      const identity = requestIdentity(id);
      const result = await page(identity.requestURL);
      if (new URL(result.response.url).pathname === PATHS.login) fail("LOGIN_REQUIRED", "请先在插件内登录科研通。");
      return parseRequest(result.doc, result.response.url, model);
    }

    async function searchOwnRequests(doi, checkCancelled = () => {}) {
      checkCancelled();
      const normalized = model.normalizeDOI(doi);
      if (!normalized) fail("DOI_REQUIRED", "查找已有求助需要 DOI。");
      const parser = requireContract("ownRequests", value => typeof value === "function");
      const account = await requireAccount();
      checkCancelled();
      // The account check already fetched the first own-list page. Refreshing that
      // page for every search catches newly created requests without re-fetching
      // every historical detail in a batch. Cached entries never include files.
      const firstPage = accountPage?.accountID === account.accountID ? accountPage : null;
      const visited = new Set();
      let next = ORIGIN + PATHS.ownRequests;
      const matches = [];
      for (let count = 0; next && count < 50; count++) {
        next = siteURL(next);
        if (visited.has(next)) fail("INCOMPLETE_SEARCH", "我的求助分页形成循环，不能安全确认是否已经求助。");
        visited.add(next);
        const result = count === 0 && firstPage ? firstPage : await cachedLookup("page:" + account.accountID + ":" + next, () => page(next));
        checkCancelled();
        if (new URL(result.response.url).pathname === PATHS.login) fail("LOGIN_REQUIRED", "查找已有求助时登录已失效。");
        const data = parser(result.doc, result.response.url, account);
        if (!data || !Array.isArray(data.items) || data.complete !== true) fail("INCOMPLETE_SEARCH", "已有求助列表未读取完整，已停止自动发布。");
        if (count === 0) {
          const fingerprint = JSON.stringify([data.items.map(item => [item.requestID || item.requestURL, item.doi || "", item.title || ""]), data.nextURL]);
          if (firstListFingerprint !== null && firstListFingerprint !== fingerprint) invalidateLookups();
          firstListFingerprint = fingerprint;
        }
        for (const item of data.items) {
          const listedDOI = model.normalizeDOI(item.doi);
          if (listedDOI && listedDOI !== normalized) continue;
          const requestID = requestIdentity(item.requestURL || item.requestID).requestID;
          const metadata = await cachedLookup("doi:" + account.accountID + ":" + requestID, async () => { const value = await getRequest(requestID); return { doi: value.doi, ownerID: value.ownerID }; });
          checkCancelled();
          if (metadata.ownerID !== account.accountID || (listedDOI && metadata.doi !== listedDOI)) fail("REQUEST_MISMATCH", "求助列表中的文献或账号对应关系不一致。");
          if (metadata.doi !== normalized) continue;
          const detail = await getRequest(requestID);
          checkCancelled();
          if (detail.ownerID !== account.accountID || detail.doi !== normalized) fail("REQUEST_MISMATCH", "匹配求助的最新文献或账号信息已变化。");
          if (!matches.some(value => value.requestID === detail.requestID)) matches.push(detail);
          // Finding an owned active request is sufficient to prevent a new POST;
          // no reason to fetch every historical PDF request before reusing it.
          if (detail.state === "available" || detail.state === "waiting") return { accountID: account.accountID, doi: normalized, matches, complete: false };
        }
        next = data.nextURL ? siteURL(data.nextURL) : null;
      }
      if (next) fail("INCOMPLETE_SEARCH", "已有求助超过本轮核查范围，不能安全重复发布。");
      const priority = { available: 0, waiting: 1, closed: 2 };
      matches.sort((a, b) => priority[a.state] - priority[b.state]);
      return { accountID: account.accountID, doi: normalized, matches, complete: true };
    }

    async function findExistingRequest(doi) {
      return (await searchOwnRequests(doi)).matches[0] || null;
    }

    async function listMessages() {
      const contract = requireContract("messages", value => typeof value.prepare === "function" && typeof value.parse === "function");
      const account = await requireAccount();
      const prepared = await contract.prepare({ account, page });
      if (!prepared || !["GET", "POST"].includes(prepared.method) || prepared.marksRead !== false) fail("UNVERIFIED_CONTRACT", "消息接口是否改变未读状态尚未核实，未自动读取或标记消息。");
      const response = await send(prepared);
      const result = contract.parse(response, parseHTML, { account });
      if (!result || !Array.isArray(result.messages)) fail("STRUCTURE_CHANGED", "科研通消息响应结构发生变化。");
      return result.messages.map(message => {
        const identity = message.requestID ? requestIdentity(message.requestID) : null;
        let url = identity ? identity.requestURL : "";
        if (message.url) url = siteURL(message.url);
        return { id: shortText(message.id, 128), title: shortText(message.title, 240), text: shortText(message.text, 1000), createdAt: shortText(message.createdAt, 80), url, read: message.read === true, requestID: identity?.requestID || null };
      });
    }

    async function submitRequest({ doi, points, isCancelled = () => false }) {
      if (typeof isCancelled !== "function") throw new TypeError("isCancelled must be a function");
      function checkCancelled() {
        if (!isCancelled()) return;
        const error = new Error("求助已取消，未继续发布。");
        error.name = "AbortError";
        throw error;
      }
      checkCancelled();
      const normalized = model.normalizeDOI(doi);
      if (!normalized) fail("DOI_REQUIRED", "自动求助需要有效 DOI。");
      const amount = model.validatePoints(points);
      const contract = requireContract("submission", value => typeof value.prepare === "function" && typeof value.parse === "function");
      if (!intentStore || !["get", "claim", "set"].every(name => typeof intentStore[name] === "function")) fail("PERSISTENCE_REQUIRED", "必须先配置可持久保存的提交记录，避免重启后重复扣分。");
      const account = await requireAccount();
      checkCancelled();
      const key = account.accountID + ":" + normalized;
      if (inFlight.has(key)) return inFlight.get(key);
      const operation = (async () => {
        const previous = await intentStore.get(key);
        checkCancelled();
        if (previous?.state === "confirmed" && previous.requestID) {
          const confirmed = await getRequest(previous.requestID);
          checkCancelled();
          if (confirmed.doi !== normalized || confirmed.ownerID !== account.accountID) fail("REQUEST_MISMATCH", "已保存的求助记录与当前文献或账号不一致，未再次发布。");
          return { ...confirmed, reused: true };
        }
        const existing = await searchOwnRequests(normalized, checkCancelled);
        checkCancelled();
        if (existing.matches.length) {
          if (previous) await intentStore.set(key, { ...previous, state: "confirmed", requestID: existing.matches[0].requestID });
          checkCancelled();
          return { ...existing.matches[0], reused: true };
        }
        if (previous && !["cancelled_before_send", "rejected"].includes(previous.state)) fail("SUBMISSION_UNKNOWN", "本篇文献存在历史提交记录；未找到结果也不能自动重新发布。", { reconcileRequired: true });
        const formPage = await page(PATHS.create);
        checkCancelled();
        if (new URL(formPage.response.url).pathname === PATHS.login) fail("LOGIN_REQUIRED", "发布前登录已失效。");
        const cancellablePage = async url => { checkCancelled(); const result = await page(url); checkCancelled(); return result; };
        const query = async (url, fields) => {
          checkCancelled();
          const response = await postFormJSON(formPage.doc, url, fields);
          checkCancelled();
          return response;
        };
        const prepared = await contract.prepare({ doc: formPage.doc, url: formPage.response.url, doi: normalized, points: amount, account, page: cancellablePage, query, delay, checkCancelled });
        checkCancelled();
        if (!prepared || prepared.method !== "POST" || !prepared.fields || !prepared.body || typeof prepared.body !== "object") fail("UNVERIFIED_CONTRACT", "未能从真实发布页面核实提交字段。");
        const submitURL = siteURL(prepared.url);
        if (!Number.isInteger(prepared.minimumPoints) || prepared.minimumPoints < 1) fail("UNVERIFIED_CONTRACT", "网站最低悬赏积分尚未核实。");
        if (prepared.minimumPoints > amount) fail("POINTS_TOO_LOW", "网站最低要求为 " + prepared.minimumPoints + " 积分，超过当前配置；未发布、未自动加价。");
        if (model.normalizeDOI(prepared.body[prepared.fields.doi]) !== normalized || model.validatePoints(prepared.body[prepared.fields.points]) !== amount) fail("SUBMISSION_MISMATCH", "提交表单中的 DOI 或积分与任务不一致。");
        const token = csrf(formPage.doc);
        const body = new URLSearchParams();
        for (const [name, value] of Object.entries(prepared.body)) {
          if (typeof value !== "string" && typeof value !== "number") fail("UNVERIFIED_CONTRACT", "提交表单包含未核实的字段类型。");
          body.set(name, String(value));
        }
        body.set(token.name, token.token);
        const intent = { accountID: account.accountID, doi: normalized, points: amount, state: "sending", createdAt: new Date().toISOString() };
        checkCancelled();
        // A verified rejection confirms that no request was accepted. An explicit
        // later invocation may retry after a fresh own-list check. claim must
        // atomically replace only absent, cancelled_before_send or rejected records.
        const claimed = await intentStore.claim(key, intent);
        if (!claimed) { checkCancelled(); fail("SUBMISSION_UNKNOWN", "另一个任务已记录本篇提交；已阻止重复发送。", { reconcileRequired: true }); }
        let result, postStarted = false;
        try {
          // Cancellation can arrive while the durable claim is being written. There
          // is no await between this final guard and dispatching the actual POST.
          checkCancelled();
          invalidateLookups();
          postStarted = true;
          const response = await send({ url: submitURL, method: "POST", body: body.toString(), headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-CSRF-Token": token.token, "X-Requested-With": "XMLHttpRequest", "Accept": "application/json" }, responseType: "text" }, true);
          result = contract.parse(response, parseHTML);
          if (!result || !["confirmed", "rejected"].includes(result.kind)) fail("SUBMISSION_UNKNOWN", "服务器尚未返回可核实的求助结果。", { reconcileRequired: true });
          if (result.kind === "rejected") {
            await intentStore.set(key, { ...intent, state: "rejected", reason: shortText(result.message, 500) });
            fail("REQUEST_REJECTED", shortText(result.message, 500) || "网站拒绝此次求助。");
          }
          const identity = requestIdentity(result.requestURL || result.requestID);
          await intentStore.set(key, { ...intent, state: "confirmed", requestID: identity.requestID });
          invalidateLookups();
          const detail = await getRequest(identity.requestID);
          if (detail.doi !== normalized || detail.ownerID !== account.accountID || detail.points !== amount) fail("SUBMISSION_MISMATCH", "求助已创建，但详情中的文献、账号或积分需人工核实；不会再次发布。");
          return { ...detail, reused: false };
        } catch (error) {
          if (!postStarted && error.name === "AbortError") {
            await intentStore.set(key, { ...intent, state: "cancelled_before_send" });
            throw error;
          }
          if (!result || result.kind !== "confirmed") {
            if (error.code !== "REQUEST_REJECTED") {
              try { await intentStore.set(key, { ...intent, state: "unknown" }); } catch (_) {}
            }
          }
          throw error;
        }
      })();
      inFlight.set(key, operation);
      try { return await operation; } finally { inFlight.delete(key); }
    }

    async function getDownload(requestValue, fileValue) {
      const account = await requireAccount();
      const detail = await getRequest(typeof requestValue === "string" ? requestValue : requestValue.requestID);
      if (detail.ownerID !== account.accountID) fail("ACCOUNT_MISMATCH", "该求助不属于当前登录账号，未下载文件。");
      if (detail.expired) fail("DOWNLOAD_EXPIRED", "页面提示文件已过期或删除。");
      const fileID = typeof fileValue === "string" ? fileValue : fileValue && (fileValue.fileID || fileValue.id);
      const file = detail.files.find(entry => entry.fileID === fileID);
      if (!file || !file.downloadURL || !["waiting", "accept"].includes(file.status)) fail("DOWNLOAD_NOT_AVAILABLE", "当前页面尚未提供本账号可用的文件下载入口。", { retryable: detail.remoteState === "waiting" });
      // Even a file-record GET may select the site's paid smart/high-speed route.
      // Do not expose a followable URL until ordinary zero-cost download is verified.
      if (typeof contracts.download !== "function") fail("UNVERIFIED_CONTRACT", "尚未核实普通下载入口及额外扣分条件，未请求文件链接。");
      const resolved = await contracts.download({ detail, file, account, page, query: postFormJSON });
      if (!resolved || resolved.costPoints !== 0 || typeof resolved.url !== "string") fail("UNVERIFIED_CONTRACT", "普通下载地址或额外扣分条件尚未核实。");
      const url = new URL(resolved.url);
      const allowed = new Set([ORIGIN, ...(contracts.downloadOrigins || [])]);
      if (url.protocol !== "https:" || url.username || url.password || !allowed.has(url.origin)) fail("INVALID_DOWNLOAD_URL", "下载地址不属于已核实的下载服务器。");
      return { requestID: detail.requestID, fileID: file.fileID, filename: resolved.filename || file.filename, url: url.href, method: "GET", resolved: true, costPoints: 0, expectedSize: resolved.expectedSize || null, allowedOrigins: resolved.allowedOrigins || [url.origin] };
    }

    return Object.freeze({ getAccount, listMessages, findExistingRequest, submitRequest, getRequest, getDownload });
  }

  const api = Object.freeze({ ORIGIN, PATHS, AbleSciError, parseAccount, parseRequest, parseOwnRequests, parseMessages, parseDownloadPage, create });
  root.FulltextAbleSci = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
