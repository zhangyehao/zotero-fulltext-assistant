const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../src/download-watch.js');

const directory = 'C:\\Downloads';
const expected = { doi: '10.1016/j.neuropharm.2014.12.027', title: 'An expected article' };
const pathFor = name => directory + '\\' + name;
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function pdf(size = 2048) {
  const bytes = Buffer.alloc(size, 32);
  bytes.write('%PDF-1.7\n');
  bytes.write('\n%%EOF', size - 6);
  return bytes;
}
function setup(options = {}) {
  let clock = 0;
  const files = new Map(), directories = new Set([directory]);
  const denied = new Set(), reads = [], inspections = [], matches = [], candidates = [], issues = [];
  const env = {
    files, directories, denied, reads, inspections, matches, candidates, issues,
    time(value) { clock = value; },
    put(name, { bytes = pdf(), modified = clock, created = modified, type = 'regular', size = bytes.length } = {}) {
      const path = /^[a-z]:[\\/]/i.test(name) ? name : pathFor(name);
      files.set(path, { bytes, info: { type, size, lastModified: modified, creationTime: created } });
      return path;
    },
    readHook: null,
    listingHook: null,
  };
  const IOUtils = {
    async stat(path) {
      if (denied.has(path)) throw new Error('Permission denied');
      if (directories.has(path)) return { type: 'directory' };
      const file = files.get(path);
      if (!file) throw new Error('File not found');
      return { ...file.info };
    },
    async getChildren(path) {
      if (denied.has(path)) throw new Error('Permission denied');
      if (env.listingHook) await env.listingHook(path);
      return [...files.keys()].filter(file => file.slice(0, file.lastIndexOf('\\')) === path);
    },
    async read(path) {
      reads.push(path);
      if (denied.has(path)) throw new Error('Permission denied');
      const bytes = Buffer.from(files.get(path).bytes);
      if (env.readHook) await env.readHook(path);
      return bytes;
    },
  };
  env.watch = create({
    IOUtils, PathUtils: { filename: path => path.split(/[\\/]/).pop() },
    inspect: async (path, metadata, input) => {
      inspections.push({ path, expected: metadata, bytes: input.bytes });
      return options.inspect ? options.inspect(path, metadata, input) : { status: 'match', reason: 'doi' };
    },
    validPDF: bytes => Buffer.from(bytes).subarray(0, 5).toString() === '%PDF-' && Buffer.from(bytes).subarray(-5).toString() === '%%EOF',
    onMatch: async (id, result) => {
      matches.push({ id, ...result });
      return options.onMatch ? options.onMatch(id, result) : undefined;
    },
    onCandidate: async (id, result) => { candidates.push({ id, ...result });if (options.onCandidate) await options.onCandidate(id, result); },
    onIssue: async (id, issue) => { issues.push({ id, ...issue }); },
    now: () => clock,
    stableMs: options.stableMs ?? 2000,
    timeoutMs: options.timeoutMs ?? 30 * 60 * 1000,
  });
  return env;
}
async function settle(env, at = 2000) {
  await env.watch.poll();
  env.time(at);
  await env.watch.poll();
}

test('a newly downloaded stable PDF is matched once and carries the expected metadata', async () => {
  const env = setup();
  assert.equal(await env.watch.start('one', directory, expected), true);
  const path = env.put('download.PDF');
  await env.watch.poll();
  assert.equal(env.reads.length, 0);
  env.time(1999);
  await env.watch.poll();
  assert.equal(env.inspections.length, 0);
  env.time(2000);
  await env.watch.poll();
  assert.equal(env.matches.length, 1);
  assert.equal(env.matches[0].id, 'one');
  assert.equal(env.matches[0].path, path);
  assert.deepEqual(env.matches[0].expected, expected);
  assert.deepEqual(env.inspections[0].expected, expected);
  assert.deepEqual(env.matches[0].bytes, env.files.get(path).bytes);
  assert.equal(env.watch.isWatching('one'), false);
  await env.watch.poll();
  assert.equal(env.matches.length, 1);
});

test('existing PDFs form a baseline and are never read or inspected while unchanged', async () => {
  const env = setup();
  env.put('old.pdf');
  await env.watch.start('one', directory, expected);
  await settle(env);
  env.time(10000);
  await env.watch.poll();
  assert.deepEqual(env.reads, []);
  assert.deepEqual(env.inspections, []);
  assert.deepEqual(env.matches, []);
  assert.equal(env.watch.isWatching('one'), true);
});

test('incomplete browser download filenames are ignored until renamed to a final PDF', async () => {
  const env = setup();
  await env.watch.start('one', directory, expected);
  const temporary = env.put('article.pdf.crdownload');
  env.put('article.pdf.part');
  env.put('article.pdf.tmp');
  await settle(env);
  assert.deepEqual(env.reads, []);
  env.files.delete(temporary);
  const final = env.put('article.pdf', { modified: 2001 });
  await env.watch.poll();
  env.time(4000);
  await env.watch.poll();
  assert.deepEqual(env.reads, [final]);
  assert.equal(env.matches[0].path, final);
});

test('mismatching, unknown and failed identity checks never import unrelated PDFs', async () => {
  const env = setup({ inspect: async path => {
    if (path.endsWith('failed.pdf')) throw new Error('Cannot extract text');
    return { status: path.endsWith('other.pdf') ? 'mismatch' : 'unknown' };
  } });
  await env.watch.start('one', directory, expected);
  env.put('other.pdf');
  env.put('unknown.pdf');
  env.put('failed.pdf');
  await settle(env);
  assert.equal(env.inspections.length, 3);
  assert.equal(env.matches.length, 0);
  assert.equal(env.watch.isWatching('one'), true);
  env.time(9000);
  await env.watch.poll();
  assert.equal(env.inspections.length, 3, 'unchanged rejected PDFs are not checked repeatedly');
  assert.deepEqual(env.issues.map(issue => [issue.kind, issue.status]), [['identity','mismatch'],['identity','unknown'],['identity','unknown']]);
  assert.deepEqual(env.candidates, [], 'unknown extraction is diagnostic, not evidence of a related paper');
  assert.equal(env.watch.getStatus('one').scanned,3);
  assert.equal(env.watch.getStatus('one').unknown,2);
  assert.equal(env.watch.getStatus('one').mismatched,1);
});

test('a PDF matching multiple waiting tasks is reported as ambiguous and is not imported', async () => {
  const env = setup();
  await env.watch.start('one', directory, expected);
  await env.watch.start('two', directory, expected);
  env.put('same-article.pdf');
  await settle(env);
  assert.equal(env.inspections.length, 2);
  assert.equal(env.reads.length, 1);
  assert.equal(env.matches.length, 0);
  assert.deepEqual(env.issues.map(issue => [issue.id, issue.kind]), [['one', 'ambiguous'], ['two', 'ambiguous']]);
  assert.equal(env.watch.isWatching('one'), true);
  assert.equal(env.watch.isWatching('two'), true);
  await env.watch.poll();
  assert.equal(env.issues.length, 2);
});

test('a growing PDF must remain unchanged for the full stability interval', async () => {
  const env = setup();
  await env.watch.start('one', directory, expected);
  env.put('growing.pdf');
  await env.watch.poll();
  env.time(1500);
  env.put('growing.pdf', { bytes: pdf(4096) });
  await env.watch.poll();
  env.time(3499);
  await env.watch.poll();
  assert.equal(env.reads.length, 0);
  env.time(3500);
  await env.watch.poll();
  assert.equal(env.matches.length, 1);
  assert.equal(env.matches[0].bytes.length, 4096);
});

test('a PDF changed during reading is not inspected or imported until it becomes stable', async () => {
  const env = setup();
  await env.watch.start('one', directory, expected);
  env.put('changing.pdf');
  env.readHook = async () => {
    env.readHook = null;
    env.put('changing.pdf', { bytes: pdf(4096) });
  };
  await settle(env);
  assert.equal(env.reads.length, 1);
  assert.equal(env.inspections.length, 0);
  assert.equal(env.matches.length, 0);
  await env.watch.poll();
  env.time(4000);
  await env.watch.poll();
  assert.equal(env.matches.length, 1);
  assert.equal(env.matches[0].bytes.length, 4096);
});

for (const action of ['cancel', 'stop', 'isCancelled']) {
  test(action + ' prevents a late identity match from importing', async () => {
    const entered = deferred(), finish = deferred();
    let cancelled = false;
    const env = setup({ inspect: async () => { entered.resolve(); await finish.promise; return { status: 'match' }; } });
    await env.watch.start('one', directory, expected, { isCancelled: () => cancelled });
    env.put('late.pdf');
    await env.watch.poll();
    env.time(2000);
    const polling = env.watch.poll();
    await entered.promise;
    let stopping;
    if (action === 'cancel') env.watch.cancel('one');
    if (action === 'stop') stopping = env.watch.stop();
    if (action === 'isCancelled') cancelled = true;
    finish.resolve();
    await polling;
    if (stopping) await stopping;
    assert.equal(env.matches.length, 0);
    assert.equal(env.issues.length, 0);
    assert.equal(env.watch.isWatching('one'), false);
    if (action === 'stop') await assert.rejects(env.watch.start('two', directory, expected), /已停止/);
  });
}

test('an unreadable folder rejects startup without leaving an active task', async () => {
  const env = setup();
  env.denied.add(directory);
  await assert.rejects(env.watch.start('one', directory, expected), /Permission denied/);
  assert.equal(env.watch.isWatching('one'), false);
  await env.watch.poll();
  assert.equal(env.reads.length, 0);
  assert.equal(env.matches.length, 0);
});

test('a folder that becomes unreadable ends its watches with an actionable issue', async () => {
  const env = setup();
  await env.watch.start('one', directory, expected);
  await env.watch.start('two', directory, expected);
  env.denied.add(directory);
  await env.watch.poll();
  assert.deepEqual(env.issues.map(issue => [issue.id, issue.kind]), [['one', 'directory'], ['two', 'directory']]);
  assert.equal(env.watch.isWatching('one'), false);
  assert.equal(env.watch.isWatching('two'), false);
  assert.equal(env.matches.length, 0);
  await env.watch.poll();
  assert.equal(env.issues.length, 2);
});

test('an unreadable individual file is skipped and can be retried when reading succeeds', async () => {
  const env = setup();
  await env.watch.start('one', directory, expected);
  const path = env.put('locked.pdf');
  env.readHook = async () => { throw new Error('The download is locked'); };
  await settle(env);
  assert.equal(env.matches.length, 0);
  assert.equal(env.inspections.length, 0);
  assert.equal(env.watch.isWatching('one'), true);
  env.readHook = null;
  await env.watch.poll();
  assert.equal(env.matches[0].path, path);
});

test('expiration removes a watch before it reads or imports a waiting PDF', async () => {
  const env = setup({ timeoutMs: 4000 });
  await env.watch.start('one', directory, expected);
  env.put('late.pdf');
  await env.watch.poll();
  env.time(4000);
  await env.watch.poll();
  assert.equal(env.watch.isWatching('one'), false);
  assert.deepEqual(env.issues.map(issue => issue.kind), ['expired']);
  assert.equal(env.reads.length, 0);
  assert.equal(env.matches.length, 0);
  await env.watch.poll();
  assert.equal(env.issues.length, 1);
});

test('invalid, undersized, oversized and symlink files never reach identity inspection', async () => {
  const env = setup();
  await env.watch.start('one', directory, expected);
  env.put('fake.pdf', { bytes: Buffer.alloc(2048, 32) });
  env.put('small.pdf', { bytes: pdf(512) });
  env.put('large.pdf', { size: 101 * 1024 * 1024 });
  env.put('linked.pdf', { type: 'symlink' });
  await settle(env);
  assert.deepEqual(env.reads, [pathFor('fake.pdf')]);
  assert.equal(env.inspections.length, 0);
  assert.equal(env.matches.length, 0);
});

test('concurrent poll calls share one scan and cannot import the same file twice', async () => {
  const entered = deferred(), finish = deferred();
  const env = setup({ inspect: async () => { entered.resolve(); await finish.promise; return { status: 'match' }; } });
  await env.watch.start('one', directory, expected);
  env.put('one.pdf');
  await env.watch.poll();
  env.time(2000);
  const first = env.watch.poll();
  await entered.promise;
  const second = env.watch.poll();
  assert.equal(first, second);
  finish.resolve();
  await Promise.all([first, second]);
  assert.equal(env.reads.length, 1);
  assert.equal(env.inspections.length, 1);
  assert.equal(env.matches.length, 1);
});

test('a poll during startup cannot import an old PDF before the baseline is ready', async () => {
  const entered = deferred(), finish = deferred();
  const env = setup();
  env.put('already-there.pdf');
  env.listingHook = async () => {
    env.listingHook = null;
    entered.resolve();
    await finish.promise;
  };
  const starting = env.watch.start('one', directory, expected);
  await entered.promise;
  await settle(env);
  finish.resolve();
  await starting;
  assert.equal(env.matches.length, 0);
  assert.equal(env.reads.length, 0);
  assert.equal(env.watch.isWatching('one'), true);
});

test('identity verification completing after the deadline cannot import an expired PDF', async () => {
  const entered = deferred(), finish = deferred();
  const env = setup({ timeoutMs: 4000, inspect: async () => {
    entered.resolve();
    await finish.promise;
    return { status: 'match' };
  } });
  await env.watch.start('one', directory, expected);
  env.put('slow-to-identify.pdf');
  await env.watch.poll();
  env.time(2000);
  const polling = env.watch.poll();
  await entered.promise;
  env.time(4000);
  finish.resolve();
  await polling;
  await env.watch.poll();
  assert.equal(env.matches.length, 0);
  assert.equal(env.watch.isWatching('one'), false);
  assert.deepEqual(env.issues.map(issue => issue.kind), ['expired']);
});

test('a task baselines all selected directories and matches a new PDF in any of them', async () => {
  const env = setup(), second = 'D:\\Papers';
  env.directories.add(second);
  env.put('old.pdf');
  env.put(second + '\\also-old.pdf');
  await env.watch.start('one', [directory, second, directory], expected);
  await settle(env);
  assert.deepEqual(env.reads, []);
  const path = env.put(second + '\\new.pdf');
  await env.watch.poll();
  env.time(4000);
  await env.watch.poll();
  assert.deepEqual(env.reads, [path]);
  assert.equal(env.matches.length, 1);
  assert.equal(env.matches[0].path, path);
  assert.equal(env.watch.isWatching('one'), false);
});

test('startup is rejected if any selected directory is unreadable', async () => {
  const env = setup(), second = 'D:\\Papers';
  env.directories.add(second);
  env.denied.add(second);
  await assert.rejects(env.watch.start('one', [directory, second], expected), /Permission denied/);
  assert.equal(env.watch.isWatching('one'), false);
  env.put('new.pdf');
  await settle(env);
  assert.equal(env.matches.length, 0);
});

test('an unreadable watched directory stops a task without importing a new file from another folder', async () => {
  const env = setup(), second = 'D:\\Papers';
  env.directories.add(second);
  await env.watch.start('one', [directory, second], expected);
  env.put(second + '\\new.pdf');
  await env.watch.poll();
  env.denied.add(directory);
  env.time(2000);
  await env.watch.poll();
  assert.equal(env.watch.isWatching('one'), false);
  assert.equal(env.matches.length, 0);
  assert.deepEqual(env.issues.map(issue => issue.kind), ['directory']);
});

test('a busy import handler can decline a match and receive it on a later poll', async () => {
  let busy = true;
  const env = setup({ onMatch: async () => busy ? false : true });
  await env.watch.start('one', directory, expected);
  env.put('wait-for-import.pdf');
  await settle(env);
  assert.equal(env.matches.length, 1);
  assert.equal(env.watch.isWatching('one'), true);
  busy = false;
  await env.watch.poll();
  assert.equal(env.matches.length, 2);
  assert.equal(env.watch.isWatching('one'), false);
});

test('cancelling while a match handoff is pending cannot resurrect its watch on decline', async () => {
  const entered = deferred(), finish = deferred();
  const env = setup({ onMatch: async () => { entered.resolve(); await finish.promise; return false; } });
  await env.watch.start('one', directory, expected);
  env.put('pending-handoff.pdf');
  await env.watch.poll();
  env.time(2000);
  const polling = env.watch.poll();
  await entered.promise;
  env.watch.cancel('one');
  finish.resolve();
  await polling;
  assert.equal(env.watch.isWatching('one'), false);
  await env.watch.poll();
  assert.equal(env.matches.length, 1);
});

test('a related unknown candidate reports its exact checked snapshot once while the watch keeps waiting', async () => {
  const env=setup({inspect:async()=>({status:'unknown',related:true,candidateScore:0.85,reason:'title_outside_front_matter',message:'Title occurs after prior references.'})});
  await env.watch.start('one',directory,expected);const file=env.put('candidate.pdf');await settle(env);
  assert.equal(env.matches.length,0);assert.equal(env.candidates.length,1);assert.equal(env.watch.isWatching('one'),true);
  assert.equal(env.candidates[0].path,file);assert.deepEqual(env.candidates[0].bytes,env.files.get(file).bytes);assert.deepEqual(env.candidates[0].expected,expected);
  assert.equal(env.issues[0].reason,'title_outside_front_matter');assert.match(env.issues[0].message,/candidate\.pdf/);
  const status=env.watch.getStatus('one');assert.equal(status.scanned,1);assert.equal(status.unknown,1);assert.equal(status.lastScanAt,new Date(2000).toISOString());status.unknown=100;
  await env.watch.poll();assert.equal(env.candidates.length,1);assert.equal(env.issues.length,1);assert.equal(env.watch.getStatus('one').unknown,1);
});

test('explicit recent-file rescan can inspect downloaded baseline PDFs without admitting older files',async()=>{
  const env=setup();env.time(10000);
  const old=env.put('old.pdf',{modified:1000,created:1000});
  const downloaded=env.put('downloaded.pdf',{modified:5000,created:2000});
  const preserved=env.put('preserved-date.pdf',{modified:500,created:7000});
  await env.watch.start('one',directory,expected);await env.watch.poll();assert.equal(env.reads.length,0);
  const result=await env.watch.rescan('one',{includeExisting:true,since:new Date(4000).toISOString()});assert.equal(result.eligible,2);assert.equal(env.watch.getStatus('one').baseline,1);
  await env.watch.poll();env.time(12000);await env.watch.poll();assert.equal(env.matches.length,1);assert.notEqual(env.matches[0].path,old);assert.ok([downloaded,preserved].includes(env.matches[0].path));
  assert.equal(env.reads.includes(old),false);
});

test('rescan retries a checked unknown file and still requires the stable interval and full identity check',async()=>{
  let match=false;const env=setup({inspect:async()=>({status:match?'match':'unknown',related:true,candidateScore:0.8,reason:'insufficient_identity'})});
  await env.watch.start('one',directory,expected);env.put('review.pdf');await settle(env);assert.equal(env.candidates.length,1);
  match=true;const result=await env.watch.rescan('one');assert.equal(result.eligible,1);await env.watch.poll();assert.equal(env.matches.length,0);
  env.time(4000);await env.watch.poll();assert.equal(env.matches.length,1);assert.equal(env.inspections.length,2);
});

test('recent-file rescan requires a timestamp and cancellation during listing cannot revive a watch',async()=>{
  const env=setup(),gate=deferred();env.put('existing.pdf');await env.watch.start('one',directory,expected);
  await assert.rejects(env.watch.rescan('one',{includeExisting:true}),/起始时间/);
  let entered=false;env.listingHook=async()=>{entered=true;await gate.promise;};
  const rescanning=env.watch.rescan('one',{includeExisting:true,since:0});while(!entered)await new Promise(resolve=>setImmediate(resolve));
  env.watch.cancel('one');gate.resolve();assert.equal((await rescanning).cancelled,true);assert.equal(env.watch.isWatching('one'),false);assert.equal(env.matches.length,0);
});

test('invalid stable PDFs expose a reason once without repeated reads and oversized files never get read',async()=>{
  const env=setup();await env.watch.start('one',directory,expected);env.put('invalid.pdf',{bytes:Buffer.alloc(2048,32)});env.put('large.pdf',{size:101*1024*1024});await settle(env);
  assert.deepEqual(env.issues.map(issue=>issue.reason).sort(),['file_size','invalid_pdf']);assert.equal(env.watch.getStatus('one').rejected,2);
  await env.watch.poll();assert.equal(env.reads.length,1);assert.equal(env.issues.length,2);assert.equal(env.candidates.length,0);assert.equal(env.matches.length,0);
});

test('nineteen unrelated or unreadable downloads do not become nineteen review candidates',async()=>{
  const env=setup({inspect:async path=>path.endsWith('likely.pdf')
    ?{status:'unknown',related:true,candidateScore:0.87,titleSimilarity:0.92,detectedTitle:'A related paper title',evidence:{extractionSucceeded:true,titleReliable:true}}
    :path.endsWith('scan.pdf')?{status:'unknown',related:false,candidateScore:0,reason:'no_text',evidence:{extractionSucceeded:true,firstPageCharacterCount:0}}
    :{status:'unknown',related:false,candidateScore:0,titleSimilarity:0.1,detectedTitle:'An entirely different publication',evidence:{extractionSucceeded:true,titleReliable:true}}});
  await env.watch.start('one',directory,expected);
  for(let i=0;i<18;i++)env.put('other-'+i+'.pdf');env.put('scan.pdf');env.put('likely.pdf');
  await settle(env);await env.watch.poll();await env.watch.poll();
  const status=env.watch.getStatus('one');assert.equal(status.scanned,20);assert.equal(status.related,1);assert.equal(status.unrelated,18);assert.equal(status.unreadable,1);
  assert.equal(env.candidates.length,1);assert.equal(env.candidates[0].path,pathFor('likely.pdf'));assert.equal(env.matches.length,0);
  const details=env.watch.getDiagnostics('one');assert.equal(details.length,5);assert(details.every(value=>!Object.hasOwn(value,'path')));
  details[0].evidence.extractionSucceeded=false;assert.equal(env.watch.getDiagnostics('one')[0].evidence.extractionSucceeded,true);
});

test('rechecking one file replaces its outcome rather than inflating candidate counts',async()=>{
  let related=true;const env=setup({inspect:async()=>related?{status:'unknown',related:true,candidateScore:0.8}:{status:'mismatch',related:false,candidateScore:0}});
  await env.watch.start('one',directory,expected);env.put('changing.pdf');await settle(env);
  assert.equal(env.watch.getStatus('one').related,1);
  await env.watch.rescan('one');await env.watch.poll();env.time(4000);await env.watch.poll();
  let status=env.watch.getStatus('one');assert.equal(status.scanned,1);assert.equal(status.related,1);assert.equal(status.unknown,1);
  related=false;await env.watch.rescan('one');await env.watch.poll();env.time(6000);await env.watch.poll();
  status=env.watch.getStatus('one');assert.equal(status.scanned,1);assert.equal(status.related,0);assert.equal(status.unknown,0);assert.equal(status.mismatched,1);
});

test('a candidate overwritten with invalid data moves to unreadable diagnostics and recovers without stale counts',async()=>{
  const env=setup({inspect:async()=>({status:'unknown',related:true,candidateScore:0.8})});
  await env.watch.start('one',directory,expected);env.put('changed.pdf');await settle(env);
  env.put('changed.pdf',{bytes:Buffer.alloc(2048,32),modified:3000});await env.watch.poll();env.time(4000);await env.watch.poll();
  let status=env.watch.getStatus('one');assert.equal(status.scanned,1);assert.equal(status.related,0);assert.equal(status.unreadable,1);assert.equal(status.rejected,1);
  assert.equal(env.watch.getDiagnostics('one')[0].reason,'invalid_pdf');
  env.put('changed.pdf',{bytes:pdf(),modified:5000});await env.watch.poll();env.time(6000);await env.watch.poll();
  status=env.watch.getStatus('one');assert.equal(status.scanned,1);assert.equal(status.related,1);assert.equal(status.unreadable,0);assert.equal(status.rejected,0);assert.deepEqual(env.watch.getDiagnostics('one'),[]);
});
