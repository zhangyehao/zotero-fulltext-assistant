/* The plugin's own AbleSci pages: read snapshots and explicitly requested login filling. */
const ALLOWED_ORIGIN = "https://www.ablesci.com";
const DOI_PATTERN = /10\.\d{4,9}\/[A-Z0-9][A-Z0-9._;()/:+-]*/gi;

function shortText(value, limit = 180) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function visible(element, win) {
  if (!element || element.closest("[hidden], [aria-hidden='true'], script, style, template")) return false;
  const style = win.getComputedStyle(element);
  if (typeof element.getClientRects === "function" && element.getClientRects().length === 0) return false;
  return style.display !== "none" && style.visibility !== "hidden";
}

function doiValues(text) {
  return [...String(text || "").matchAll(DOI_PATTERN)]
    .map(match => match[0].replace(/[.,;:]+$/, "").toLowerCase());
}

function getLabel(element) {
  return shortText(element.innerText || element.textContent || element.getAttribute("aria-label"));
}

function snapshot(doc, win) {
  const current = new URL(doc.location.href);
  if (current.origin !== ALLOWED_ORIGIN || win !== win.top) {
    throw new Error("只能读取插件中科研通网站的顶层页面。");
  }
  const title = shortText(doc.title, 240);
  const doiEvidence = [];
  const addDOI = (raw, source) => {
    for (const doi of doiValues(raw)) {
      if (!doiEvidence.some(value => value.doi === doi && value.source === source)) {
        doiEvidence.push({ doi, source });
      }
    }
  };
  for (const meta of doc.querySelectorAll('meta[name="citation_doi"], meta[name="DC.Identifier"], meta[name="dc.identifier"], meta[name="dc.Identifier"]')) {
    addDOI(meta.getAttribute("content"), "metadata");
  }
  for (const link of doc.querySelectorAll('a[href*="doi.org/"]')) {
    if (visible(link, win)) addDOI(link.href, "doi-link");
  }
  for (const element of doc.querySelectorAll("dt, th, label, .label, .field-label")) {
    if (!visible(element, win) || !/^DOI\s*[:：]?$/i.test(getLabel(element))) continue;
    const neighbor = element.nextElementSibling;
    if (neighbor && visible(neighbor, win)) addDOI(getLabel(neighbor), "labelled-field");
  }
  // Only return explicitly labelled DOI snippets, never the page's complete text.
  const pageText = doc.body ? (doc.body.innerText || doc.body.textContent || "") : "";
  for (const match of pageText.matchAll(/\bDOI\s*[:：]\s*(10\.\d{4,9}\/[^\s<>]+)/gi)) {
    addDOI(match[1], "labelled-text");
  }
  const doiCandidates = [...new Set(doiEvidence.map(item => item.doi))].slice(0, 20);

  const fileLinks = [];
  const accountMarkers = [];
  const loginLinks = [];
  for (const element of doc.querySelectorAll("a[href], button, input[type=submit]")) {
    if (!visible(element, win)) continue;
    const label = getLabel(element);
    const raw = element.getAttribute("href");
    let href = null;
    try { if (raw) href = new URL(raw, current.href); } catch (_) {}
    if (href && href.protocol === "https:" && !href.username && !href.password) {
      if ((/下载|附件|获取文件|download|\.pdf\b/i.test(label) || /\/download(?:\/|$)|\.pdf(?:$|\?)/i.test(href.href))
          && !/客户端|插件|浏览器|app|chrome|edge/i.test(label)) {
        fileLinks.push({ label: shortText(label || "文件链接", 100), url: href.href, sameOrigin: href.origin === ALLOWED_ORIGIN });
      }
      if (href.origin === ALLOWED_ORIGIN && /\/(?:logout|signout)(?:[/?#]|$)/i.test(href.pathname)) {
        accountMarkers.push({ type: "logout-link", label: shortText(label, 60), path: href.pathname });
      }
      if (href.origin === ALLOWED_ORIGIN && /\/(?:login|signin)(?:[/?#]|$)/i.test(href.pathname)) {
        loginLinks.push({ label: shortText(label, 60), path: href.pathname });
      }
    }
    if (/^(退出登录|退出登陆|注销登录|退出账号|Log out|Sign out)$/i.test(label)) {
      accountMarkers.push({ type: "logout-control", label: shortText(label, 60) });
    }
  }
  const passwordField = [...doc.querySelectorAll('input[type="password"]')].some(element => visible(element, win));
  const loginPage = /\/(?:login|signin)(?:\/|$)/i.test(current.pathname);
  // A public page or a navigation label alone cannot prove authentication.
  const hasLogoutRoute = accountMarkers.some(marker => marker.type === "logout-link");
  const loggedIn = passwordField ? false : (hasLogoutRoute ? true : null);
  const stateEvidence = [];
  const stateLabels = ["求助中", "待确认", "已完结", "已关闭", "等待应助", "等待帮助", "等待应答", "待应助", "正在求助", "已应助", "应助成功", "下载附件", "确认采纳", "已采纳", "已完成", "已过期", "求助已关闭", "登录后", "请先登录", "验证码"];
  for (const label of stateLabels) {
    if (pageText.includes(label)) stateEvidence.push({ text: label, meaning: "visible-page-text-not-verified-state" });
  }
  return {
    url: current.href,
    title,
    readyState: doc.readyState,
    requestKey: current.pathname === "/assist/detail" && /^[a-z0-9]+$/i.test(current.searchParams.get("id") || "")
      ? current.searchParams.get("id") : null,
    doi: doiCandidates.length === 1 ? doiCandidates[0] : null,
    doiCandidates,
    doiEvidence: doiEvidence.slice(0, 30),
    stateEvidence,
    fileLinks: fileLinks.slice(0, 30),
    accountEvidence: {
      loggedIn,
      markers: accountMarkers.slice(0, 10),
      loginPage,
      visiblePasswordForm: passwordField,
      loginLinks: loginLinks.slice(0, 5),
    },
    caveats: [
      "公开页面可读取不等于已登录；登录状态只依据页面可见证据。",
      "状态词和文件链接仅为候选证据，未核实应助成功或文件可下载。",
      "未提交表单、未点击链接、未下载附件、未确认采纳。",
    ],
  };
}

export class FulltextConnectionInspectionChild extends JSWindowActorChild {
  receiveMessage(message) {
    if (message.name === "Fulltext:ReadOnlySnapshot") return snapshot(this.document, this.contentWindow);
    if (message.name === "Fulltext:FillSavedLogin") return fillSavedLogin(this.document, this.contentWindow, message.data);
    throw new Error("不支持的页面消息。");
  }
}

function fillSavedLogin(doc, win, credentials) {
  const current = new URL(doc.location.href);
  if (win !== win.top || current.origin !== ALLOWED_ORIGIN || current.pathname !== "/site/login") {
    throw new Error("只允许在科研通的顶层账号登录页填入保存的凭据。");
  }
  if (typeof credentials?.username !== "string" || typeof credentials?.password !== "string") throw new Error("保存的凭据格式无效。");
  const passwords = [...doc.querySelectorAll('input[type="password"]')].filter(element => visible(element, win) && !element.disabled);
  if (passwords.length !== 1 || !passwords[0].form) throw new Error("未能唯一识别登录表单，请在网页中手动填写。");
  const password = passwords[0];
  const form = password.form;
  const action = new URL(form.getAttribute("action") || current.href, current.href);
  if (action.origin !== ALLOWED_ORIGIN || action.username || action.password) throw new Error("登录表单目标异常，未填入凭据。");
  const candidates = [...form.querySelectorAll('input:not([type]), input[type="text"], input[type="email"], input[type="tel"]')]
    .filter(element => visible(element, win) && !element.disabled
      && !/captcha|verify|verification|code|验证码/i.test([element.name, element.id, element.getAttribute("placeholder")].join(" ")));
  const preferred = candidates.filter(element => element.autocomplete === "username" || /username|email|account|mobile|phone/i.test([element.name, element.id].join(" ")));
  const choices = preferred.length ? preferred : candidates;
  if (choices.length !== 1) throw new Error("未能唯一识别账号输入框，请在网页中手动填写。");
  function fill(input, value) {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, value); else input.value = value;
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    input.dispatchEvent(new win.Event("change", { bubbles: true }));
  }
  fill(choices[0], credentials.username);
  fill(password, credentials.password);
  return { filled: true, submitted: false, message: "账号密码已填入。请完成验证码并自行点击网站登录按钮。" };
}
