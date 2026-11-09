const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function environment() {
  const logins = [], cookieJar = [], prefs = new Map(), identities = new Map(), observers = new Set(), requests = [];
  let nextID = 5, registered = false;
  const Services = {
    prefs: { getIntPref(key, fallback) { return prefs.get(key) ?? fallback; }, setIntPref(key, value) { prefs.set(key, value); } },
    logins: {
      initializationPromise: Promise.resolve(),
      findLogins(origin, action, realm) { return logins.filter(value => value.origin === origin && value.formActionOrigin === action && value.httpRealm === realm); },
      async addLoginAsync(value) { logins.push(value); },
      modifyLogin(old, value) { logins[logins.indexOf(old)] = value; },
      removeLogin(value) { logins.splice(logins.indexOf(value), 1); },
    },
    cookies: {
      getCookiesFromHost(host, attrs) { return cookieJar.filter(cookie => cookie.originAttributes.userContextId === attrs.userContextId && (host === cookie.host || host.endsWith(cookie.host))); },
      add(host, cookiePath, name, value, isSecure, isHttpOnly, isSession, expiry, originAttributes, sameSite, schemeMap) {
        cookieJar.push({host, path:cookiePath, name, value, isSecure, isHttpOnly, isSession, expiry, originAttributes, sameSite, schemeMap});
      },
    },
    clearData: { deleteDataFromOriginAttributesPattern(attrs, callback) { for (let i=cookieJar.length-1;i>=0;i--) if (cookieJar[i].originAttributes.userContextId === attrs.userContextId) cookieJar.splice(i,1); callback.onDataDeleted(0); } },
    obs: { addObserver(observer) { observers.add(observer); }, removeObserver(observer) { observers.delete(observer); } },
    io: { newURI(spec) { return {spec}; } },
    scriptSecurityManager: { getSystemPrincipal() { return 'system'; } },
  };
  const identityService = { create(name) { const value = {name,userContextId:++nextID}; identities.set(value.userContextId,value); return value; }, getPublicIdentityFromId(id) { return identities.get(id); }, remove(id) { return identities.delete(id); } };
  const Zotero = { Promise:{delay(){return new Promise(()=>{});}}, HTTP:{async request(method,url,options){ requests.push({method,url,options}); return {status:200,response:new ArrayBuffer(5)}; }} };
  const scope = {URL,Promise,Date,JSON,Set,Map,ChromeUtils:{registerWindowActor(){registered=true;},unregisterWindowActor(){registered=false;}},Components:{interfaces:{nsILoginInfo:{}},classes:{'@mozilla.org/login-manager/loginInfo;1':{createInstance(){return {init(origin,formActionOrigin,httpRealm,username,password){Object.assign(this,{origin,formActionOrigin,httpRealm,username,password});}};}}}}};
  for (const name of ['credentials.js','session.js']) vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src',name),'utf8'),scope);
  const credentials = scope.FulltextCredentials.create({Services});
  const makeSession = () => scope.FulltextSession.create({Zotero,Services,rootURI:'file:///plugin/',credentials,contextualIdentityService:identityService});
  function addCookie(id, name, value, isSession = true, host = '.ablesci.com') { Services.cookies.add(host,'/',name,value,true,true,isSession,Math.floor(Date.now()/1000)+3600,{userContextId:id},2,2); }
  function browserFor(session) {
    const attrs=new Map();
    const browser={isConnected:false,setAttribute(k,v){attrs.set(k,v);},getAttribute(k){return attrs.get(k);},currentURI:{spec:'https://www.ablesci.com/site/login'},loadURI(uri){this.currentURI=uri;}};
    session.configureBrowser(browser);
    browser.browsingContext={currentWindowGlobal:{getActor(){return {async sendQuery(name,data){if(name==='Fulltext:FillSavedLogin')return {filled:!!data.password,submitted:false};return {url:browser.currentURI.spec,readyState:'complete'};}};}}};
    return browser;
  }
  return {Services,Zotero,credentials,makeSession,addCookie,browserFor,logins,cookieJar,prefs,identities,observers,requests,isRegistered:()=>registered};
}

test('credentials use isolated Login Manager realms and never disclose passwords in summaries',async()=>{
  const env=environment();
  assert.equal((await env.credentials.getSummary()).saved,false);
  await env.credentials.save({username:' fixture-user ',password:'fictional-password-1'});
  assert.deepEqual(JSON.parse(JSON.stringify(await env.credentials.getSummary())),{saved:true,username:'fixture-user'});
  assert.equal((await env.credentials.getForLogin()).password,'fictional-password-1');
  await env.credentials.save({username:'fixture-user',password:'fictional-password-2'});
  assert.equal(env.logins.length,1);
  await env.credentials.writeSession({version:1,cookies:[{value:'fictional-cookie'}]});
  assert.equal(env.logins.length,2);
  assert.equal((await env.credentials.readSession()).cookies[0].value,'fictional-cookie');
  assert.equal([...env.prefs.values()].some(value=>typeof value==='string'),false);
  await env.credentials.remove();
  assert.equal((await env.credentials.getSummary()).saved,false);
  assert.equal(env.logins.length,1,'Forgetting password must not delete login cookies');
  await env.credentials.clearSession();
  assert.equal(env.logins.length,0);
});

test('persistent container and encrypted session cookies survive a simulated process restart',async()=>{
  const env=environment();
  const first=env.makeSession();
  await first.initialize();
  const id=first.userContextId;
  env.addCookie(id,'session','fictional-session');
  env.addCookie(id,'remember','fictional-remember',false);
  env.addCookie(0,'other','must-stay-out');
  const browser=env.browserFor(first);
  assert.equal((await first.inspect(browser)).sessionScope,'persistent-zotero-profile');
  await first.destroy();
  assert.equal(env.cookieJar.length,3,'Normal plugin shutdown must not log the user out');
  assert.equal(env.observers.size,0);
  for(let i=env.cookieJar.length-1;i>=0;i--)if(env.cookieJar[i].isSession)env.cookieJar.splice(i,1);
  const second=env.makeSession();
  await second.initialize();
  assert.equal(second.userContextId,id);
  assert.equal(env.cookieJar.filter(cookie=>cookie.name==='session').length,1);
  assert.equal(env.cookieJar.filter(cookie=>cookie.name==='remember').length,1);
  assert.equal(env.cookieJar.some(cookie=>cookie.value==='must-stay-out'),false);
  assert(!JSON.stringify(second.getStatus()).includes('fictional'));
  await second.destroy();
});

test('logout removes only its container data and backup, rotates context, and retains saved account',async()=>{
  const env=environment();
  await env.credentials.save({username:'fixture-user',password:'fictional-password'});
  const session=env.makeSession();await session.initialize();
  const oldID=session.userContextId, browser=env.browserFor(session);
  env.addCookie(oldID,'session','fictional-session');env.addCookie(0,'other','other-cookie');
  await session.flush();
  const newID=await session.clearSession();
  assert.notEqual(newID,oldID);
  assert.equal(env.cookieJar.length,1);assert.equal(env.cookieJar[0].originAttributes.userContextId,0);
  assert.equal(await env.credentials.readSession(),null);
  assert.equal((await env.credentials.getSummary()).saved,true);
  assert.throws(()=>session.load(browser,'https://www.ablesci.com/site/login'));
  await session.destroy();
});

test('authenticated binary requests use the container and disable body logging and automatic retries',async()=>{
  const env=environment();const session=env.makeSession();await session.initialize();
  const response=await session.request('GET','https://www.ablesci.com/download/file',{responseType:'arraybuffer',debug:true,logBodyLength:100,userContextId:0,errorDelayMax:999});
  assert.equal(response.response.byteLength,5);
  const options=env.requests[0].options;
  assert.equal(options.userContextId,session.userContextId);assert.equal(options.responseType,'arraybuffer');
  assert.equal(options.debug,false);assert.equal(options.logBodyLength,0);assert.equal(options.errorDelayMax,0);assert.equal(options.noRetryOnThrottle,true);
  await assert.rejects(session.request('GET','https://unrelated.invalid/'));
  await session.destroy();
});

test('stored credentials are filled only into the held AbleSci login page and never submitted',async()=>{
  const env=environment();const session=env.makeSession();await session.initialize();
  await env.credentials.save({username:'fixture-user',password:'fictional-password'});
  const browser=env.browserFor(session);
  const result=await session.fillSavedLogin(browser);assert.equal(result.filled,true);assert.equal(result.submitted,false);
  browser.currentURI.spec='https://www.ablesci.com/assist/detail?id=Fixture';
  await assert.rejects(session.fillSavedLogin(browser));
  await session.destroy();
});

test('logout cancels in-flight authenticated requests and rejects stale results',async()=>{
  const env=environment();const session=env.makeSession();await session.initialize();
  let finish, cancelled=false;
  env.Zotero.HTTP.request=(method,url,options)=>new Promise(resolve=>{finish=resolve;options.cancellerReceiver(()=>{cancelled=true;});});
  const request=session.request('GET','https://www.ablesci.com/assist/detail?id=Fixture');
  await new Promise(resolve=>setImmediate(resolve));
  await session.clearSession();
  assert.equal(cancelled,true);
  finish({status:200});
  await assert.rejects(request,/会话已切换/);
  await session.destroy();
});

test('successful POST remains successful when encrypted cookie backup fails',async()=>{
  const env=environment();const session=env.makeSession();await session.initialize();
  env.addCookie(session.userContextId,'session','fictional-session');
  env.credentials.writeSession=async()=>{throw new Error('simulated vault unavailable');};
  const response=await session.request('POST','https://www.ablesci.com/assist/create',{body:'fixture=only'});
  assert.equal(response.status,200);
  assert(session.getStatus().error);
  assert.equal(env.requests.length,1);
  await assert.rejects(session.destroy());
  assert.equal(env.observers.size,0);
  assert.equal(env.isRegistered(),false);
});

test('logout during encrypted backup cannot return an already received old-account response',async()=>{
  const env=environment();const session=env.makeSession();await session.initialize();
  env.addCookie(session.userContextId,'session','fictional-session');
  let release,started=false;
  const gate=new Promise(resolve=>{release=resolve;});
  env.credentials.writeSession=async()=>{started=true;await gate;};
  const request=session.request('GET','https://www.ablesci.com/my/assist-my');
  while(!started)await new Promise(resolve=>setImmediate(resolve));
  const clearing=session.clearSession();await new Promise(resolve=>setImmediate(resolve));
  release();
  await assert.rejects(request,/会话已切换/);await clearing;
  await session.destroy();
});


test('API keys use separate provider realms and never overwrite AbleSci password or session',async()=>{
  const env=environment();await env.credentials.save({username:'fixture',password:'account-secret'});await env.credentials.writeSession({version:1,cookies:[{value:'session-secret'}]});
  await env.credentials.saveAPIKeys({openalex:' oa-fixture ',core:'core-fixture',semanticScholar:'s2-fixture'});
  assert.equal(await env.credentials.getAPIKey('openalex'),'oa-fixture');assert.equal(env.logins.length,5);assert.equal((await env.credentials.getForLogin()).password,'account-secret');
  assert(!JSON.stringify(await env.credentials.getAPIKeySummary()).includes('fixture'));
  await env.credentials.saveAPIKeys({openalex:'',core:null});assert.equal(await env.credentials.getAPIKey('openalex'),'oa-fixture');assert.equal(await env.credentials.getAPIKey('core'),'');assert.equal((await env.credentials.readSession()).cookies[0].value,'session-secret');
  await assert.rejects(env.credentials.saveAPIKeys({openalex:'must-not-save',unknown:'bad'}));assert.equal(await env.credentials.getAPIKey('openalex'),'oa-fixture');
  await assert.rejects(env.credentials.saveAPIKeys({openalex:'header\ninjection'}));
  await env.credentials.remove();assert.equal(await env.credentials.getAPIKey('semanticScholar'),'s2-fixture');
});
