const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/publisher-session.js'), 'utf8');
const HOSTS_PREF = 'extensions.fulltext-assistant.publisherSessionHosts';
function cookie(host, name, extra = {}) { return {host, name, value: 'private-session-value', path: '/', isSecure: true, isHttpOnly: true, isSession: true, expiry: 2147483647, sameSite: 1, schemeMap: 2, originAttributes: {userContextId: 0, privateBrowsingId: 0}, ...extra}; }
function setup({hosts = [], jar = [], backup = null} = {}) {
  const prefs = new Map([[HOSTS_PREF, JSON.stringify(hosts)]]), logins = backup ? [{password: JSON.stringify(backup)}] : [], observers = new Set(), reads = [], adds = [];
  const Services = {
    prefs: {getStringPref: (key, fallback) => prefs.get(key) || fallback, setStringPref: (key, value) => prefs.set(key, value)},
    obs: {addObserver: value => observers.add(value), removeObserver: value => observers.delete(value)},
    logins: {findLogins: () => [...logins], async addLoginAsync(value) {logins.push(value);}, modifyLogin(old, value) {logins.splice(logins.indexOf(old), 1, value);}, removeLogin(value) {logins.splice(logins.indexOf(value), 1);}},
    cookies: {
      getCookiesFromHost(host) {reads.push(host);return jar.filter(value => value.host.replace(/^\./, '') === host || host.endsWith(value.host));},
      add(host, path, name, value, isSecure, isHttpOnly, isSession, expiry, originAttributes, sameSite, schemeMap, isPartitioned) {const next = {host, path, name, value, isSecure, isHttpOnly, isSession, expiry, originAttributes, sameSite, schemeMap, isPartitioned};adds.push(next);jar.push(next);},
    },
  };
  const scope = {URL, Date, Map, Set, Promise};vm.runInNewContext(source, scope);
  const create = () => scope.FulltextPublisherSession.create({Zotero: {Promise: {delay: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5)))}}, Services,
    makeLogin(origin, realm, username, password) {return {origin, realm, username, password};}});
  return {create, session: create(), Services, prefs, logins, observers, reads, jar, adds};
}
test('initialization does not enumerate or back up any site before a confirmed host grant', async () => {
  const env = setup({jar: [cookie('.nature.com', 'session')]});await env.session.initialize();await env.session.flush();
  assert.deepEqual(env.reads, []);assert.equal(env.logins.length, 0);assert.equal(env.session.getStatus().enabled, false);await env.session.destroy();
});
test('confirmed hosts back up only eligible session cookies into the separate Login Manager realm', async () => {
  const env = setup({jar: [cookie('.nature.com', 'session'),cookie('www.nature.com', 'persistent', {isSession: false}),cookie('other.nature.com', 'sibling'),cookie('.unrelated.test', 'other'),cookie('.nature.com', 'private', {originAttributes: {privateBrowsingId: 1}}),cookie('.nature.com', 'container', {originAttributes: {userContextId: 3}}),cookie('.nature.com', 'partitioned', {originAttributes: {partitionKey: '(https,elsewhere.test)'}})]});
  await env.session.grantHosts(['www.nature.com', 'https://not-a-host.test/', 'www.nature.com']);
  const saved = JSON.parse(env.logins[0].password);
  assert.deepEqual(saved.cookies.map(value => value.name), ['session']);assert.equal(env.logins[0].realm, 'Publisher session cookies');
  assert.deepEqual(JSON.parse(env.prefs.get(HOSTS_PREF)), ['www.nature.com']);assert(!env.prefs.get(HOSTS_PREF).includes('private-session-value'));
  assert(env.reads.every(value => value === 'www.nature.com'));assert(!JSON.stringify(env.session.getStatus()).includes('private-session-value'));await env.session.destroy();
});
test('restart restores approved session cookies with original security and expiry fields', async () => {
  const original = cookie('.nature.com', 'session');
  const env = setup({hosts: ['www.nature.com'], backup: {version: 1, savedAt: new Date().toISOString(), cookies: [original,cookie('unrelated.test','other')]}});
  await env.session.initialize();assert.equal(env.adds.length, 1);assert.equal(env.adds[0].host, '.nature.com');assert.equal(env.adds[0].expiry, original.expiry);
  assert.equal(env.adds[0].isSession, true);assert.equal(env.adds[0].isSecure, true);assert.equal(env.adds[0].isHttpOnly, true);assert.equal(env.adds[0].sameSite, 1);assert.equal(env.adds[0].originAttributes.userContextId, 0);await env.session.destroy();
});
test('restart never overwrites a current cookie with an old backup', async () => {
  const existing = cookie('.nature.com','session',{value:'newer'});
  const env=setup({hosts:['www.nature.com'],jar:[existing],backup:{version:1,savedAt:new Date().toISOString(),cookies:[cookie('.nature.com','session')]}});
  await env.session.initialize();assert.equal(env.adds.length,0);assert.equal(env.jar[0].value,'newer');await env.session.destroy();
});
test('a recently saved session cookie with a site expiry in the past is never restored', async () => {
  const env=setup({hosts:['www.nature.com'],backup:{version:1,savedAt:new Date().toISOString(),cookies:[cookie('.nature.com','expired',{expiry:Math.floor(Date.now()/1000)-1})]}});
  await env.session.initialize();assert.equal(env.adds.length,0);assert.equal(env.logins.length,0);assert.equal(env.session.getStatus().hasBackup,false);await env.session.destroy();
});
test('Gecko unbounded-session expiry cannot overflow the signed add-cookie argument', async () => {
  const sentinel=9223372036854775807, before=Math.floor(Date.now()/1000);
  const env=setup({hosts:['www.nature.com'],backup:{version:1,savedAt:new Date().toISOString(),cookies:[cookie('.nature.com','unbounded',{expiry:sentinel})]}});
  await env.session.initialize();assert.equal(env.adds.length,1);assert(Number.isSafeInteger(env.adds[0].expiry));
  assert(env.adds[0].expiry<=before+30*86400+1);assert(env.adds[0].expiry<sentinel);assert.equal(env.adds[0].isSession,true);await env.session.destroy();
});
test('expired backups and backups whose host grants were removed cannot revive sessions', async () => {
  for (const hosts of [[], ['www.nature.com']]) {
    const env=setup({hosts,backup:{version:1,savedAt:new Date(Date.now()-31*86400000).toISOString(),cookies:[cookie('.nature.com','session')]}});
    await env.session.initialize();assert.equal(env.adds.length,0);assert.equal(env.logins.length,0);assert.equal(env.session.getStatus().hasBackup,false);await env.session.destroy();
  }
});
test('cookie deletion updates the encrypted backup so logout cannot be resurrected', async () => {
  const env=setup({jar:[cookie('.nature.com','session')]});await env.session.grantHosts(['www.nature.com']);assert.equal(env.logins.length,1);
  env.jar.length=0;for(const observer of env.observers)observer.observe();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(env.logins.length,0);await env.session.destroy();
});
test('clear removes grants and backup without clearing shared browser cookies', async () => {
  const env=setup({jar:[cookie('.nature.com','session')]});await env.session.grantHosts(['www.nature.com']);await env.session.clear();
  assert.equal(env.logins.length,0);assert.deepEqual(JSON.parse(env.prefs.get(HOSTS_PREF)),[]);assert.equal(env.jar.length,1);await env.session.flush();assert.equal(env.logins.length,0);await env.session.destroy();assert.equal(env.observers.size,0);
});
test('credential failures expose only a sanitized message and no cookie values', async () => {
  const env=setup({jar:[cookie('.nature.com','session')]});await env.session.initialize();env.Services.logins.addLoginAsync=async()=>{throw new Error('private-session-value');};
  await assert.rejects(env.session.grantHosts(['www.nature.com']),error=>!error.message.includes('private-session-value'));
  assert.match(env.session.getStatus().error,/加密保存/);assert(!JSON.stringify(env.session.getStatus()).includes('private-session-value'));
  await env.session.destroy().catch(()=>{});assert.equal(env.observers.size,0);
});
