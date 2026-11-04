"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseHTML } = require("linkedom");
const model = require("../src/task-model.js");
const adapter = require("../src/ablesci.js");
const ORIGIN = adapter.ORIGIN;
const DOI = "10.1159/000448372";
const parser = html => parseHTML(html).document;

// Minimal fixtures reproduce public, observed class/field contracts. Account and
// submission fixtures below are mock contracts, not evidence of a live private API.
function accountHTML(id = "Account1") {
  return `<ul class="able-head-user"><li><a href="/user/home?id=${id}">Test user</a></li><li><a href="/site/logout">退出登录</a></li></ul>`;
}
function detailHTML({ id = "Request1", state = "uploaded", owner = "Account1", points = 20, forbidden = false, fileStatus = "waiting", file = true, expired = false, doi = DOI } = {}) {
  return `<html><body>${accountHTML(owner)}
  <aside><span class="assist-badge assist-badge-closed">已关闭</span><a href="https://doi.org/10.9999/unrelated">unrelated</a></aside>
  <div class="assist-detail-page"><span class="assist-badge assist-badge-${state}">${state}</span>
    <input class="assist-id-val" value="${id}"><div class="assist-detail"><table class="stable"><tbody>
    <tr><td>标题</td><td class="assist-title"><div>Seasonal Variation</div><a data-clipboard-text="Seasonal Variation"></a></td></tr>
    <tr><td>DOI</td><td><div class="assist-doi"><button data-clipboard-text="${doi}">复制</button></div></td></tr>
    <tr><td>网址</td><td><div class="assist-url"><a href="https://doi.org/${doi}">official</a></div></td></tr>
    <tr><td>求助人</td><td><a href="/user/home?id=${owner}">Test user</a>，悬赏 <span>${points}</span> 积分</td></tr>
    <tr><td>下载</td><td>${expired ? "该求助完结已超 24 小时，文件已从服务器自动删除，无法下载。" : "当前下载状态"}</td></tr>
    </tbody></table></div><div id="assist-timeline"><ul>
    ${file ? `<li class="layui-timeline-item"><div class="file-info"><span class="assistfile-badge assistfile-badge-${fileStatus}">file status</span><a class="name ${forbidden ? "assist-download-forbidden" : ""}" href="${forbidden ? "javascript:void(0)" : "/fixture-file?file=File1"}">000448372.pdf</a><span class="size">(538.16 KB)</span></div><input class="assist-file-id" value="File1"></li>` : ""}
    </ul></div></div></body></html>`;
}
function response(url, text, status = 200) { return { status, url: new URL(url, ORIGIN).href, text }; }
function memoryStore() {
  const values = new Map();
  return {
    values,
    async get(key) { return values.has(key) ? { ...values.get(key) } : null; },
    async claim(key, value) { if (values.has(key) && !["cancelled_before_send", "rejected"].includes(values.get(key).state)) return false; values.set(key, { ...value }); return true; },
    async set(key, value) { values.set(key, { ...value }); },
  };
}

test("public detail parser uses the request badge, DOI field and actual file record", () => {
  const result = adapter.parseRequest(parser(detailHTML({ forbidden: true })), ORIGIN + "/assist/detail?id=Request1", model);
  assert.equal(result.requestID, "Request1");
  assert.equal(result.doi, DOI);
  assert.equal(result.remoteState, "uploaded");
  assert.equal(result.state, "available");
  assert.equal(result.ownerID, "Account1");
  assert.equal(result.points, 20);
  assert.equal(result.files[0].id, "File1");
  assert.equal(result.files[0].name, "000448372.pdf");
  assert.equal(result.files[0].downloadURL, null);
  assert.equal(result.permissionRequired, true);
});

test("withdrawn files and expired requests are not advertised as downloadable", () => {
  const rejected = adapter.parseRequest(parser(detailHTML({ state: "waiting", fileStatus: "reject" })), ORIGIN + "/assist/detail?id=Request1", model);
  assert.equal(rejected.state, "waiting");
  assert.equal(rejected.files[0].downloadURL, null);
  const expired = adapter.parseRequest(parser(detailHTML({ state: "finished", expired: true })), ORIGIN + "/assist/detail?id=Request1", model);
  assert.equal(expired.state, "closed");
  assert.equal(expired.expired, true);
});

test("unknown badge contracts and mismatched detail IDs fail explicitly", () => {
  assert.throws(() => adapter.parseRequest(parser(detailHTML({ state: "newstate" })), ORIGIN + "/assist/detail?id=Request1", model), { code: "STRUCTURE_CHANGED" });
  assert.throws(() => adapter.parseRequest(parser(detailHTML({ id: "Other" })), ORIGIN + "/assist/detail?id=Request1", model), { code: "REQUEST_MISMATCH" });
  assert.throws(() => adapter.parseRequest(parser(detailHTML()), "https://www.ablesci.com.evil.test/assist/detail?id=Request1", model), { code: "INVALID_URL" });
});

test("a login-success template or a public header cannot authenticate an account", () => {
  const login = parser('<ul class="able-head-user able-head-user-guest"></ul><section hidden>登录成功</section>');
  assert.equal(adapter.parseAccount(login, ORIGIN + "/site/login").authenticated, false);
  assert.equal(adapter.parseAccount(login, ORIGIN + "/my/assist-my").authenticated, false);
  assert.throws(() => adapter.parseAccount(parser(accountHTML()), ORIGIN + "/assist/detail?id=Request1"), { code: "ACCOUNT_UNVERIFIED" });
  const signed = adapter.parseAccount(parser(accountHTML()), ORIGIN + "/my/assist-my");
  assert.equal(signed.accountID, "Account1");
  assert.equal(signed.username, "Test user");
});

test("public getRequest works while unverified private capabilities send no requests", async () => {
  const calls = [];
  const client = adapter.create({ model, parseHTML: parser, contracts: { ownRequests: null, submission: null, messages: null, download: null }, request: async spec => { calls.push(spec); return response(spec.url, detailHTML()); } });
  assert.equal((await client.getRequest("Request1")).doi, DOI);
  const before = calls.length;
  await assert.rejects(client.listMessages(), { code: "UNVERIFIED_CONTRACT" });
  await assert.rejects(client.findExistingRequest(DOI), { code: "UNVERIFIED_CONTRACT" });
  await assert.rejects(client.submitRequest({ doi: DOI, points: 20 }), { code: "UNVERIFIED_CONTRACT" });
  assert.equal(calls.length, before);
  assert.ok(calls.every(call => call.method === "GET"));
  await assert.rejects(client.getRequest("/other?id=Request1"), { code: "INVALID_REQUEST" });
});

test("login redirects are distinguished from transient read failures", async () => {
  const client = adapter.create({ model, parseHTML: parser, request: async () => response("/site/login", '<ul class="able-head-user-guest"></ul>') });
  assert.equal((await client.getAccount()).authenticated, false);
  await assert.rejects(client.getRequest("Request1"), { code: "LOGIN_REQUIRED" });
  const limited = adapter.create({ model, parseHTML: parser, request: async spec => response(spec.url, "rate limit", 429) });
  await assert.rejects(limited.getRequest("Request1"), { code: "RATE_LIMITED", retryable: true });
});

function submissionHarness({ minimum = 10, failPost = false, store = memoryStore(), existing = [], incomplete = false, bodyPoints = null } = {}) {
  const calls = [];
  const state = { existing };
  const contracts = {
    ownRequests: () => ({ items: state.existing.map(requestID => ({ requestID, doi: DOI })), nextURL: null, complete: !incomplete }),
    submission: {
      prepare: ({ doi, points }) => ({ url: "/__test_fixture__/submit", method: "POST", minimumPoints: minimum, fields: { doi: "fixture_doi", points: "fixture_points" }, body: { fixture_doi: doi, fixture_points: bodyPoints ?? points } }),
      parse: result => ({ kind: "confirmed", requestID: JSON.parse(result.text).fixtureCreatedID }),
    },
  };
  const request = async spec => {
    calls.push(spec);
    const url = new URL(spec.url);
    if (spec.method === "POST") {
      assert.equal(store.values.get("Account1:" + DOI).state, "sending", "intent must be durable before submission");
      if (failPost) throw new Error("simulated response loss");
      return response(spec.url, JSON.stringify({ fixtureCreatedID: "Created1" }));
    }
    if (url.pathname === "/my/assist-my") return response(spec.url, accountHTML());
    if (url.pathname === "/assist/create") return response(spec.url, `${accountHTML()}<meta name="csrf-param" content="_csrf"><meta name="csrf-token" content="fixture-ephemeral-token">`);
    if (url.pathname === "/assist/detail") return response(spec.url, detailHTML({ id: url.searchParams.get("id") }));
    throw new Error("unexpected mock request");
  };
  return { client: adapter.create({ request, parseHTML: parser, model, contracts, intentStore: store }), calls, store, state, request, contracts };
}

test("submission validates exact points and persists intent before a single POST", async () => {
  const harness = submissionHarness();
  const result = await harness.client.submitRequest({ doi: DOI, points: 20 });
  assert.equal(result.requestID, "Created1");
  assert.equal(result.reused, false);
  const posts = harness.calls.filter(call => call.method === "POST");
  assert.equal(posts.length, 1);
  const body = new URLSearchParams(posts[0].body);
  assert.equal(body.get("fixture_points"), "20");
  assert.equal(body.get("fixture_doi"), DOI);
  assert.equal(body.get("_csrf"), "fixture-ephemeral-token");
  assert.equal(JSON.stringify([...harness.store.values.values()]).includes("fixture-ephemeral-token"), false);
  assert.equal((await harness.client.submitRequest({ doi: DOI, points: 40 })).reused, true);
  assert.equal(harness.calls.filter(call => call.method === "POST").length, 1);
});

test("minimum points, mismatched form values and incomplete duplicate checks block POST", async () => {
  for (const [options, code] of [[{ minimum: 30 }, "POINTS_TOO_LOW"], [{ bodyPoints: 21 }, "SUBMISSION_MISMATCH"], [{ incomplete: true }, "INCOMPLETE_SEARCH"]]) {
    const harness = submissionHarness(options);
    await assert.rejects(harness.client.submitRequest({ doi: DOI, points: 20 }), { code });
    assert.equal(harness.calls.filter(call => call.method === "POST").length, 0);
    assert.equal(harness.store.values.size, 0);
  }
});

test("response loss is reconciled across adapter restarts and never automatically posted again", async () => {
  const store = memoryStore();
  const first = submissionHarness({ failPost: true, store });
  await assert.rejects(first.client.submitRequest({ doi: DOI, points: 20 }), { code: "SUBMISSION_UNKNOWN", reconcileRequired: true, retryable: false });
  assert.equal(store.values.get("Account1:" + DOI).state, "unknown");
  const restarted = submissionHarness({ store });
  await assert.rejects(restarted.client.submitRequest({ doi: DOI, points: 20 }), { code: "SUBMISSION_UNKNOWN" });
  assert.equal(restarted.calls.filter(call => call.method === "POST").length, 0);
  restarted.state.existing = ["Created1"];
  assert.equal((await restarted.client.submitRequest({ doi: DOI, points: 20 })).requestID, "Created1");
  assert.equal(store.values.get("Account1:" + DOI).state, "confirmed");
  assert.equal(restarted.calls.filter(call => call.method === "POST").length, 0);
});

test("concurrent submissions for the same account and DOI produce one POST", async () => {
  const harness = submissionHarness();
  const result = await Promise.all([harness.client.submitRequest({ doi: DOI, points: 20 }), harness.client.submitRequest({ doi: DOI, points: 20 })]);
  assert.equal(result[0].requestID, result[1].requestID);
  assert.equal(harness.calls.filter(call => call.method === "POST").length, 1);
});

test("a cancellation already requested prevents every preflight request", async () => {
  const harness = submissionHarness();
  await assert.rejects(harness.client.submitRequest({ doi: DOI, points: 20, isCancelled: () => true }), { name: "AbortError" });
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.store.values.size, 0);
});

test("cancellation during asynchronous preflight never creates an intent or posts", async () => {
  for (const stage of ["account", "journal", "own-list", "create", "prepare"]) {
    let cancelled = false, accountReads = 0;
    const harness = submissionHarness();
    const originalGet = harness.store.get;
    harness.store.get = async key => { const value = await originalGet(key); if (stage === "journal") cancelled = true; return value; };
    const originalPrepare = harness.contracts.submission.prepare;
    harness.contracts.submission.prepare = async args => { const value = await originalPrepare(args); if (stage === "prepare") cancelled = true; return value; };
    const request = async spec => {
      const value = await harness.request(spec);
      const path = new URL(spec.url).pathname;
      if (path === "/my/assist-my") {
        accountReads++;
        if ((stage === "account" && accountReads === 1) || (stage === "own-list" && accountReads === 2)) cancelled = true;
      }
      if (stage === "create" && path === "/assist/create") cancelled = true;
      return value;
    };
    const client = adapter.create({ request, parseHTML: parser, model, contracts: harness.contracts, intentStore: harness.store });
    await assert.rejects(client.submitRequest({ doi: DOI, points: 20, isCancelled: () => cancelled }), { name: "AbortError" }, stage);
    assert.equal(harness.calls.filter(call => call.method === "POST").length, 0, stage);
    assert.equal(harness.store.values.size, 0, stage);
  }
});

test("cancellation during duplicate detail lookup stops before further pages or submission", async () => {
  let cancelled = false;
  const harness = submissionHarness();
  harness.contracts.ownRequests = () => ({ items: [{ requestID: "Other1" }, { requestID: "Other2" }], nextURL: "/my/assist-my?page=2", complete: true });
  const request = async spec => {
    const value = await harness.request(spec);
    if (new URL(spec.url).pathname === "/assist/detail") cancelled = true;
    return value;
  };
  const client = adapter.create({ request, parseHTML: parser, model, contracts: harness.contracts, intentStore: harness.store });
  await assert.rejects(client.submitRequest({ doi: DOI, points: 20, isCancelled: () => cancelled }), { name: "AbortError" });
  assert.equal(harness.calls.filter(call => new URL(call.url).pathname === "/assist/detail").length, 1);
  assert.equal(harness.calls.filter(call => call.method === "POST").length, 0);
  assert.equal(harness.store.values.size, 0);
});

test("cancellation during durable claim is recorded as unsent and can explicitly retry after restart", async () => {
  let cancelled = false;
  const store = memoryStore();
  const originalClaim = store.claim;
  store.claim = async (key, value) => { const claimed = await originalClaim(key, value); cancelled = true; return claimed; };
  const harness = submissionHarness({ store });
  await assert.rejects(harness.client.submitRequest({ doi: DOI, points: 20, isCancelled: () => cancelled }), { name: "AbortError" });
  assert.equal(harness.calls.filter(call => call.method === "POST").length, 0);
  assert.equal(store.values.get("Account1:" + DOI).state, "cancelled_before_send");
  store.claim = originalClaim;
  const restarted = submissionHarness({ store });
  assert.equal((await restarted.client.submitRequest({ doi: DOI, points: 20 })).requestID, "Created1");
  assert.equal(restarted.calls.filter(call => call.method === "POST").length, 1);
  assert.equal(store.values.get("Account1:" + DOI).state, "confirmed");
});

test("cancellation after POST dispatch preserves the confirmed remote request", async () => {
  let cancelled = false;
  const harness = submissionHarness();
  const request = async spec => { const value = await harness.request(spec); if (spec.method === "POST") cancelled = true; return value; };
  const client = adapter.create({ request, parseHTML: parser, model, contracts: harness.contracts, intentStore: harness.store });
  const result = await client.submitRequest({ doi: DOI, points: 20, isCancelled: () => cancelled });
  assert.equal(result.requestID, "Created1");
  assert.equal(harness.store.values.get("Account1:" + DOI).state, "confirmed");
  assert.equal(harness.calls.filter(call => call.method === "POST").length, 1);
});

test("submission is unavailable without durable intent persistence", async () => {
  const fixture = submissionHarness();
  const client = adapter.create({ request: fixture.request, parseHTML: parser, model, contracts: fixture.contracts });
  await assert.rejects(client.submitRequest({ doi: DOI, points: 20 }), { code: "PERSISTENCE_REQUIRED" });
  assert.equal(fixture.calls.length, 0);
});

test("own-request rows without a DOI are checked against their actual detail page", async () => {
  const harness = submissionHarness();
  harness.contracts.ownRequests = () => ({ items: [{ requestID: "Existing1" }], nextURL: null, complete: true });
  const client = adapter.create({ request: harness.request, parseHTML: parser, model, contracts: harness.contracts, intentStore: harness.store });
  const found = await client.findExistingRequest(DOI);
  assert.equal(found.requestID, "Existing1");
  assert.equal(found.doi, DOI);
  const reused = await client.submitRequest({ doi: DOI, points: 20 });
  assert.equal(reused.requestID, "Existing1");
  assert.equal(harness.calls.filter(call => call.method === "POST").length, 0);
});

test("a corrupted confirmed journal cannot reuse another account's request", async () => {
  const harness = submissionHarness();
  harness.store.values.set("Account1:" + DOI, { state: "confirmed", requestID: "Other1", doi: DOI, accountID: "Account1" });
  const request = async spec => new URL(spec.url).pathname === "/assist/detail"
    ? response(spec.url, detailHTML({ id: "Other1", owner: "OtherAccount" })) : harness.request(spec);
  const client = adapter.create({ request, parseHTML: parser, model, contracts: harness.contracts, intentStore: harness.store });
  await assert.rejects(client.submitRequest({ doi: DOI, points: 20 }), { code: "REQUEST_MISMATCH" });
  assert.equal(harness.calls.filter(call => call.method === "POST").length, 0);
});

test("download descriptors refresh ownership and file permission, never trust a caller-supplied URL", async () => {
  const make = (owner, contracts = { download: null }) => adapter.create({ model, parseHTML: parser, contracts, request: async spec => {
    if (new URL(spec.url).pathname === "/my/assist-my") return response(spec.url, accountHTML());
    return response(spec.url, detailHTML({ owner }));
  } });
  await assert.rejects(make("Account1").getDownload("Request1", "File1"), { code: "UNVERIFIED_CONTRACT" });
  const descriptor = await make("Account1", { download: ({ file }) => ({ url: file.downloadURL, costPoints: 0 }) }).getDownload({ requestID: "Request1" }, { id: "File1", downloadURL: "https://evil.test/steal" });
  assert.equal(descriptor.url, ORIGIN + "/fixture-file?file=File1");
  assert.equal(descriptor.resolved, true);
  assert.equal(descriptor.filename, "000448372.pdf");
  await assert.rejects(make("DifferentAccount").getDownload("Request1", "File1"), { code: "ACCOUNT_MISMATCH" });
});

test("unknown or paid download routes never expose a followable descriptor", async () => {
  for (const costPoints of [undefined, 2]) {
    const calls = [];
    const client = adapter.create({ model, parseHTML: parser, contracts: { download: () => ({ url: ORIGIN + "/__test_fixture__/paid-file", costPoints }) }, request: async spec => {
      calls.push(spec);
      return response(spec.url, new URL(spec.url).pathname === "/my/assist-my" ? accountHTML() : detailHTML());
    } });
    await assert.rejects(client.getDownload("Request1", "File1"), { code: "UNVERIFIED_CONTRACT" });
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => ["/my/assist-my", "/assist/detail"].includes(new URL(call.url).pathname)));
  }
});

test("message contracts that would mark messages read are not invoked", async () => {
  const calls = [];
  const client = adapter.create({ model, parseHTML: parser, request: async spec => { calls.push(spec); return response(spec.url, accountHTML()); }, contracts: {
    messages: { prepare: () => ({ url: "/__test_fixture__/messages", method: "POST", marksRead: true }), parse: () => ({ messages: [] }) },
  } });
  await assert.rejects(client.listMessages(), { code: "UNVERIFIED_CONTRACT" });
  assert.equal(calls.filter(call => call.method === "POST").length, 0);
});

// These fixtures reproduce structures verified in authenticated November 2026
// pages, with synthetic accounts, papers and dates. No captured user data ships.
function modernAccountHTML(id = "Account1") {
  return `<ul class="able-head-user able-head-user-vip"><li><a class="top-right-menu-wrapper" href="javascript:void(0)"><span class="able-head-user-vip-username">Fixture reader</span></a><dl><dd><a href="/my/message">我的消息</a></dd><dd><a href="/site/logout">退出</a></dd></dl></li></ul><script>window.AbleActivity.start({ scope: "${id}", syncUrl: '/user/activity-sync', visitUrl: '/user/visit-add' });</script>`;
}
function ownListHTML({ ids = [], next = null, accountID = "Account1" } = {}) {
  return `${modernAccountHTML(accountID)}<ul id="LAY_mine"><li class="layui-this">我的求助</li></ul><div class="assist-list"><table class="layui-table"><tbody>${ids.map(id => `<tr><td class="list-time">2030-01-01</td><td class="list-subject"><a href="/assist/detail?id=${id}">Fixture paper</a></td><td class="list-satus-item"><span class="assist-badge assist-badge-waiting">求助中</span></td></tr>`).join("")}</tbody></table></div><div class="pages"><ul class="pagination"><li class="next ${next ? "" : "disabled"}">${next ? `<a href="${next}">下页</a>` : "<span>下页</span>"}</li></ul></div>`;
}
function createFormHTML() {
  return `${modernAccountHTML()}<meta name="csrf-param" content="_csrf"><meta name="csrf-token" content="fixture-ephemeral-token"><input id="action-url" value="/assist/create"><form id="assist-create-form" method="post" action="https://www.ablesci.com/assist/create"><input name="onekey"><input name="Assist[doi]"><input name="Assist[title]"><input name="Assist[url]"><input name="Assist[point]" value="10"><input type="radio" name="Assist[type]" value="1" data-point="10" checked><input type="radio" name="Assist[type]" value="4" data-point="30"><textarea name="Assist[note]"></textarea><input name="Assist[remark]"><input type="radio" name="Assist[suppl]" value="0" checked><input name="Assist[close_at]" id="Assist-close_at"></form><span id="point-has">100</span><span id="point-low">10</span><script>const endpoints=['onekey-query','paper-lookup-status','/assist/query-lowest-point','/assist/check-before-assist-create'];$('#Assist-close_at').val('2030-01-06 12:00:00');</script>`;
}
function defaultHarness({ metadata = {}, checkCode = 0, queued = false, ownIDs = [] } = {}) {
  const calls = [], store = memoryStore();
  let lookupPolls = 0;
  const data = { doi: DOI, title: "Fixture DOI paper", url: "https://publisher.example/article", journal: "Example Journal", authors: "Example author", publish_at: "2030", type: 1, min_point: 10, publisher: { point: 10 }, ...metadata };
  const request = async spec => {
    calls.push(spec);
    const path = new URL(spec.url).pathname;
    if (spec.method === "GET" && path === "/my/assist-my") return response(spec.url, ownListHTML({ ids: ownIDs }));
    if (spec.method === "GET" && path === "/assist/create") return response(spec.url, createFormHTML());
    if (spec.method === "GET" && path === "/assist/detail") return response(spec.url, detailHTML({ id: new URL(spec.url).searchParams.get("id"), points: 20 }));
    assert.equal(spec.method, "POST");
    const body = new URLSearchParams(spec.body);
    assert.equal(body.get("_csrf"), "fixture-ephemeral-token");
    assert.equal(spec.headers["X-Requested-With"], "XMLHttpRequest");
    let result;
    if (path === "/assist/onekey-query") result = queued ? { code: 0, status: "queued", job_uuid: "fixture-job" } : { code: 0, data };
    else if (path === "/assist/paper-lookup-status") { lookupPolls++; result = lookupPolls === 1 ? { code: 0, status: "running" } : { code: 0, status: "succeeded", data }; }
    else if (path === "/assist/query-lowest-point") result = { code: 0, point: 10 };
    else if (path === "/assist/check-before-assist-create") result = { code: checkCode };
    else if (path === "/assist/create") {
      assert.equal(store.values.get("Account1:" + DOI)?.state, "sending");
      assert.equal(body.get("Assist[doi]"), DOI);
      assert.equal(body.get("Assist[point]"), "20");
      assert.equal(body.get("Assist[type]"), String(data.type));
      assert.equal(body.get("Assist[suppl]"), "0");
      assert.equal(body.get("Assist[close_at]"), "2030-01-06 12:00:00");
      result = { code: 0, data: { url: "/assist/detail?id=Created1" } };
    } else throw new Error("unexpected default-contract route: " + path);
    if (path !== "/assist/create") {
      const prior = store.values.get("Account1:" + DOI);
      assert.ok(!prior || ["rejected", "cancelled_before_send"].includes(prior.state), "lookup/check POSTs must not create a new publishing intent");
    }
    return response(spec.url, JSON.stringify(result));
  };
  return { calls, store, request, client: adapter.create({ request, parseHTML: parser, model, intentStore: store, delay: async () => {} }) };
}

test("current signed-in navigation uses the unique activity scope and actual display name", () => {
  const account = adapter.parseAccount(parser(modernAccountHTML()), ORIGIN + "/my/assist-my");
  assert.equal(account.accountID, "Account1");
  assert.equal(account.username, "Fixture reader");
  const mixed = modernAccountHTML() + '<script>window.AbleActivity.start({scope:"Other"});</script>';
  assert.throws(() => adapter.parseAccount(parser(mixed), ORIGIN + "/my/assist-my"), { code: "ACCOUNT_UNVERIFIED" });
});

test("default own-list parser scopes rows, validates account and follows contiguous pagination", () => {
  const account = { accountID: "Account1" };
  const first = adapter.parseOwnRequests(parser(ownListHTML({ ids: ["Request1"], next: "/my/assist-my?page=2&per-page=10" })), ORIGIN + "/my/assist-my", account);
  assert.deepEqual(first.items, [{ requestID: "Request1", title: "Fixture paper" }]);
  assert.equal(first.nextURL, ORIGIN + "/my/assist-my?page=2&per-page=10");
  assert.equal(adapter.parseOwnRequests(parser(ownListHTML()), ORIGIN + "/my/assist-my?page=2", account).nextURL, null);
  assert.throws(() => adapter.parseOwnRequests(parser(ownListHTML({ accountID: "Other" })), ORIGIN + "/my/assist-my", account), { code: "ACCOUNT_MISMATCH" });
  assert.throws(() => adapter.parseOwnRequests(parser(ownListHTML({ next: "/my/assist-my?page=3" })), ORIGIN + "/my/assist-my", account), { code: "INCOMPLETE_SEARCH" });
});

test("default submission follows verified lookup, minimum, precheck and real form contract", async () => {
  const harness = defaultHarness();
  const result = await harness.client.submitRequest({ doi: DOI, points: 20 });
  assert.equal(result.requestID, "Created1");
  assert.deepEqual(harness.calls.filter(call => call.method === "POST").map(call => new URL(call.url).pathname), ["/assist/onekey-query", "/assist/query-lowest-point", "/assist/check-before-assist-create", "/assist/create"]);
  assert.equal(harness.store.values.get("Account1:" + DOI).state, "confirmed");
});

test("default submission polls queued metadata lookup without retrying publication", async () => {
  const harness = defaultHarness({ queued: true });
  assert.equal((await harness.client.submitRequest({ doi: DOI, points: 20 })).requestID, "Created1");
  assert.equal(harness.calls.filter(call => new URL(call.url).pathname === "/assist/paper-lookup-status").length, 2);
  assert.equal(harness.calls.filter(call => call.method === "POST" && new URL(call.url).pathname === "/assist/create").length, 1);
});

test("default contract stops mismatched metadata, live higher minimum and site confirmation prompts", async () => {
  for (const [options, code] of [[{ metadata: { doi: "10.9999/wrong" } }, "DOI_MISMATCH"], [{ metadata: { min_point: 30 } }, "POINTS_TOO_LOW"], [{ checkCode: 2 }, "REQUEST_REVIEW_REQUIRED"]]) {
    const harness = defaultHarness(options);
    await assert.rejects(harness.client.submitRequest({ doi: DOI, points: 20 }), { code });
    assert.equal(harness.calls.filter(call => call.method === "POST" && new URL(call.url).pathname === "/assist/create").length, 0);
    assert.equal(harness.store.values.size, 0);
  }
});

test("default contract cancels during metadata polling without claiming a publication intent", async () => {
  let cancelled = false;
  const harness = defaultHarness({ queued: true });
  const client = adapter.create({ request: harness.request, parseHTML: parser, model, intentStore: harness.store, delay: async () => { cancelled = true; } });
  await assert.rejects(client.submitRequest({ doi: DOI, points: 20, isCancelled: () => cancelled }), { name: "AbortError" });
  assert.equal(harness.store.values.size, 0);
  assert.equal(harness.calls.filter(call => new URL(call.url).pathname === "/assist/paper-lookup-status").length, 0);
});

function downloadPageHTML({ fileID = "File1", channel = "highspeed", host = "filehub2.ablesci.com", servers = [{ id: "2", name: "线路1" }], defaultServerId = "2", expectedSize = 1000, highspeedAvailable = true } = {}) {
  const config = { tokenUrl: "/file/request-download-token", hashid: fileID, userId: "12345", defaultServerId, defaultChannel: channel, expectedSize, allowedNodeHosts: [host, ...servers.slice(1).map(server => `filehub${server.id}.ablesci.com`), "filehub11vip.ablesci.com"], normalServers: servers };
  return `${modernAccountHTML()}<meta name="csrf-param" content="_csrf"><meta name="csrf-token" content="fixture-download-token"><div class="download-progress-page" data-download-blob-check="chunked-v1"><div class="download-progress-file-name">000448372.pdf</div><p>普通下载线路始终保持免积分（免费）。</p>${servers.map(server => `<button class="download-progress-normal-button" data-server-id="${server.id}">${server.name}</button>`).join("")}${highspeedAvailable ? '<button id="download-highspeed-direct">高速通道</button>' : ""}</div><script>const config = ${JSON.stringify(config)};</script>`;
}
function downloadHarness({ data = {}, pageOptions = {} } = {}) {
  const calls = [];
  const request = async spec => {
    calls.push(spec);
    const path = new URL(spec.url).pathname;
    if (path === "/my/assist-my") return response(spec.url, ownListHTML());
    if (path === "/assist/detail") return response(spec.url, detailHTML().replace("/fixture-file?file=File1", "/assist/download?id=File1"));
    if (path === "/assist/download") return response(spec.url, downloadPageHTML(pageOptions));
    if (path === "/file/request-download-token") {
      assert.equal(spec.method, "POST");
      const form = new URLSearchParams(spec.body);
      assert.deepEqual(Object.fromEntries(form), { type: "assistFile", id: "File1", channel: "normal", highspeed: "0", fallback: "0", file_server: "2", remove_sensitive: "1", _csrf: "fixture-download-token" });
      return response(spec.url, JSON.stringify({ code: 0, data: { host: "https://filehub2.ablesci.com/download", token: "fixture-short-lived-token", output_filename: "000448372.pdf", channel: "normal", transport: "normal", expected_size: 900, ...data } }));
    }
    throw new Error("unexpected download route: " + path);
  };
  return { calls, client: adapter.create({ request, parseHTML: parser, model }) };
}

test("default download always explicitly requests a normal token despite high-speed page preference", async () => {
  const harness = downloadHarness();
  const result = await harness.client.getDownload("Request1", "File1");
  assert.equal(result.costPoints, 0);
  assert.equal(result.resolved, true);
  assert.equal(result.expectedSize, 900);
  assert.equal(result.url, "https://filehub2.ablesci.com/download?token=fixture-short-lived-token");
  assert.equal(harness.calls.filter(call => call.method === "POST").length, 1);
  assert.equal(harness.calls.some(call => new URL(call.url).hostname.startsWith("filehub")), false, "adapter must not download or persist token-bearing bytes");
});

test("default download rejects wrong files, paid transport and non-allowlisted nodes", async () => {
  for (const [options, code] of [[{ pageOptions: { fileID: "OtherFile" } }, "STRUCTURE_CHANGED"], [{ data: { channel: "highspeed", transport: "vip" } }, "INVALID_DOWNLOAD_RESPONSE"], [{ data: { host: "https://evil.example/download" } }, "INVALID_DOWNLOAD_URL"], [{ pageOptions: { host: "evil.example" } }, "STRUCTURE_CHANGED"]]) {
    const harness = downloadHarness(options);
    await assert.rejects(harness.client.getDownload("Request1", "File1"), { code });
  }
});

function messagePageHTML() {
  return `${modernAccountHTML()}<div class="user-message-page"><table class="layui-table"><tbody><tr id="Message1" class="message-item message-noread"><td><input name="messageID" value="Message1"></td><td class="message-time">2030-01-01 12:00:00</td><td><a class="message-link">您的求助已有应助者上传了文件（id=File1）<span class="message-badge-noread">未读</span></a><blockquote class="message-content"></blockquote></td></tr><tr id="Message2" class="message-item message-readed"><td><input name="messageID" value="Message2"></td><td class="message-time">2030-01-01 10:00:00</td><td><a class="message-link">您的求助已完成（id=Request1）</a></td></tr></tbody></table></div>`;
}

test("default messages read server-rendered summaries without marking unread messages or confusing file IDs", async () => {
  const calls = [];
  const client = adapter.create({ model, parseHTML: parser, request: async spec => {
    calls.push(spec);
    return response(spec.url, new URL(spec.url).pathname === "/my/assist-my" ? ownListHTML() : messagePageHTML());
  } });
  const messages = await client.listMessages();
  assert.equal(messages.length, 2);
  assert.equal(messages[0].read, false);
  assert.equal(messages[0].title.endsWith("未读"), false);
  assert.equal(messages[0].requestID, null);
  assert.equal(messages[0].url, ORIGIN + "/my/message#Message1");
  assert.equal(messages[1].read, true);
  assert.ok(calls.every(call => call.method === "GET"));
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), ["/my/assist-my", "/my/message"]);
});

test("batch lookup caches only DOI metadata, merges identical reads and expires quickly", async () => {
  const calls = [];
  let clock = 1000;
  const request = async spec => {
    calls.push(spec);
    const path = new URL(spec.url).pathname;
    if (path === "/my/assist-my") return response(spec.url, ownListHTML({ ids: ["Old1", "Old2"] }));
    return response(spec.url, detailHTML({ id: new URL(spec.url).searchParams.get("id"), doi: "10.9999/old" }));
  };
  const client = adapter.create({ request, parseHTML: parser, model, now: () => clock });
  assert.deepEqual(await Promise.all([client.findExistingRequest(DOI), client.findExistingRequest("10.9999/new")]), [null, null]);
  assert.equal(calls.filter(call => new URL(call.url).pathname === "/my/assist-my").length, 1);
  assert.equal(calls.filter(call => new URL(call.url).pathname === "/assist/detail").length, 2);
  await client.findExistingRequest(DOI);
  assert.equal(calls.filter(call => new URL(call.url).pathname === "/assist/detail").length, 2);
  clock += 20001;
  await client.findExistingRequest(DOI);
  assert.equal(calls.filter(call => new URL(call.url).pathname === "/assist/detail").length, 4);
  await client.getRequest("Old1");
  await client.getRequest("Old1");
  assert.equal(calls.filter(call => new URL(call.url).pathname === "/assist/detail").length, 6, "direct details and download inputs are always refreshed");
});

test("lookup cache invalidates on account change, sign-out and changed first-page rows", async () => {
  const calls = [];
  let accountID = "Account1", ids = ["Old1"];
  const request = async spec => {
    calls.push(spec);
    if (new URL(spec.url).pathname === "/my/assist-my") return response(spec.url, accountID ? ownListHTML({ ids, accountID }) : '<ul class="able-head-user-guest"></ul>');
    return response(spec.url, detailHTML({ id: new URL(spec.url).searchParams.get("id"), owner: accountID, doi: "10.9999/old" }));
  };
  const client = adapter.create({ request, parseHTML: parser, model });
  const details = () => calls.filter(call => new URL(call.url).pathname === "/assist/detail").length;
  await client.findExistingRequest(DOI); assert.equal(details(), 1);
  accountID = "Account2";
  await client.findExistingRequest(DOI); assert.equal(details(), 2);
  accountID = null;
  assert.equal((await client.getAccount()).authenticated, false);
  accountID = "Account2";
  await client.findExistingRequest(DOI); assert.equal(details(), 3);
  ids = ["New1", "Old1"];
  await client.findExistingRequest(DOI); assert.equal(details(), 5);
});

test("successful publication invalidates cached own-request metadata", async () => {
  const harness = defaultHarness({ ownIDs: ["Old1"] });
  let oldReads = 0;
  const request = async spec => {
    if (new URL(spec.url).pathname === "/assist/detail" && new URL(spec.url).searchParams.get("id") === "Old1") {
      oldReads++;
      return response(spec.url, detailHTML({ id: "Old1", doi: "10.9999/old" }));
    }
    return harness.request(spec);
  };
  const client = adapter.create({ request, parseHTML: parser, model, intentStore: harness.store });
  await client.findExistingRequest(DOI);
  assert.equal(oldReads, 1);
  await client.submitRequest({ doi: DOI, points: 20 });
  assert.equal(oldReads, 1, "same short preflight window reuses DOI-only metadata");
  await client.findExistingRequest("10.9999/new");
  assert.equal(oldReads, 2);
});

test("an explicit server rejection can safely retry after restart but never automatically retries", async () => {
  const harness = defaultHarness();
  const rejectingRequest = async spec => {
    const value = await harness.request(spec);
    return spec.method === "POST" && new URL(spec.url).pathname === "/assist/create"
      ? response(spec.url, JSON.stringify({ code: 1, msg: "Fixture form rejection" })) : value;
  };
  const rejected = adapter.create({ request: rejectingRequest, parseHTML: parser, model, intentStore: harness.store });
  await assert.rejects(rejected.submitRequest({ doi: DOI, points: 20 }), { code: "REQUEST_REJECTED", reconcileRequired: false });
  assert.equal(harness.store.values.get("Account1:" + DOI).state, "rejected");
  const publications = () => harness.calls.filter(call => call.method === "POST" && new URL(call.url).pathname === "/assist/create");
  assert.equal(publications().length, 1);
  const restarted = adapter.create({ request: harness.request, parseHTML: parser, model, intentStore: harness.store });
  assert.equal((await restarted.submitRequest({ doi: DOI, points: 20 })).requestID, "Created1");
  assert.equal(publications().length, 2);
  assert.equal(harness.store.values.get("Account1:" + DOI).state, "confirmed");
});

test("a retry after rejection still reconciles a request that became visible meanwhile", async () => {
  const harness = submissionHarness({ existing: ["Existing1"] });
  harness.store.values.set("Account1:" + DOI, { accountID: "Account1", doi: DOI, points: 20, state: "rejected" });
  const result = await harness.client.submitRequest({ doi: DOI, points: 30 });
  assert.equal(result.requestID, "Existing1");
  assert.equal(result.reused, true);
  assert.equal(harness.calls.filter(call => call.method === "POST").length, 0);
  assert.equal(harness.store.values.get("Account1:" + DOI).state, "confirmed");
});

function downloadSettingsHTML({ free = true, accountID = "Account1", currentNoticeOutsideForm = false } = {}) {
  const notice = '<div><span>注</span>：本设置将对您不起作用，因为您当前的积分≥500，享有免积分高速下载权益，系统会自动使用高速模式。</div>';
  return `${modernAccountHTML(accountID)}<form id="post-form" method="post"><input type="radio" name="file_highspeed" value="1"><input type="radio" name="file_highspeed" value="0" checked>${free && !currentNoticeOutsideForm ? notice : ""}</form>${currentNoticeOutsideForm ? notice : ""}<p>用户积分≥500：不扣积分，享有免积分高速下载权益。用户积分＜500：每个文件高速下载扣除2积分。</p>`;
}

function freeDownloadHarness({ free = true, settingsAccount = "Account1", tokenData = {}, pageOptions = {}, settingsFailure = null, onSettings = null } = {}) {
  const calls = [], state = { free, settingsAccount, tokenData, settingsFailure }, servers = [{ id: "2", name: "线路1" }, { id: "3", name: "线路2" }, { id: "4", name: "线路3" }];
  const request = async spec => {
    calls.push(spec);
    const path = new URL(spec.url).pathname;
    if (path === "/my/assist-my") return response(spec.url, ownListHTML());
    if (path === "/assist/detail") return response(spec.url, detailHTML().replace("/fixture-file?file=File1", "/assist/download?id=File1"));
    if (path === "/assist/download") return response(spec.url, downloadPageHTML({ servers, defaultServerId: "3", ...pageOptions }));
    if (path === "/my/assist-my-set") {
      if (onSettings) onSettings();
      if (state.settingsFailure === "network") throw new Error("fixture temporary network failure");
      if (state.settingsFailure === "login") return response(ORIGIN + "/site/login", '<div class="able-head-user-guest"></div>');
      return response(spec.url, state.settingsFailure === "structure" ? modernAccountHTML() : downloadSettingsHTML({ free: state.free, accountID: state.settingsAccount }));
    }
    assert.equal(path, "/file/request-download-token");assert.equal(spec.method, "POST");
    const form = new URLSearchParams(spec.body), channel = form.get("channel"), fallback = form.get("fallback") === "1", transport = channel === "normal" ? "normal" : fallback ? "cdn" : "vip";
    assert.equal(form.get("highspeed"), channel === "normal" ? "0" : "1");assert.equal(form.get("type"), "assistFile");assert.equal(form.get("id"), "File1");assert.equal(form.get("remove_sensitive"), "1");
    if (channel === "highspeed") assert.equal(form.get("file_server"), "0");
    return response(spec.url, JSON.stringify({ code: 0, data: { host: transport === "cdn" ? "/file/download" : `https://filehub${transport === "normal" ? form.get("file_server") : "11vip"}.ablesci.com/download`, channel, transport, token: "fixture-short-lived-token", output_filename: "000448372.pdf", expected_size: pageOptions.expectedSize || 1000, ...state.tokenData } }));
  };
  return { calls, state, client: adapter.create({ request, parseHTML: parser, model }), tokens() { return calls.filter(call => call.method === "POST").map(call => Object.fromEntries(new URLSearchParams(call.body))); } };
}

test("free-highspeed parser requires the current account notice, not generic rules, VIP icons or the smart setting", () => {
  const account = { accountID: "Account1", points: null };
  assert.equal(adapter.parseDownloadSettings(parser(downloadSettingsHTML()), ORIGIN + adapter.PATHS.downloadSettings, account).freeHighspeed, true);
  assert.equal(adapter.parseDownloadSettings(parser(downloadSettingsHTML({ free: false })), ORIGIN + adapter.PATHS.downloadSettings, account).freeHighspeed, false);
  assert.equal(adapter.parseDownloadSettings(parser(downloadSettingsHTML({ currentNoticeOutsideForm: true })), ORIGIN + adapter.PATHS.downloadSettings, account).freeHighspeed, false);
  assert.equal(adapter.parseDownloadSettings(parser(downloadSettingsHTML()), ORIGIN + adapter.PATHS.downloadSettings, { ...account, points: 499 }).freeHighspeed, false);
  assert.throws(() => adapter.parseDownloadSettings(parser(downloadSettingsHTML({ accountID: "OtherAccount" })), ORIGIN + adapter.PATHS.downloadSettings, account), { code: "ACCOUNT_MISMATCH" });
});

test("auto-free verifies live entitlement on every call and drops to ordinary download if entitlement is lost", async () => {
  const harness = freeDownloadHarness();
  const fast = await harness.client.getDownload("Request1", "File1", { route: "auto-free" });
  assert.equal(fast.route, "highspeed");assert.equal(fast.transport, "vip");assert.equal(fast.costPoints, 0);assert.equal(fast.canFallback, true);assert.equal(fast.entitlement, "current-account-free-highspeed");assert.equal(fast.timeoutMs, 180000);assert.equal(fast.retryable, true);
  assert.deepEqual(harness.tokens()[0], { type: "assistFile", id: "File1", channel: "highspeed", highspeed: "1", fallback: "0", file_server: "0", remove_sensitive: "1", _csrf: "fixture-download-token" });
  harness.state.free = false;
  const normal = await harness.client.getDownload("Request1", "File1", { route: "auto-free" });
  assert.equal(normal.route, "normal");assert.equal(normal.transport, "normal");assert.equal(normal.serverID, "3");assert.equal(normal.canFallback, false);assert.equal(harness.tokens()[1].channel, "normal");
  assert.equal(harness.calls.filter(call => new URL(call.url).pathname === adapter.PATHS.downloadSettings).length, 2);
  assert.ok(harness.calls.every(call => call.method !== "POST" || new URL(call.url).pathname === "/file/request-download-token"));
});

test("unverified or unavailable high-speed rights use a free ordinary token without purchasing or changing settings", async () => {
  for (const options of [{ free: false }, { settingsFailure: "network" }, { settingsFailure: "structure" }, { pageOptions: { highspeedAvailable: false } }]) {
    const harness = freeDownloadHarness(options), descriptor = await harness.client.getDownload("Request1", "File1", { route: "auto-free" });
    assert.equal(descriptor.route, "normal");assert.equal(harness.tokens().length, 1);assert.equal(harness.tokens()[0].highspeed, "0");assert.equal(harness.tokens()[0].fallback, "0");
  }
});

test("account mismatch or login expiry during entitlement verification never requests a token", async () => {
  for (const [options, code] of [[{ settingsAccount: "OtherAccount" }, "ACCOUNT_MISMATCH"], [{ settingsFailure: "login" }, "LOGIN_REQUIRED"]]) {
    const harness = freeDownloadHarness(options);await assert.rejects(harness.client.getDownload("Request1", "File1", { route: "auto-free" }), { code });assert.equal(harness.tokens().length, 0);
  }
});

test("free VIP fallback explicitly requests the CDN route and returns a bounded redirect policy", async () => {
  const harness = freeDownloadHarness(), result = await harness.client.getDownload("Request1", "File1", { route: "auto-free", fallback: true });
  assert.equal(harness.tokens()[0].fallback, "1");assert.equal(result.route, "highspeed");assert.equal(result.transport, "cdn");assert.equal(result.canFallback, false);assert.equal(new URL(result.url).pathname, "/file/download");assert.deepEqual(result.allowedOrigins, [ORIGIN]);assert.equal(result.allowedRedirectDomain, "ablesci.com");
  for (const tokenData of [{ transport: "vip" }, { host: "https://evil.example/file/download" }, { host: "/my/point-donate" }]) {
    const invalid = freeDownloadHarness({ tokenData });await assert.rejects(invalid.client.getDownload("Request1", "File1", { route: "auto-free", fallback: true }));
  }
});

test("ordinary retries select observed alternate servers and reject exhausted routes before requesting another token", async () => {
  const harness = freeDownloadHarness();
  for (const [normalServerIndex, serverID] of [[0, "3"], [1, "2"], [2, "4"]]) {
    const result = await harness.client.getDownload("Request1", "File1", { route: "normal", normalServerIndex });
    assert.equal(result.route, "normal");assert.equal(result.serverID, serverID);assert.equal(result.normalServerIndex, normalServerIndex);assert.equal(result.normalServerCount, 3);assert.equal(result.allowedRedirectDomain, undefined);
  }
  await assert.rejects(harness.client.getDownload("Request1", "File1", { route: "normal", normalServerIndex: 3 }), { code: "DOWNLOAD_NOT_AVAILABLE" });
  assert.equal(harness.tokens().length, 3);assert.equal(harness.calls.some(call => new URL(call.url).pathname === adapter.PATHS.downloadSettings), false);
});

test("cancellation during the entitlement read prevents both high-speed and ordinary token requests", async () => {
  let cancelled = false;const harness = freeDownloadHarness({ onSettings() { cancelled = true; } });
  await assert.rejects(harness.client.getDownload("Request1", "File1", { route: "auto-free", isCancelled: () => cancelled }), { name: "AbortError" });assert.equal(harness.tokens().length, 0);
});

test("download route validation is local and larger files receive a capped timeout budget", async () => {
  const harness = freeDownloadHarness({ pageOptions: { expectedSize: 100 * 1024 * 1024 } });
  for (const options of [{ route: "paid" }, { route: "normal", fallback: true }, { normalServerIndex: -1 }, { normalServerIndex: 0.5 }, { isCancelled: true }]) await assert.rejects(harness.client.getDownload("Request1", "File1", options), { code: "INVALID_DOWNLOAD_OPTIONS" });
  assert.equal(harness.calls.length, 0);const result = await harness.client.getDownload("Request1", "File1");assert.equal(result.timeoutMs, 600000);assert.equal(result.route, "normal");
});

test("high-speed tokens with an unexpected node, route or explicit extra cost are rejected", async () => {
  for (const tokenData of [{ host: "https://filehub999vip.ablesci.com/download" }, { host: "https://filehub11vip.ablesci.com:8443/download" }, { channel: "normal", transport: "normal" }, { charged_points: 2 }]) {
    const harness = freeDownloadHarness({ tokenData });await assert.rejects(harness.client.getDownload("Request1", "File1", { route: "auto-free" }));
  }
});
