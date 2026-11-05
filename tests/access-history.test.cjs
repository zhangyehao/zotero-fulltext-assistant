const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const history = require('../src/access-history.js');
const now = Date.parse('2026-11-05T10:00:00Z');
const url = 'https://www.sciencedirect.com/science/article/pii/S002839081400478X';
const doi = '10.1016/j.neuropharm.2014.12.027';
const success = (state = history.empty(), changes = {}) => history.record(state, { url, doi, kind: 'browser_success', source: 'browser_download', ...changes }, { now });
const confirmed = (state = history.empty(), changes = {}) => history.record(state, { url, doi, kind: 'institutional_confirmed', source: 'user_confirmation', confirmedByUser: true, ...changes }, { now });

test('browser success stores article evidence without manufacturing an institutional entitlement', () => {
  const initial = history.empty(), result = success(initial);
  assert.equal(initial.entries.length, 0);
  assert.equal(result.entries.length, 1);
  assert.deepEqual(history.lookup(result, { url, doi, now }), {
    scope: 'article', kind: 'browser_success', confidence: 'observed', source: 'browser_download', at: new Date(now).toISOString(),
    host: 'www.sciencedirect.com', doi, stale: false, institutionalConfirmed: false,
    message: '这篇论文曾通过浏览器成功获取，访问方式未确认。可在日常浏览器重试。',
  });
});

test('institutional confirmation requires the specific user action and an explicit boolean', () => {
  for (const change of [{ confirmedByUser: false }, { confirmedByUser: 'true' }, { confirmedByUser: undefined }, { source: 'browser_download' }, { source: 'legacy_history' }, { source: 'page' }]) {
    assert.throws(() => confirmed(history.empty(), change), /用户明确确认/);
  }
  const hint = history.lookup(confirmed(), { url, doi, now });
  assert.equal(hint.kind, 'institutional_confirmed');
  assert.equal(hint.confidence, 'confirmed');
  assert.equal(hint.institutionalConfirmed, true);
  assert.match(hint.message, /曾明确确认/);
  assert.match(hint.message, /不保证当前订阅/);
});

test('a confirmed other article is only a host hint and cannot confirm current article access', () => {
  const hint = history.lookup(confirmed(), { url: url.replace('478X', '4791'), doi: '10.1016/other', now });
  assert.equal(hint.scope, 'host_hint');
  assert.equal(hint.confidence, 'hint');
  assert.equal(hint.institutionalConfirmed, false);
  assert.equal(hint.doi, '10.1016/other');
  assert.match(hint.message, /未确认本篇论文/);
});

test('evidence does not cross publishers or subdomains', () => {
  for (const other of ['https://sciencedirect.com/article', 'https://api.sciencedirect.com/article', 'https://www.nature.com/article', 'https://www.sciencedirect.com.example.test/article']) {
    const hint = history.lookup(confirmed(), { url: other, doi, now });
    assert.equal(hint.scope, 'none');
    assert.equal(hint.institutionalConfirmed, false);
  }
});

test('exact browser history takes precedence over an unrelated confirmed article', () => {
  const state = success(confirmed(history.empty(), { doi: '10.1016/other' }));
  const hint = history.lookup(state, { url, doi, now });
  assert.equal(hint.scope, 'article');
  assert.equal(hint.kind, 'browser_success');
  assert.equal(hint.institutionalConfirmed, false);
});

test('old confirmation is retained as dated history and downgraded after 180 days', () => {
  const at = new Date(now - history.STALE_AFTER_MS - 1).toISOString();
  const hint = history.lookup(confirmed(history.empty(), { at }), { url, doi, now });
  assert.equal(hint.stale, true);
  assert.equal(hint.confidence, 'hint');
  assert.equal(hint.institutionalConfirmed, false);
  assert.equal(hint.at, at);
  assert.match(hint.message, /超过 180 天/);
});

test('a later generic download cannot refresh or overwrite an explicit institutional statement', () => {
  const at = new Date(now - history.STALE_AFTER_MS - 1).toISOString();
  const state = success(confirmed(history.empty(), { at }));
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].kind, 'institutional_confirmed');
  assert.equal(state.entries[0].at, at);
  assert.equal(history.lookup(state, { url, doi, now }).stale, true);
});

test('a new explicit confirmation can refresh its own article history', () => {
  const prior = confirmed(history.empty(), { at: new Date(now - history.STALE_AFTER_MS - 1).toISOString() });
  const state = confirmed(prior);
  assert.equal(state.entries[0].at, new Date(now).toISOString());
  assert.equal(history.lookup(state, { url, doi, now }).institutionalConfirmed, true);
});

test('serialized history strips paths tokens cookies accounts and arbitrary confidence fields', () => {
  const state = success(history.empty(), { url: url + '?token=secret#fragment', cookie: 'secret', accountID: 'private', path: 'C:/private.pdf', confidence: 'confirmed' });
  const text = JSON.stringify(state);
  for (const needle of ['token', 'secret', 'fragment', 'cookie', 'accountID', 'private', '/science/article/']) assert(!text.includes(needle), needle);
  const restored = history.normalize({ ...state, cookie: 'secret', entries: state.entries.map(entry => ({ ...entry, extra: 'secret', confidence: 'confirmed' })) }, { now });
  assert.deepEqual(restored, state);
  assert.equal(restored.entries[0].confidence, 'observed');
});

test('normalization discards unsupported or forged confirmation records', () => {
  const entry = confirmed().entries[0];
  for (const change of [{ confirmedByUser: false }, { confirmedByUser: undefined }, { source: 'browser_import' }, { kind: 'site_authorized' }, { host: 'www.sciencedirect.com/path' }, { at: 'tomorrow' }]) {
    const state = history.normalize({ schemaVersion: 1, entries: [{ ...entry, ...change }] }, { now });
    assert.equal(state.entries.length, 0, JSON.stringify(change));
  }
});

test('history accepts only known browser evidence sources', () => {
  for (const source of ['browser_download', 'browser_import', 'legacy_history']) assert.equal(success(history.empty(), { source }).entries[0].source, source);
  for (const source of ['publisher', 'ablesci', 'existing', 'user_confirmation', 'page', '']) assert.throws(() => success(history.empty(), { source }));
});

test('URL and DOI normalization is exact and does not extract identifiers from unrelated text', () => {
  const state = success(history.empty(), { url: 'https://WWW.SCIENCEDIRECT.COM./somewhere', doi: 'https://doi.org/10.1016%2FJ.NEUROPHARM.2014.12.027' });
  assert.equal(state.entries[0].host, 'www.sciencedirect.com');
  assert.equal(state.entries[0].doi, doi);
  for (const value of ['article doi: ' + doi, 'https://example.test/' + doi, 'https://doi.org/' + doi + '?token=x', '10.1016/has space', '']) {
    assert.throws(() => success(history.empty(), { doi: value }));
  }
});

test('resolver local credential-bearing and non-web URLs do not create publisher records', () => {
  for (const value of ['https://doi.org/' + doi, 'https://dx.doi.org/' + doi, 'https://user:pass@www.sciencedirect.com/a', 'file:///private.pdf', 'https://127.0.0.1/a', 'http://localhost/a', 'https://www.sciencedirect.com:8080/a']) {
    assert.equal(history.publisherHost(value), '', value);
    assert.throws(() => success(history.empty(), { url: value }));
  }
});

test('duplicate records normalize to the newest strong statement without aliasing the input', () => {
  const older = confirmed(history.empty(), { at: new Date(now - 10000).toISOString() }).entries[0];
  const newer = confirmed().entries[0], browser = success().entries[0];
  const raw = { schemaVersion: 1, entries: [older, browser, newer, newer] };
  const result = history.normalize(raw, { now });
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.entries[0], newer);
  result.entries[0].host = 'mutated.test';
  assert.equal(raw.entries[2].host, 'www.sciencedirect.com');
});

test('history cap keeps the most recent 200 independent articles', () => {
  const entries = Array.from({ length: 230 }, (_, index) => ({ ...success().entries[0], doi: '10.1234/' + index, at: new Date(now - index * 1000).toISOString() }));
  const result = history.normalize({ schemaVersion: 1, entries: entries.reverse() }, { now });
  assert.equal(result.entries.length, history.MAX_ENTRIES);
  assert.equal(result.entries[0].doi, '10.1234/0');
  assert.equal(result.entries.at(-1).doi, '10.1234/199');
});

test('invalid containers and far-future observations never become access evidence', () => {
  for (const raw of [null, [], {}, { schemaVersion: 2, entries: confirmed().entries }, { schemaVersion: 1, entries: null }]) assert.deepEqual(history.normalize(raw, { now }), history.empty());
  assert.throws(() => confirmed(history.empty(), { at: new Date(now + 300001).toISOString() }));
  assert.equal(history.lookup(confirmed(), { url: 'not a URL', doi, now }).scope, 'none');
});

test('forget removes only the selected article on the exact host', () => {
  const state = success(confirmed(history.empty(), { doi: '10.1016/other' }));
  const next = history.forget(state, { url, doi, now });
  assert.equal(next.entries.length, 1);
  assert.equal(next.entries[0].doi, '10.1016/other');
  assert.equal(state.entries.length, 2);
});

test('plain Zotero script loading works without CommonJS', () => {
  const scope = { URL, Date, Set, Map, Object };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/access-history.js'), 'utf8'), scope);
  assert.equal(typeof scope.FulltextAccessHistory.record, 'function');
  assert.equal(scope.FulltextAccessHistory.empty().schemaVersion, 1);
});
