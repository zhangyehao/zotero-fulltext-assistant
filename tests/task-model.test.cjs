"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const model = require("../src/task-model.js");
const T0 = "2026-11-04T03:00:00.000Z";
const T1 = "2026-11-04T03:02:00.000Z";
const requestURL = "https://www.ablesci.com/assist/detail?id=AbC123";
const input = { libraryID: 1, itemKey: "ABCD1234", itemID: 42, doi: "10.1038/NN.4346", title: "Example paper" };
function task(overrides = {}, id = "task-1") {
  return model.createTask({ ...input, ...overrides }, { now: () => T0, id: () => id });
}
const T2 = "2026-11-04T03:04:00.000Z";
function receipt(overrides = {}) {
  return { requestID: "AbC123", fileID: "File987", accountID: "Account42", attachmentID: 81,
    sha256: "ab".repeat(32), doi: "10.1038/nn.4346", title: "Example paper", verifiedBy: "doi", verifiedAt: T0,
    adoption: "pending", messages: "pending", needsReconcile: false, attempts: 0, nextCheckAt: null, lastError: "", acceptedAt: null, readAt: null, ...overrides };
}
function receivedTask(overrides = {}) {
  return task({ requestURL, state: "imported", source: "ablesci", attachmentID: 81, assistReceipt: receipt(), ...overrides });
}

test("verified assistance receipts persist without inventing evidence for legacy imported history", () => {
  const current=receivedTask();assert.deepEqual(current.assistReceipt,receipt());
  const restored=model.deserializeQueue(model.serializeQueue([current])).tasks[0];assert.deepEqual(restored,current);
  assert.notEqual(restored.assistReceipt,current.assistReceipt);
  const legacy={...current};delete legacy.assistReceipt;
  assert.equal(model.sanitizeTask(legacy).assistReceipt,null);
  assert.equal(model.deserializeQueue(model.serializeQueue([legacy])).tasks[0].assistReceipt,null);
  assert.equal(task().assistReceipt,null);
});

test("a fresh receipt can be committed atomically with its imported attachment", () => {
  const pending=task({requestURL,state:"downloading"});
  const imported=model.updateTask(pending,{state:"imported",source:"ablesci",attachmentID:81,assistReceipt:receipt()},{now:T1});
  assert.deepEqual(imported.assistReceipt,receipt());assert.equal(pending.assistReceipt,null);
});

test("receipt adoption and message progress can resume independently without changing completed history", () => {
  const imported=receivedTask();
  const failed=model.updateTask(imported,{assistReceipt:{...imported.assistReceipt,attempts:1,nextCheckAt:T2,lastError:"network unavailable"}},{now:T1});
  const saved=model.deserializeQueue(model.serializeQueue([failed])).tasks[0];
  assert.equal(saved.state,"imported");assert.equal(saved.attachmentID,81);assert.equal(saved.completedAt,T0);assert.equal(saved.assistReceipt.adoption,"pending");assert.equal(saved.assistReceipt.attempts,1);
  const accepted=model.updateTask(saved,{assistReceipt:{...saved.assistReceipt,adoption:"accepted",acceptedAt:T1,nextCheckAt:T2}},{now:T1});
  assert.equal(accepted.assistReceipt.messages,"pending");assert.equal(accepted.assistReceipt.acceptedAt,T1);
  const done=model.updateTask(accepted,{assistReceipt:{...accepted.assistReceipt,messages:"done",readAt:T2,lastError:"",nextCheckAt:null}},{now:T2});
  assert.equal(done.assistReceipt.adoption,"accepted");assert.equal(done.assistReceipt.messages,"done");assert.equal(done.assistReceipt.readAt,T2);assert.equal(done.completedAt,T0);
});

test("invalid receipt identities and digests discard only receipt evidence", () => {
  const malformed=[null,[],"invalid",{},receipt({requestID:"Other"}),receipt({attachmentID:82}),receipt({attachmentID:0}),receipt({attachmentID:1.5}),receipt({doi:"10.1234/other"}),receipt({doi:"not a doi"}),receipt({sha256:"a".repeat(63)}),receipt({sha256:"g".repeat(64)})];
  for(const name of ["requestID","fileID","accountID"])for(const value of [""," ","a_b","x/1","a".repeat(129),42])malformed.push(receipt({[name]:value}));
  for(const value of malformed){const normalized=receivedTask({assistReceipt:value});assert.equal(normalized.assistReceipt,null);assert.equal(normalized.id,"task-1");assert.equal(normalized.state,"imported");assert.equal(normalized.attachmentID,81);assert.equal(model.deserializeQueue(model.serializeQueue([normalized])).tasks.length,1);}
});

test("receipts require the exact imported AbleSci task and cannot migrate to other identity or attachments", () => {
  for(const patch of [{state:"available"},{source:"existing"},{requestURL:"https://www.ablesci.com/assist/detail?id=Other"},{attachmentID:null}])assert.equal(receivedTask(patch).assistReceipt,null);
  const current=receivedTask();
  for(const patch of [{libraryID:2},{itemID:43},{itemKey:"DIFF5678"},{doi:"10.1234/other"},{title:"Changed paper"},{attachmentID:82},{requestURL:"https://www.ablesci.com/assist/detail?id=Other"}]){
    assert.equal(model.updateTask(current,patch,{now:T1}).assistReceipt,null);
    assert.equal(model.updateTask(current,{...patch,assistReceipt:current.assistReceipt},{now:T1}).assistReceipt,null);
  }
  assert.deepEqual(model.updateTask(current,{lastError:"",requestedPoints:30},{now:T1}).assistReceipt,current.assistReceipt);
  assert.deepEqual(model.updateTask(current,{doi:"https://doi.org/10.1038/NN.4346"},{now:T1}).assistReceipt,current.assistReceipt);
});

test("receipt proof methods, action states and retry counts are restricted", () => {
  for(const verifiedBy of ["doi","title","manual"])assert.equal(receivedTask({assistReceipt:receipt({verifiedBy})}).assistReceipt.verifiedBy,verifiedBy);
  for(const patch of [{verifiedBy:"automatic"},{adoption:"sending"},{adoption:""},{messages:"read"},{attempts:-1},{attempts:1.5},{attempts:NaN},{attempts:"1"},{attempts:null},{verifiedBy:"title",title:""}])assert.equal(receivedTask({assistReceipt:receipt(patch)}).assistReceipt,null);
  assert.equal(receivedTask({doi:"",assistReceipt:receipt({doi:"",verifiedBy:"doi"})}).assistReceipt,null);
  assert.equal(receivedTask({doi:"",assistReceipt:receipt({doi:"",verifiedBy:"title"})}).assistReceipt.verifiedBy,"title");
  assert.equal(receivedTask({assistReceipt:receipt({attempts:undefined})}).assistReceipt.attempts,0);
});

test("receipt dates must describe verification before adoption and adoption before completed message handling", () => {
  const prior="2026-11-04T02:59:00.000Z";
  const invalid=[{verifiedAt:null},{verifiedAt:"yesterday"},{nextCheckAt:prior},{acceptedAt:T1},{readAt:T1},{adoption:"accepted"},{adoption:"accepted",acceptedAt:prior},{messages:"done"},{adoption:"accepted",acceptedAt:T1,messages:"done"},{adoption:"accepted",acceptedAt:T1,messages:"done",readAt:T0},{adoption:"accepted",acceptedAt:T1,messages:"pending",readAt:T2}];
  for(const patch of invalid)assert.equal(receivedTask({assistReceipt:receipt(patch)}).assistReceipt,null,JSON.stringify(patch));
  const same=receivedTask({assistReceipt:receipt({adoption:"accepted",acceptedAt:T0,messages:"done",readAt:T0})});assert(same.assistReceipt);
});

test("receipt normalization uses a strict allowlist and redacts persisted error credentials", () => {
  const raw=receipt({sha256:"AB".repeat(32),doi:"https://doi.org/10.1038/NN.4346",title:"x".repeat(2200),lastError:"Authorization: Bearer private-receipt-secret",cookie:"private-cookie",downloadURL:"https://server.test/?token=private-token"});
  const current=receivedTask({assistReceipt:raw}),saved=model.serializeQueue([current]);
  assert.equal(current.assistReceipt.sha256,"ab".repeat(32));assert.equal(current.assistReceipt.doi,"10.1038/nn.4346");assert.equal(current.assistReceipt.title.length,2000);assert.equal(saved.includes("private-"),false);
  assert.equal(Object.hasOwn(current.assistReceipt,"downloadURL"),false);assert.equal(Object.hasOwn(current.assistReceipt,"cookie"),false);raw.fileID="Changed";assert.equal(current.assistReceipt.fileID,"File987");
});

test("a persisted uncertain adoption requires reconciliation until acceptance is verified", () => {
  const pending=receivedTask({assistReceipt:receipt({needsReconcile:true})});
  assert.equal(model.deserializeQueue(model.serializeQueue([pending])).tasks[0].assistReceipt.needsReconcile,true);
  const accepted=model.updateTask(pending,{assistReceipt:{...pending.assistReceipt,adoption:"accepted",acceptedAt:T1}},{now:T1});
  assert.equal(accepted.assistReceipt.needsReconcile,false);
  assert.equal(receivedTask({assistReceipt:receipt({needsReconcile:undefined})}).assistReceipt.needsReconcile,false);
  assert.equal(receivedTask({assistReceipt:receipt({needsReconcile:"true"})}).assistReceipt,null);
});

function review(overrides={}) {
  return {requestID:"AbC123",fileID:"File987",accountID:"Account42",sha256:"ab".repeat(32),doi:"10.1038/nn.4346",title:"Example paper",createdAt:T0,...overrides};
}
function reviewedTask(overrides={}) {
  return task({requestURL,state:"manual_review",assistReview:review(),...overrides});
}

test("unknown assistance PDF review evidence persists without a path or an imported receipt", () => {
  const current=reviewedTask({assistReview:review({path:"C:\\private\\review.pdf",downloadURL:"https://private.test/?token=secret",sha256:"AB".repeat(32)})});
  const restored=model.deserializeQueue(model.serializeQueue([current])).tasks[0];
  assert.deepEqual(restored.assistReview,review());assert.equal(restored.assistReceipt,null);assert.equal(restored.attachmentID,null);assert.equal(restored.state,"manual_review");
  assert.equal(Object.hasOwn(restored.assistReview,"path"),false);assert.equal(Object.hasOwn(restored.assistReview,"downloadURL"),false);
  assert.equal(reviewedTask({source:"browser_download"}).assistReview.fileID,"File987","review evidence does not require an import source");
  const legacy={...current};delete legacy.assistReview;assert.equal(model.sanitizeTask(legacy).assistReview,null);assert.equal(task().assistReview,null);
});

test("malformed or mismatched review evidence is stripped without discarding history", () => {
  const invalid=[null,[],{},"bad",review({requestID:"Other"}),review({fileID:"bad-id"}),review({accountID:"a".repeat(129)}),review({sha256:"a"}),review({doi:"10.1234/other"}),review({doi:"broken"}),review({createdAt:null}),review({createdAt:"2026-11-04"})];
  for(const assistReview of invalid){const current=reviewedTask({assistReview});assert.equal(current.assistReview,null);assert.equal(current.id,"task-1");assert.equal(current.state,"manual_review");assert.equal(model.deserializeQueue(model.serializeQueue([current])).tasks.length,1);}
  for(const patch of [{state:"paused"},{state:"imported"},{attachmentID:81},{attachmentID:0},{requestURL:"https://www.ablesci.com/assist/detail?id=Other"}])assert.equal(reviewedTask(patch).assistReview,null);
});

test("changing a reviewed task identity discards both evidence objects even if a patch reuses them", () => {
  const current=reviewedTask();
  for(const patch of [{libraryID:2},{itemID:43},{itemKey:"DIFF5678"},{doi:"10.1234/other"},{title:"Changed paper"},{requestURL:"https://www.ablesci.com/assist/detail?id=Other"}]){
    const updated=model.updateTask(current,{...patch,assistReview:current.assistReview},{now:T1});assert.equal(updated.assistReview,null);assert.equal(updated.assistReceipt,null);
  }
  assert.deepEqual(model.updateTask(current,{lastError:"Please inspect the PDF"},{now:T1}).assistReview,current.assistReview);
});

test("manual confirmation atomically replaces the explicit review with a verified receipt", () => {
  const current=reviewedTask(),patch={state:"imported",source:"ablesci",attachmentID:81,assistReceipt:receipt({verifiedBy:"manual",verifiedAt:T1}),assistReview:null};
  const accepted=model.updateTask(current,patch,{now:T1});
  assert.equal(accepted.assistReview,null);assert.deepEqual(accepted.assistReceipt,patch.assistReceipt);assert.equal(current.assistReceipt,null);assert(current.assistReview);
  const implicit={...patch};delete implicit.assistReview;assert.equal(model.updateTask(current,implicit,{now:T1}).assistReceipt,null);
  const moved=model.updateTask(current,{...patch,itemID:43},{now:T1});assert.equal(moved.assistReceipt,null);assert.equal(moved.assistReview,null);
});

test("completion date and known download route persist without changing on later updates", () => {
  const pending=task({state:"waiting"}),done=model.updateTask(pending,{state:"imported",downloadRoute:"highspeed"},{now:()=>T1});
  assert.equal(done.completedAt,T1);
  const later=model.updateTask(done,{lastError:""},{now:()=>"2026-11-05T00:00:00.000Z"});
  const restored=model.deserializeQueue(model.serializeQueue([later])).tasks[0];
  assert.equal(restored.completedAt,T1);assert.equal(restored.downloadRoute,"highspeed");
  const legacy={...done};delete legacy.completedAt;assert.equal(model.sanitizeTask(legacy).completedAt,T1);
  assert.equal(model.sanitizeTask({...legacy,downloadRoute:"https://private.test/?token=secret"}).downloadRoute,"");
});

test("point settings accept only integers from 1 through 10000 without loose coercion", () => {
  assert.equal(model.DEFAULT_POINTS, 10);
  for (const value of [1, 10, 20, 10000, "1", "20", "10000", " 20 "]) {
    assert.equal(model.validatePoints(value), Number(value));
  }
  for (const value of [0, -1, 10001, 1.5, NaN, Infinity, "", " ", "0", "01", "20.0", "1e2", "0x14", "+20", "20 points", null, undefined, false, true, [], {}]) {
    assert.throws(() => model.validatePoints(value), /Points must be an integer/);
  }
});

test("task points are snapshots and survive configuration changes, deduplication and persistence", () => {
  const settings = { points: 20 };
  const original = task({ requestedPoints: settings.points, requestURL, state: "waiting" });
  settings.points = 30;
  assert.equal(original.requestedPoints, 20);
  const duplicate = model.addTask([original], { ...input, requestURL, requestedPoints: settings.points }, { now: T1, id: "duplicate" });
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.task.requestedPoints, 20);
  assert.equal(model.updateTask(original, { state: "available" }, { now: T1 }).requestedPoints, 20);
  assert.equal(model.deserializeQueue(model.serializeQueue([original])).tasks[0].requestedPoints, 20);
  assert.equal(task().requestedPoints, 10);
  const legacy = { ...original };
  delete legacy.requestedPoints;
  assert.equal(model.sanitizeTask(legacy).requestedPoints, 10);
  assert.equal(model.updateTask(original, { requestedPoints: 30 }, { now: T1 }).requestedPoints, 30);
  assert.equal(original.requestedPoints, 20);
  assert.equal(model.sanitizeTask({ ...original, requestedPoints: "" }), null);
});

test("DOI normalization accepts whole DOI values and canonical DOI URLs", () => {
  assert.equal(model.normalizeDOI("  DOI: 10.1038/NN.4346 \n"), "10.1038/nn.4346");
  assert.equal(model.normalizeDOI("https://doi.org/10.1000%2FABC(1)"), "10.1000/abc(1)");
  assert.equal(model.normalizeDOI("http://dx.doi.org/10.1000/ABC"), "10.1000/abc");
  assert.equal(model.normalizeDOI(null), "");
  assert.equal(model.normalizeDOI(" \n "), "");
});

test("DOI normalization does not extract identifiers from prose or unrelated URLs", () => {
  for (const value of ["See 10.1038/nn.4346", "10.1038/nn.4346 and text", "10.1038/ nn.4346", "https://example.com/10.1038/nn.4346", "https://doi.org.evil.test/10.1038/nn.4346", "https://doi.org/10.1038/nn.4346?token=secret", "https://user:secret@doi.org/10.1038/nn.4346", "10.1038/", 123]) {
    assert.throws(() => model.normalizeDOI(value), TypeError, String(value));
  }
});

test("AbleSci request URL is canonical and preserves case-sensitive request ID", () => {
  assert.deepEqual(model.parseRequestURL("  HTTPS://WWW.ABLESCI.COM/assist/detail?id=AbC123 \n"), {
    requestID: "AbC123", requestURL,
  });
});

test("request URL validator rejects credential-bearing, lookalike, extra-query and traversal URLs", () => {
  for (const value of [
    "http://www.ablesci.com/assist/detail?id=AbC123",
    "https://ablesci.com/assist/detail?id=AbC123",
    "https://www.ablesci.com.evil.test/assist/detail?id=AbC123",
    "https://user:secret@www.ablesci.com/assist/detail?id=AbC123",
    "https://www.ablesci.com:443/assist/detail?id=AbC123",
    "https://www.ablesci.com/assist/Detail?id=AbC123",
    "https://www.ablesci.com/x/../assist/detail?id=AbC123",
    "https://www.ablesci.com/assist/detail?id=AbC123&token=secret",
    "https://www.ablesci.com/assist/detail?id=AbC123&id=other",
    "https://www.ablesci.com/assist/detail?id=AbC123#fragment",
    "https://www.ablesci.com/assist/detail?id=%41bC123",
    "https://www.ablesci.com/assist/detail?id=AbC_123",
    "https://www.ablesci.com/assist/detail?id=",
    "javascript:alert(1)", null,
  ]) assert.throws(() => model.parseRequestURL(value), TypeError, String(value));
});

test("task construction is deterministic and permits manually tracking a request without a DOI", () => {
  const actual = task({ doi: "", requestURL });
  assert.equal(actual.id, "task-1");
  assert.equal(actual.doi, "");
  assert.equal(actual.requestID, "AbC123");
  assert.equal(actual.state, "pending_login");
  assert.equal(actual.createdAt, T0);
  assert.equal(actual.updatedAt, T0);
  assert.equal(actual.lastCheckedAt, null);
  assert.equal(actual.nextCheckAt, null);
  assert.equal(actual.schemaVersion, 1);
  assert.throws(() => model.createTask({ doi: "", requestURL: "" }, { now: T0, id: "empty" }), /required/);
});

test("a selected Zotero item without DOI is retained for review and can later bind a request", () => {
  const captured = task({ doi: "", requestURL: "" });
  assert.equal(captured.state, "needs_review");
  assert.equal(captured.itemKey, input.itemKey);
  assert.equal(captured.requestID, "");
  assert.deepEqual(model.deserializeQueue(model.serializeQueue([captured])).tasks, [captured]);
  const bound = model.updateTask(captured, { requestURL, state: "ready_to_check" }, { now: T1 });
  assert.equal(bound.requestID, "AbC123");
  assert.equal(bound.id, captured.id);
  assert.equal(bound.itemKey, captured.itemKey);
  assert.equal(bound.doi, "");
});

test("identity-only tasks require a positive item ID or a positive library ID plus item key", () => {
  const create = value => model.createTask(value, { now: T0, id: "identity" });
  assert.equal(create({ libraryID: 1, itemKey: "ABCD1234" }).state, "needs_review");
  assert.equal(create({ itemID: 42 }).state, "needs_review");
  for (const value of [{}, { libraryID: 1 }, { itemKey: "ABCD1234" }, { libraryID: 0, itemKey: "ABCD1234" }, { itemID: 0 }]) {
    assert.throws(() => create(value), /required/);
  }
  assert.equal(create({ itemID: 42, state: "paused" }).state, "paused");
});

test("missing DOI deduplication matches Zotero identity without merging unrelated or remote tasks", () => {
  const existing = task({ doi: "", state: "paused" });
  const add = overrides => model.addTask([existing], { ...input, doi: "", ...overrides }, { now: T1, id: "other" });
  const duplicate = add({});
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.task, existing);
  assert.equal(duplicate.task.state, "paused");
  assert.equal(add({ libraryID: 2, itemID: 43 }).added, true);
  assert.equal(add({ itemKey: "DIFF5678", itemID: 43 }).added, true);
  assert.equal(add({ requestURL }).added, true);
  const idOnly = model.createTask({ itemID: 42 }, { now: T0, id: "item-only" });
  assert.equal(model.addTask([idOnly], { itemID: 42 }, { now: T1, id: "other" }).added, false);
  assert.equal(model.addTask([idOnly], { itemID: 43 }, { now: T1, id: "other" }).added, true);
});

test("duplicate requests preserve the existing status, association and timestamps", () => {
  const existing = task({ requestURL, state: "waiting", lastCheckedAt: T1 });
  const queue = [existing];
  const result = model.addTask(queue, { ...input, itemKey: "DIFF5678", requestURL }, { now: T1, id: "task-2" });
  assert.equal(result.added, false);
  assert.equal(result.task, existing);
  assert.equal(result.tasks, queue);
  assert.equal(result.task.state, "waiting");
  assert.equal(result.task.itemKey, "ABCD1234");
  assert.equal(result.task.updatedAt, T0);
});

test("DOI deduplication respects library and item identity", () => {
  const existing = task();
  assert.equal(model.addTask([existing], { ...input, doi: "https://doi.org/10.1038/nn.4346" }, { now: T1, id: "other" }).added, false);
  assert.equal(model.addTask([existing], { ...input, libraryID: 2 }, { now: T1, id: "other" }).added, true);
  assert.equal(model.addTask([existing], { ...input, itemKey: "DIFF5678" }, { now: T1, id: "other" }).added, true);
  const remote = task({ requestURL });
  assert.equal(model.addTask([remote], { ...input, requestURL: "https://www.ablesci.com/assist/detail?id=Different" }, { now: T1, id: "other" }).added, true);
});

test("updates preserve immutable IDs and creation time and never move updatedAt backwards", () => {
  const original = task();
  const next = model.updateTask(original, { state: "waiting", requestURL, id: "replacement", createdAt: T1, lastCheckedAt: T1, nextCheckAt: "2026-11-04T03:04:00Z" }, { now: T1 });
  assert.equal(next.id, original.id);
  assert.equal(next.createdAt, T0);
  assert.equal(next.updatedAt, T1);
  assert.equal(next.requestID, "AbC123");
  assert.equal(next.nextCheckAt, "2026-11-04T03:04:00.000Z");
  assert.equal(original.state, "pending_login");
  assert.equal(model.updateTask(next, { state: "paused" }, { now: T0 }).updatedAt, T1);
});

test("unknown states, invalid timestamps and mismatched request identities cannot enter the model", () => {
  assert.throws(() => task({ state: "submitted" }), /Unknown task state/);
  assert.throws(() => task({ requestURL, requestID: "Wrong" }), /does not match/);
  assert.throws(() => task({ lastCheckedAt: "not-a-date" }), /timestamp/i);
  assert.throws(() => task({ lastCheckedAt: "1" }), /timestamp/i);
  assert.throws(() => task({ nextCheckAt: "2026-11-04T03:04:00" }), /timezone/);
  assert.throws(() => model.updateTask(task(), { state: "invented" }, { now: T1 }), /Unknown task state/);
  assert.equal(model.sanitizeTask({ ...task(), updatedAt: "2020-01-01T00:00:00Z" }), null);
});

test("persistence uses an allowlist, removes credential parameters, and retains configured task points", () => {
  const raw = {
    ...task(),
    cookie: "private-cookie",
    password: "private-password",
    token: "private-token",
    fixedPoints: 500,
    requestedPoints: 20,
    officialURL: "https://publisher.example/article?id=42&token=private-token#session-secret",
    lastError: "Request failed\nAuthorization: Bearer private-secret\ntoken=private-value",
  };
  const saved = model.serializeQueue({ schemaVersion: 1, tasks: [raw], auth: { password: "secret" } });
  assert.equal(model.DEFAULT_POINTS, 10);
  assert.throws(() => { model.DEFAULT_POINTS = 50; }, TypeError);
  assert.equal(saved.includes("private-"), false);
  assert.equal(saved.includes("session-secret"), false);
  const restored = model.deserializeQueue(saved);
  assert.equal(restored.tasks[0].officialURL, "https://publisher.example/article?id=42");
  assert.equal(Object.hasOwn(restored.tasks[0], "password"), false);
  assert.equal(Object.hasOwn(restored.tasks[0], "fixedPoints"), false);
  assert.equal(restored.tasks[0].requestedPoints, 20);
  assert.equal(Object.hasOwn(restored, "auth"), false);
  assert.deepEqual(model.deserializeQueue(model.serializeQueue(restored)), restored);
});

test("invalid persisted tasks are discarded, duplicate tasks are stable, and future schemas fail clearly", () => {
  const first = task({ requestURL, state: "waiting" });
  const duplicate = task({ requestURL, state: "error" }, "task-2");
  const queue = model.sanitizeQueue({ schemaVersion: 1, tasks: [first, duplicate, { ...first, id: "bad", requestURL: "https://evil.test/?id=AbC123" }, { ...first, id: "state", state: "unknown" }] });
  assert.equal(queue.tasks.length, 1);
  assert.equal(queue.tasks[0].state, "waiting");
  assert.throws(() => model.deserializeQueue('{"schemaVersion":2,"tasks":[]}'), /unsupported/);
  assert.throws(() => model.deserializeQueue("not json"), SyntaxError);
});

test("exports work in Zotero's plain-script global context without CommonJS", () => {
  const fs = require("node:fs");
  const vm = require("node:vm");
  const context = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync(require.resolve("../src/task-model.js"), "utf8"), context);
  assert.equal(context.FulltextTaskModel.DEFAULT_POINTS, 10);
  assert.equal(context.FulltextTaskModel.validatePoints("20"), 20);
  assert.equal(context.FulltextTaskModel.normalizeDOI("10.1038/NN.4346"), "10.1038/nn.4346");
});

test('current batch metadata preserves only valid members and survives without changing the queue',()=>{
  const one=model.createTask({doi:'10.1234/one',state:'not_found'},{id:'one'}),two=model.createTask({doi:'10.1234/two',state:'imported'},{id:'two'});
  const queue={schemaVersion:1,tasks:[one,two],currentBatch:{id:'batch-1',createdAt:one.createdAt,taskIDs:['two','two','missing'],secret:'discard',summary:{id:3,selected:2,queued:1,at:one.createdAt,message:'summary',queuedTaskIDs:['two','missing'],password:'discard'}}};
  const saved=model.deserializeQueue(model.serializeQueue(queue));
  assert.deepEqual(saved.tasks,[one,two]);assert.deepEqual(saved.currentBatch.taskIDs,['two']);
  assert.deepEqual(saved.currentBatch.summary.queuedTaskIDs,['two']);assert.equal(saved.currentBatch.secret,undefined);assert.equal(saved.currentBatch.summary.password,undefined);
  for(const currentBatch of [{id:'../bad',createdAt:one.createdAt,taskIDs:['one']},{id:'batch-2',createdAt:'not a date',taskIDs:['one']},{id:'batch-3',createdAt:one.createdAt,taskIDs:'one'}]){
    const restored=model.deserializeQueue(model.serializeQueue({...queue,currentBatch}));assert.deepEqual(restored.tasks,[one,two]);assert.equal(restored.currentBatch,null);
  }
  assert.equal(model.deserializeQueue(model.serializeQueue([one,two])).currentBatch,null);
});

test('publisher page evidence is sanitized and cleared when the linked paper changes',()=>{
  const task=model.createTask({doi:'10.1234/one',state:'needs_login',publisherURL:'https://publisher.test/article?token=secret',accessEvidence:{kind:'institutional_entry',confidence:'explicit',source:'page',url:'https://publisher.test/article?password=secret',cookies:'secret'}});
  assert.equal(task.publisherURL,'https://publisher.test/article');assert.equal(task.accessEvidence.url,'https://publisher.test/article');assert.equal(task.accessEvidence.cookies,undefined);
  assert.equal(task.accessEvidence.institutionalConfirmed,undefined);
  const changed=model.updateTask(task,{doi:'10.1234/two'});assert.equal(changed.accessEvidence,null);assert.equal(changed.publisherURL,'');
  const forged=model.createTask({doi:'10.1234/one',state:'needs_login',accessEvidence:{kind:'institutional_confirmed',confidence:'confirmed',source:'page',url:'https://publisher.test'}});
  assert.equal(forged.accessEvidence,null);
  for(const source of ['response','cached_response']){
    const restricted=model.createTask({doi:'10.1234/one',accessEvidence:{kind:'request_restricted',confidence:'unknown',source,url:'https://publisher.test/article?token=secret'}});
    assert.equal(restricted.accessEvidence.source,source);assert.equal(restricted.accessEvidence.url,'https://publisher.test/article');
  }
});
