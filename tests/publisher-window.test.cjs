const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/publisher-window.js'),'utf8');
function api(){const scope={URL};vm.runInNewContext(source,scope);return scope.FulltextPublisherWindow;}

test('publisher window inputs accept normal web URLs and reject privileged or executable schemes',()=>{
  const module=api();assert.equal(module.httpURL('https://www.nature.com/articles/nn.4346'),'https://www.nature.com/articles/nn.4346');
  for(const url of ['javascript:alert(1)','file:///C:/secret.txt','chrome://zotero/content/','data:text/html,test','https://user:pass@example.com/','about:blank'])assert.throws(()=>module.httpURL(url));
  assert.equal(module.httpURL('about:blank',true),'about:blank');
});

test('publisher manager keeps an ongoing SSO window for the same task and closes only owned windows',()=>{
  const opened=[];const module=api();
  const Zotero={getMainWindow(){return {openDialog(...args){const win={closed:false,focused:0,document:{documentURI:module.WINDOW_URL},events:{},focus(){this.focused++;},close(){this.closed=true;this.events.unload?.({target:this.document});},addEventListener(name,fn){this.events[name]=fn;},removeEventListener(name,fn){if(this.events[name]===fn)delete this.events[name];}};opened.push({args,win});return win;}};}};
  const manager=module.create({Zotero,Services:{},rootURI:'file:///fixture/'});
  const first=manager.open({url:'https://www.nature.com/articles/nn.4346',taskId:'task1',app:{}});
  assert.equal(manager.open({url:'https://www.nature.com/articles/nn.4346',taskId:'task1'}),first);assert.equal(opened.length,1);assert.equal(first.focused,1);
  assert.equal(opened[0].args[0],'chrome://fulltext-assistant/content/ui/publisher-browser.xhtml');assert.equal(opened[0].args[3].url,'https://www.nature.com/articles/nn.4346');
  manager.open({url:'https://publisher.test/another',taskId:'task2'});manager.destroy();assert.ok(opened.every(({win})=>win.closed));assert.throws(()=>manager.open({url:'https://publisher.test/'}));
});

test('embedded navigation cannot remove an owned publisher window before manager destruction',()=>{
  const module=api(),events=new Map();
  const win={closed:false,document:{documentURI:module.WINDOW_URL},focus(){},close(){this.closed=true;events.get('unload')?.({target:this.document});},addEventListener(name,fn){events.set(name,fn);},removeEventListener(name,fn){if(events.get(name)===fn)events.delete(name);}};
  const manager=module.create({Zotero:{getMainWindow:()=>({openDialog:()=>win})},Services:{},rootURI:'file:///fixture/'});
  manager.open({url:'https://www.nature.com/articles/nn.4346',taskId:'same-task'});
  events.get('unload')({target:{documentURI:'about:blank'}});
  events.get('unload')({target:{documentURI:'https://www.nature.com/articles/nn.4346'}});
  assert.equal(manager.open({url:'https://www.nature.com/articles/nn.4346',taskId:'same-task'}),win);
  manager.destroy();assert.equal(win.closed,true);assert.equal(events.has('unload'),false);
});

test('window lifecycle once handlers ignore child events and the initial chrome about:blank',()=>{
  const module=api(),listeners=new Map();let calls=0;
  const win={document:{documentURI:'about:blank'},addEventListener(name,fn){listeners.set(name,fn);},removeEventListener(name,fn){if(listeners.get(name)===fn)listeners.delete(name);}};
  module.onChromeDocumentEvent(win,'load',()=>calls++,true);
  listeners.get('load')({target:win.document});assert.equal(calls,0);assert.equal(listeners.has('load'),true);
  win.document={documentURI:module.WINDOW_URL};
  listeners.get('load')({target:{documentURI:'https://idp.example.edu/login'}});assert.equal(calls,0);assert.equal(listeners.has('load'),true);
  // Matching the chrome URI alone is insufficient: it must be this window's document.
  listeners.get('load')({target:{documentURI:module.WINDOW_URL}});assert.equal(calls,0);
  listeners.get('load')({target:win.document});assert.equal(calls,1);assert.equal(listeners.has('load'),false);
});

function browserEnvironment(){
  const created=[];
  const Components={interfaces:{nsIBrowserDOMWindow:{OPEN_PRINT_BROWSER:99,OPEN_NO_REFERRER:8},nsIReferrerInfo:{EMPTY:0}},Constructor(){return function(policy,sendReferrer,uri){Object.assign(this,{policy,sendReferrer,uri});};}};
  const Services={io:{newURI(spec){return {spec};}},scriptSecurityManager:{getSystemPrincipal(){return 'system';}}};
  const access=api().createBrowserAccess({win:{document:{querySelectorAll(){return created;}}},Services,Components,ChromeUtils:{generateQI(){return ()=>{};}},
    createBrowser(options){const browser={options,browsingContext:{id:created.length+1},loads:[],loadURI(uri,args){this.loads.push({uri,args});}};created.push(browser);return browser;}});
  return {access,created};
}

test('target-blank navigation stays in an in-window browser and preserves SSO principal/referrer',()=>{
  const {access,created}=browserEnvironment();const info={openerBrowser:{id:'parent'},parent:{window:{document:{referrerInfo:{referrerPolicy:4}},location:{href:'https://www.nature.com/articles/nn.4346'}}}};
  const context=access.openURI({spec:'https://idp.example.edu/sso'},info,3,0,'originating-principal','content-csp');
  assert.equal(context,created[0].browsingContext);assert.equal(created[0].options.openWindowInfo,info);
  assert.equal(created[0].loads[0].args.triggeringPrincipal,'originating-principal');assert.equal(created[0].loads[0].args.csp,'content-csp');assert.equal(created[0].loads[0].args.referrerInfo.uri.spec,'https://www.nature.com/articles/nn.4346');
  assert.equal(access.tabCount,1);
});

test('window.open creation preserves opener without overriding Geckos eventual POST or navigation',()=>{
  const {access,created}=browserEnvironment();const info={parent:{}};
  const context=access.createContentWindow({spec:'https://idp.example.edu/post-login'},info,3,0,'principal',null);
  assert.equal(context,created[0].browsingContext);assert.equal(created[0].options.openWindowInfo,info);assert.equal(created[0].loads.length,0);
  const params={openWindowInfo:info,remoteType:'webIsolated=https://idp.example.edu',triggeringPrincipal:'remote-principal',referrerInfo:{policy:7},csp:'csp'};
  const browser=access.createContentWindowInFrame({spec:'about:blank'},params,3,0,'login-popup');
  assert.equal(browser,created[1]);assert.equal(browser.options.openWindowInfo,info);assert.equal(browser.options.remoteType,params.remoteType);assert.equal(browser.loads.length,0);
});

test('remote-frame navigation returns the browser and does not leak a forbidden referrer',()=>{
  const {access,created}=browserEnvironment();const params={openWindowInfo:{},triggeringPrincipal:'remote-principal',referrerInfo:{secret:'must not be reused'},csp:'csp'};
  const browser=access.openURIInFrame({spec:'https://idp.example.edu/login'},params,3,8,'');
  assert.equal(browser,created[0]);assert.equal(browser.loads[0].args.triggeringPrincipal,'remote-principal');assert.equal(browser.loads[0].args.referrerInfo.sendReferrer,false);
  assert.throws(()=>access.openURI({spec:'file:///C:/secret.txt'},null,3,0,null,null));assert.equal(created.length,1);
});
