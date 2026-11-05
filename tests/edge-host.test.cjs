const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/edge-host.js'),'utf8');
const ROOT='C:\\isolated-zotero-profile';
const PROFILE=path.win32.join(ROOT,'fulltext-assistant-edge');
const PORTFILE=path.win32.join(PROFILE,'DevToolsActivePort');
const PORT='49123\n/devtools/browser/12345678-1234-1234-1234-123456789abc\n';
function setup(options={}) {
  const scope={URL,Promise,Date,Map,Set};vm.runInNewContext(source,scope);
  const files=new Map(),directories=new Set([ROOT]),calls=[],launches=[],connections=[],targets=[];
  let clock=0,nextTarget=0,lastCallbacks;
  if(options.portFile)files.set(PORTFILE,options.portFile);
  const io={async realPath(value){return options.redirectProfile&&value===PROFILE?'C:\\outside':value;},async makeDirectory(value){directories.add(value);},async stat(value){if(files.has(value))return {type:options.portSymlink?'symlink':'regular',size:files.get(value).length};if(directories.has(value))return {type:'directory',size:0};throw new Error('not found');},async readUTF8(value){return files.get(value);},async exists(value){return files.has(value)||directories.has(value);},async remove(value){files.delete(value);}};
  const runtime={platform:'WINNT',profileBase:ROOT,now:()=>clock,async delay(ms){clock+=ms;await new Promise(resolve=>setImmediate(resolve));},setTimeout,clearTimeout,commandTimeoutMs:50,startupTimeoutMs:500,
    async checkPolicy(){if(options.denied)throw Object.assign(new Error('policy disabled'),{name:'EdgePolicyError'});},async findExecutable(){return 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';},
    launch(executable,args,onExit){launches.push({executable,args,onExit});if(!options.noPort)files.set(PORTFILE,PORT);return {owned:true};},
    async connect(endpoint,callbacks){connections.push(endpoint);lastCallbacks=callbacks;if(options.connectFails)throw new Error('fixture refused');return {close(){},send(text){
      const request=JSON.parse(text);calls.push(request);if(request.method===options.throwMethod)throw new Error('fixture socket send failed');if(request.method===options.holdMethod)return;
      let result={};
      if(request.method==='Browser.getVersion')result={product:'Edg/fixture'};
      if(request.method==='Target.createTarget'){const targetId='target-'+(++nextTarget);targets.push({targetId,type:'page',url:request.params.url});result={targetId};}
      if(request.method==='Target.getTargets')result={targetInfos:[...targets,{targetId:'worker',type:'service_worker'}]};
      if(request.method==='Target.attachToTarget')result={sessionId:'session-'+request.params.targetId};
      if(request.method==='Target.closeTarget'){const index=targets.findIndex(target=>target.targetId===request.params.targetId);if(index>=0)targets.splice(index,1);result={success:true};}
      queueMicrotask(()=>callbacks.onMessage(JSON.stringify(options.protocolError===request.method?{id:request.id,error:{code:-32000,message:'sensitive-server-detail'}}:{id:request.id,result})));
    }};},
  };
  const host=scope.FulltextEdgeHost.create({Zotero:{},Services:{},IOUtils:io,PathUtils:path.win32,runtime});
  return {host,api:scope.FulltextEdgeHost,runtime,io,files,calls,launches,connections,targets,closeConnection(){lastCallbacks.onClose();},emit(message){lastCallbacks.onMessage(JSON.stringify(message));}};
}
test('active-port parser accepts only a numeric ephemeral port and browser UUID path',()=>{
  const env=setup();assert.equal(env.api.parseActivePort(PORT),'ws://127.0.0.1:49123/devtools/browser/12345678-1234-1234-1234-123456789abc');
  for(const invalid of ['80\n/devtools/browser/12345678-1234-1234-1234-123456789abc','65536\n/devtools/browser/12345678-1234-1234-1234-123456789abc','49123\nws://remote.test/','49123\n/devtools/page/12345678-1234-1234-1234-123456789abc',PORT+'extra'])assert.equal(env.api.parseActivePort(invalid),null);
});
test('open launches only the dedicated persistent profile with argument-array startup',async()=>{
  const env=setup();const page=await env.host.open('http://127.0.0.1:23456/article');assert.equal(page.id,'target-1');assert.equal(page.sessionId,'session-target-1');
  assert.equal(env.launches.length,1);const args=env.launches[0].args;assert(args.includes('--user-data-dir='+PROFILE));assert(args.includes('--remote-debugging-port=0'));assert(args.includes('--no-first-run'));
  assert(!args.some(value=>/remote-allow-origins|user-agent|disable-blink|headless|disable-web-security/i.test(value)));assert.equal(env.host.profileDir,PROFILE);
  await env.host.destroy();assert.equal(env.calls.filter(value=>value.method==='Browser.close').length,1);
});
test('concurrent opens share a single owned browser startup',async()=>{
  const env=setup();const pages=await Promise.all([env.host.open('https://publisher.test/1'),env.host.open('https://publisher.test/2')]);
  assert.equal(env.launches.length,1);assert.equal(new Set(pages.map(value=>value.id)).size,2);await env.host.destroy();
});
test('destroy during stale-port cleanup prevents a new browser launch',async()=>{
  const env=setup({portFile:'stale endpoint'});let cleanupReached,releaseCleanup;
  const reached=new Promise(resolve=>{cleanupReached=resolve;});const released=new Promise(resolve=>{releaseCleanup=resolve;});
  const remove=env.io.remove;env.io.remove=async(...args)=>{cleanupReached();await released;return remove(...args);};
  const opening=assert.rejects(env.host.open('https://publisher.test/'),cause=>cause.name==='EdgeConnectionError');
  await reached;const destroying=env.host.destroy();releaseCleanup();await opening;
  assert.equal((await destroying).closeRequested,false);assert.equal(env.launches.length,0);assert.equal(env.connections.length,0);assert.equal(env.targets.length,0);
});
test('destroy during a launched browser connection completes its handshake and closes only that instance',async()=>{
  const env=setup();let connectionReached,releaseConnection;
  const reached=new Promise(resolve=>{connectionReached=resolve;});const released=new Promise(resolve=>{releaseConnection=resolve;});
  const connect=env.runtime.connect;env.runtime.connect=async(...args)=>{connectionReached();await released;return connect(...args);};
  const opening=assert.rejects(env.host.open('https://publisher.test/'),cause=>cause.name==='EdgeConnectionError');
  await reached;assert.equal(env.launches.length,1);const destroying=env.host.destroy();releaseConnection();await opening;
  assert.equal((await destroying).closeRequested,true);assert.equal(env.launches.length,1);assert.equal(env.connections.length,1);
  assert.deepEqual(env.calls.map(value=>value.method),['Browser.getVersion','Browser.close']);assert.equal(env.targets.length,0);
});
test('destroy while the version handshake is pending waits and does not create an article target',async()=>{
  const env=setup({holdMethod:'Browser.getVersion'});
  const opening=assert.rejects(env.host.open('https://publisher.test/'),cause=>cause.name==='EdgeConnectionError');
  while(!env.calls.some(value=>value.method==='Browser.getVersion'))await new Promise(resolve=>setImmediate(resolve));
  const version=env.calls.find(value=>value.method==='Browser.getVersion');const destroying=env.host.destroy();
  env.emit({id:version.id,result:{product:'Edg/fixture'}});await opening;
  assert.equal((await destroying).closeRequested,true);assert.equal(env.launches.length,1);assert.equal(env.connections.length,1);
  assert.deepEqual(env.calls.map(value=>value.method),['Browser.getVersion','Browser.close']);assert.equal(env.targets.length,0);
});
test('a live endpoint can be resumed only from the dedicated profile port file',async()=>{
  const env=setup({portFile:PORT});await env.host.open('https://publisher.test/');assert.equal(env.launches.length,0);assert.equal(env.connections.length,1);await env.host.destroy();
});
test('invalid or symbolic-link endpoint files are never trusted as a connection address',async()=>{
  const env=setup({portFile:'9222\nws://external.test/bridge'});await env.host.open('https://publisher.test/');assert.equal(env.launches.length,1);assert(env.connections.every(value=>value.startsWith('ws://127.0.0.1:')));await env.host.destroy();
  const links=setup({portFile:PORT,portSymlink:true});await assert.rejects(links.host.open('https://publisher.test/'),cause=>cause.name==='EdgeStartupError');assert.equal(links.connections.length,0);await links.host.destroy();
});
test('profile redirection and organization policy stop before launching any process',async()=>{
  const redirected=setup({redirectProfile:true});await assert.rejects(redirected.host.open('https://publisher.test/'),cause=>cause.name==='EdgeProfileError');assert.equal(redirected.launches.length,0);await redirected.host.destroy();
  const denied=setup({denied:true});await assert.rejects(denied.host.open('https://publisher.test/'),cause=>cause.name==='EdgePolicyError');assert.equal(denied.launches.length,0);await denied.host.destroy();
});
test('runtime canonicalization works without the unavailable Gecko IOUtils.realPath API',async()=>{
  const env=setup();const canonical=[];env.runtime.realPath=value=>{canonical.push(value);return value;};delete env.io.realPath;
  await env.host.open('https://publisher.test/');assert.deepEqual(canonical,[ROOT,PROFILE]);assert.equal(env.launches.length,1);await env.host.destroy();
});
test('native canonicalization failure rejects linked profile paths before launch',async()=>{
  const env=setup();env.runtime.realPath=value=>{if(value===PROFILE)throw Object.assign(new Error('linked'),{name:'EdgeProfileError'});return value;};delete env.io.realPath;
  await assert.rejects(env.host.open('https://publisher.test/'),cause=>cause.name==='EdgeProfileError');assert.equal(env.launches.length,0);await env.host.destroy();
});
test('ordinary URLs and explicit loopback fixtures work; privileged URLs and embedded credentials do not',async()=>{
  const env=setup();for(const invalid of ['file:///C:/private','javascript:alert(1)','https://user:password@publisher.test/'])await assert.rejects(env.host.open(invalid));assert.equal(env.launches.length,0);
  await env.host.open('https://publisher.test/');await assert.rejects(env.host.send('Page.navigate',{url:'file:///C:/private'}));await env.host.destroy();
});
test('session addressing, page discovery, focus and page closing use only this connected browser',async()=>{
  const env=setup();const page=await env.host.open('https://publisher.test/');assert.equal((await env.host.pages()).length,1);await env.host.focus(page);
  const focus=env.calls.find(value=>value.method==='Page.bringToFront');assert.equal(focus.sessionId,page.sessionId);
  await assert.rejects(env.host.attach('not-this-browser'));await env.host.closePage(page);assert.equal((await env.host.pages()).length,0);await env.host.destroy();
});
test('closing the browser rejects pending commands and polling never reopens it',async()=>{
  const env=setup({holdMethod:'Runtime.evaluate'});const page=await env.host.open('https://publisher.test/');const pending=env.host.send('Runtime.evaluate',{expression:'1'},page.sessionId);env.closeConnection();
  const actionable=cause=>cause.name==='EdgeConnectionError'&&/自动获取已停止/.test(cause.message)&&/重试/.test(cause.message)&&/默认浏览器/.test(cause.message);
  await assert.rejects(pending,actionable);await assert.rejects(env.host.pages(),actionable);await assert.rejects(env.host.attach(page.id),actionable);await assert.rejects(env.host.focus(page),actionable);assert.equal(env.launches.length,1);assert.equal(env.connections.length,1);await env.host.destroy();
});
test('a synchronous send failure disconnects all pending calls and clears cached sessions until an explicit reopen',async()=>{
  const options={holdMethod:'Runtime.evaluate',throwMethod:'Page.enable'},env=setup(options);
  const page=await env.host.open('https://publisher.test/');
  const waiting=Promise.allSettled([env.host.send('Runtime.evaluate',{expression:'1'},page.sessionId),env.host.send('Runtime.evaluate',{expression:'2'},page.sessionId)]);
  const actionable=cause=>cause.name==='EdgeConnectionError'&&/自动获取已停止/.test(cause.message)&&/重试/.test(cause.message)&&/默认浏览器/.test(cause.message);
  await assert.rejects(env.host.send('Page.enable',{},page.sessionId),actionable);
  const results=await waiting;assert.equal(results.length,2);for(const result of results){assert.equal(result.status,'rejected');assert(actionable(result.reason));}
  assert.equal(env.host.getStatus().connected,false);assert.match(env.host.getStatus().error,/自动获取已停止/);
  await assert.rejects(env.host.pages(),actionable);await assert.rejects(env.host.attach(page.id),actionable);await assert.rejects(env.host.focus(page),actionable);
  assert.equal(env.launches.length,1);assert.equal(env.connections.length,1);
  delete options.throwMethod;await env.host.open('https://publisher.test/retry');assert.equal(env.connections.length,2);assert.equal(env.launches.length,1);assert.equal(env.host.getStatus().error,null);
  await assert.rejects(env.host.focus(page),cause=>cause.name==='EdgeInputError');await env.host.attach(page.id);
  assert.equal(env.calls.filter(value=>value.method==='Target.attachToTarget'&&value.params.targetId===page.id).length,2);
  await env.host.destroy();
});
test('commands time out and late replies cannot fulfill a different request',async()=>{
  const env=setup({holdMethod:'Runtime.evaluate'});const page=await env.host.open('https://publisher.test/');await assert.rejects(env.host.send('Runtime.evaluate',{},page.sessionId,5),cause=>cause.name==='EdgeTimeoutError');
  const held=env.calls.find(value=>value.method==='Runtime.evaluate');env.emit({id:held.id,result:{ignored:true}});assert.equal((await env.host.pages()).length,1);await env.host.destroy();
});
test('raw cookie access is rejected and protocol errors omit sensitive server text',async()=>{
  const env=setup({protocolError:'Runtime.evaluate'});await env.host.open('https://publisher.test/');
  for(const method of ['Network.getCookies','Network.getAllCookies','Storage.getCookies','Network.setCookie','Storage.setCookies'])await assert.rejects(env.host.send(method),cause=>cause.name==='EdgeInputError');
  await assert.rejects(env.host.send('Runtime.evaluate'),cause=>cause.name==='EdgeProtocolError'&&!cause.message.includes('sensitive-server-detail'));await env.host.destroy();
});
test('event subscriptions are removable and destruction is idempotent',async()=>{
  const env=setup();await env.host.open('https://publisher.test/');let count=0;const unsubscribe=env.host.onEvent(()=>count++);env.emit({method:'Page.loadEventFired',sessionId:'session-target-1',params:{timestamp:1}});assert.equal(count,1);unsubscribe();env.emit({method:'Page.loadEventFired'});assert.equal(count,1);
  const first=env.host.destroy();assert.equal(env.host.destroy(),first);await first;await assert.rejects(env.host.open('https://publisher.test/'));assert.equal(env.calls.filter(value=>value.method==='Browser.close').length,1);
});
