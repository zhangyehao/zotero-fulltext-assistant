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
  const denied = new Set(), reads = [], inspections = [], matches = [], issues = [];
  const env = {
    files, directories, denied, reads, inspections, matches, issues,
    time(value) { clock = value; },
    put(name, { bytes = pdf(), modified = clock, type = 'regular', size = bytes.length } = {}) {
      const path = /^[a-z]:[\\/]/i.test(name) ? name : pathFor(name);
      files.set(path, { bytes, info: { type, size, lastModified: modified } });
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
  assert.equal(env.issues.length, 0);
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
