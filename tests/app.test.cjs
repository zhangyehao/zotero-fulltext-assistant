const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const MODEL = require('../src/task-model.js');
const appSource = fs.readFileSync(path.join(__dirname,'../src/app.js'),'utf8');
const publisherSource = fs.readFileSync(path.join(__dirname,'../src/publisher.js'),'utf8');
const publisherWindowSource = fs.readFileSync(path.join(__dirname,'../src/publisher-window.js'),'utf8');
const queuePath = path.win32.join('C:\\isolated','fulltext-assistant','tasks.json');
const intentPath = path.win32.join('C:\\isolated','fulltext-assistant','submission-intents.json');
const deferred = () => {let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const settle = () => new Promise(resolve=>setImmediate(resolve));
async function until(condition) {const end=Date.now()+2000;while(!condition()){if(Date.now()>end)throw new Error('Fixture condition timed out');await settle();}}
function item(id) {return {id,key:'ITEM'+id,libraryID:1,deleted:false,isRegularItem:()=>true,getAttachments:()=>[],async getBestAttachment(){return null;},getField(name){return {DOI:'10.1234/paper'+id,title:'Fixture paper '+id,url:'https://publisher.test/paper'+id}[name]||'';}};}

function environment({acquire,initialTasks,initialIntents,realPublisher=false,writePDFError=false}={}) {
  const files=new Map(),prefs=new Map(),items=new Map(),menus=new Map(),publisherCalls=[],submissions=[],remoteRequests=[],errors=[],httpCalls=[],imports=[];
  let accountCalls=0,active=0,peak=0,writeHook=null,importCount=0,oaCalls=0;
  if(initialTasks)files.set(queuePath,MODEL.serializeQueue(initialTasks));
  if(initialIntents)files.set(intentPath,JSON.stringify(initialIntents));
  const account={authenticated:true,accountID:'FixtureAccount',username:'Display Name'};
  const session={destroyed:false,cleared:0,async initialize(){},getStatus(){return {hasCookies:false,persistent:true};},async flush(){},async destroy(){this.destroyed=true;},async clearSession(){this.cleared++;},async request(){throw new Error('No real request permitted in app fixture');}};
  const credentials={saved:false,username:'',async getSummary(){return {saved:this.saved,username:this.username};},async save(value){this.saved=true;this.username=value.username;},async remove(){this.saved=false;this.username='';}};
  const adapter={async getAccount(){accountCalls++;return account;},async findExistingRequest(){return null;},async submitRequest(value){submissions.push(value);return {requestID:'Request'+submissions.length,requestURL:'https://www.ablesci.com/assist/detail?id=Request'+submissions.length};},async getRequest(id){remoteRequests.push(id);return {requestID:id,doi:submissions[Number(id.replace('Request',''))-1]?.doi||'',state:'waiting',files:[]};},async listMessages(){return [];}};
  const IOUtils={async exists(file){return files.has(file);},async readUTF8(file){return files.get(file);},async makeDirectory(){},async writeUTF8(file,value){if(writeHook)await writeHook(file,value);files.set(file,value);},async write(file,value){if(writePDFError)throw new Error('fixture disk full');files.set(file,value);},async remove(file){files.delete(file);}};
  const Services={prefs:{getIntPref(key,fallback){return prefs.get(key)??fallback;},getBoolPref(key,fallback){return prefs.get(key)??fallback;},setIntPref(key,value){prefs.set(key,value);},setBoolPref(key,value){prefs.set(key,value);}},prompt:{alert(){}}};
  const pdf=new TextEncoder().encode('%PDF-1.7\n'+'0'.repeat(1200)+'\n%%EOF\n');
  const Zotero={DataDirectory:{dir:'C:\\isolated'},Items:{async getAsync(id){return items.get(id);}},Libraries:{get(){return {editable:true,filesEditable:true};}},MenuManager:{registerMenu(value){menus.set(value.menuID,value);return value.menuID;},unregisterMenu(id){menus.delete(id);}},PreferencePanes:{async register(value){return value.id;}},Utilities:{Internal:{openPreferences(){}}},getMainWindow(){return {openDialog(){return {closed:false,close(){this.closed=true;},focus(){}};}};},logError(error){errors.push(error);},Promise:{delay(ms){return new Promise(resolve=>setTimeout(resolve,Math.min(ms,5)));}},HTTP:{async request(method,url){httpCalls.push({method,url});return {status:200,response:pdf.buffer,responseURL:url,getResponseHeader(){return 'application/pdf';}};}},Attachments:{async createTemporaryStorageDirectory(){return {path:'C:\\isolated\\publisher-temp'};},async importFromFile(options){importCount++;imports.push(options);return {id:900,setField(){},async saveTx(){}};},getFileBaseNameFromItem(){return 'fixture-paper';},getFileResolvers(){oaCalls++;return [];}}};
  const scope={URL,URLSearchParams,Promise,Date,JSON,Set,Map,Uint8Array,ArrayBuffer,TextDecoder,FulltextTaskModel:MODEL,FulltextPublisherWindow:{create(){return {open(){},destroy(){}};}},setInterval(){return 1;},clearInterval(){},FulltextCredentials:{create(){return credentials;}},FulltextSession:{create(){return session;}},FulltextAbleSci:{create(){return adapter;}}};
  vm.runInNewContext(publisherSource,scope);
  vm.runInNewContext(publisherWindowSource,scope);
  if(!realPublisher)scope.FulltextPublisher={validPDF:scope.FulltextPublisher.validPDF,create(){return {async acquire(value,options){publisherCalls.push({item:value,options});active++;peak=Math.max(peak,active);try{return await(acquire?acquire(value,options):{attachmentID:800+value.id,source:'publisher'});}finally{active--;}}};}};
  vm.runInNewContext(appSource,scope);
  const app=scope.FulltextApp.create({Zotero,Services,IOUtils,PathUtils:path.win32,rootURI:'file:///fixture/',pluginID:'fixture@local.invalid',version:'0.2.0'});
  return {app,Zotero,Services,IOUtils,files,prefs,items,menus,publisherCalls,submissions,remoteRequests,errors,httpCalls,imports,session,credentials,adapter,account,addItem(value){items.set(value.id,value);return value;},setWriteHook(value){writeHook=value;},get accountCalls(){return accountCalls;},get peak(){return peak;},get importCount(){return importCount;},get oaCalls(){return oaCalls;}};
}

test('retry refreshes a DOI corrected in the original Zotero item',async()=>{
  let doi='';const env=environment({acquire:async()=>({state:'not_found',message:'fixture unavailable'})});
  const parent=item(1),originalGetField=parent.getField;parent.getField=name=>name==='DOI'?doi:originalGetField(name);env.addItem(parent);
  await env.app.start();await env.app.captureItems([parent]);await until(()=>env.app.getSelectedTask().state==='not_found');
  assert.equal(env.app.getSelectedTask().doi,'');doi='10.1234/corrected';
  await env.app.retryTask(env.app.getSelectedTask().id);await until(()=>env.app.getSelectedTask().state==='not_found'&&env.app.getSelectedTask().doi===doi);
  await env.app.requestAssist(env.app.getSelectedTask().id);await until(()=>env.submissions.length===1);
  assert.equal(env.submissions[0].doi,doi);await env.app.stop();
});

test('batch queue runs at most two publisher acquisitions concurrently',async()=>{
  const releases=new Map();
  const env=environment({acquire:async value=>{const gate=deferred();releases.set(value.id,gate);await gate.promise;return {attachmentID:100+value.id,source:'publisher'};}});
  await env.app.start();
  await env.app.captureItems([1,2,3,4].map(id=>env.addItem(item(id))));
  await until(()=>releases.size===2);assert.equal(env.peak,2);assert.equal(env.publisherCalls.length,2);
  releases.get(1).resolve();releases.get(2).resolve();await until(()=>releases.size===4);
  releases.get(3).resolve();releases.get(4).resolve();await until(()=>env.app.getSnapshot().tasks.every(value=>value.state==='imported'));
  assert.equal(env.peak,2);assert.equal(env.submissions.length,0);await env.app.stop();
});

test('public full text is acquired without checking or requiring an AbleSci account',async()=>{
  const env=environment();env.adapter.getAccount=async()=>{throw new Error('Account must not be consulted');};
  await env.app.start();await env.app.captureItems([env.addItem(item(1))]);
  await until(()=>env.app.getSelectedTask().state==='imported');
  assert.equal(env.app.getSelectedTask().source,'publisher');assert.equal(env.accountCalls,0);assert.equal(env.submissions.length,0);await env.app.stop();
});

test('existing PDF is skipped by the real publisher without HTTP or duplicate import',async()=>{
  const env=environment({realPublisher:true});const parent=env.addItem(item(1));parent.getAttachments=()=>[99];
  env.items.set(99,{id:99,attachmentContentType:'application/pdf',async getFilePathAsync(){return 'C:\\isolated\\existing.pdf';}});env.files.set('C:\\isolated\\existing.pdf','fixture');
  await env.app.start();await env.app.captureItems([parent],{allowAssist:true});await until(()=>env.app.getSelectedTask().state==='imported');
  assert.equal(env.app.getSelectedTask().attachmentID,99);assert.equal(env.app.getSelectedTask().source,'existing');assert.equal(env.httpCalls.length,0);assert.equal(env.importCount,0);assert.equal(env.accountCalls,0);await env.app.stop();
});

test('real publisher storage failure is surfaced as an error and never starts paid fallback',async()=>{
  const env=environment({realPublisher:true,writePDFError:true});await env.app.start();await env.app.captureItems([env.addItem(item(1))],{allowAssist:true});
  await until(()=>['error','not_found','submission_unknown','waiting'].includes(env.app.getSelectedTask().state));
  assert.equal(env.app.getSelectedTask().state,'error');assert.match(env.app.getSelectedTask().lastError,/写入或导入 Zotero 失败/);
  assert.equal(env.httpCalls.length,1);assert.equal(env.importCount,0);assert.equal(env.oaCalls,0);assert.equal(env.accountCalls,0);assert.equal(env.submissions.length,0);await env.app.stop();
});

test('pause while publisher is active blocks a later fallback POST',async()=>{
  const gate=deferred();const env=environment({acquire:async()=>{await gate.promise;return {state:'not_found',message:'fixture unavailable'};}});
  await env.app.start();await env.app.captureItems([env.addItem(item(1))],{allowAssist:true});await until(()=>env.publisherCalls.length===1);
  const id=env.app.getSelectedTask().id;await env.app.pauseTask(id);gate.resolve();await settle();await settle();
  assert.equal(env.app.getSelectedTask().state,'paused');assert.equal(env.submissions.length,0);assert.equal(env.accountCalls,0);await env.app.stop();
});

test('stopping the plugin during acquisition prevents all later POSTs',async()=>{
  const gate=deferred();const env=environment({acquire:async()=>{await gate.promise;return {state:'not_found',message:'fixture unavailable'};}});
  await env.app.start();await env.app.captureItems([env.addItem(item(1))],{allowAssist:true});await until(()=>env.publisherCalls.length===1);
  await env.app.stop();gate.resolve();await settle();await settle();assert.equal(env.submissions.length,0);assert.equal(env.session.destroyed,true);assert.equal(env.menus.size,0);
});

test('pause while submitting state is being saved prevents the submission call',async()=>{
  const gate=deferred();let held=false;
  const env=environment({acquire:async()=>({state:'not_found',message:'fixture unavailable'})});
  await env.app.start();env.setWriteHook(async(file,value)=>{if(!held&&file===queuePath&&JSON.parse(value).tasks.some(task=>task.state==='submitting')){held=true;await gate.promise;}});
  await env.app.captureItems([env.addItem(item(1))],{allowAssist:true});await until(()=>held);
  const pause=env.app.pauseTask(env.app.getSelectedTask().id);gate.resolve();await pause;await settle();await settle();
  assert.equal(env.submissions.length,0);assert.equal(env.app.getSelectedTask().state,'paused');await env.app.stop();
});

test('restart converts an in-flight submission to unknown and does not automatically resubmit',async()=>{
  const saved=MODEL.createTask({libraryID:1,itemID:1,itemKey:'ITEM1',doi:'10.1234/paper1',title:'Fixture',state:'submitting',requestedPoints:10,allowAssist:true});
  const env=environment({initialTasks:[saved]});env.addItem(item(1));await env.app.start();await settle();
  assert.equal(env.app.getSnapshot().tasks[0].state,'submission_unknown');assert.equal(JSON.parse(env.files.get(queuePath)).tasks[0].state,'submission_unknown');
  assert.equal(env.publisherCalls.length,0);assert.equal(env.submissions.length,0);await env.app.stop();
});

test('task points remain a snapshot after global settings change and are used at submission',async()=>{
  const env=environment({acquire:async()=>({state:'not_found',message:'fixture unavailable'})});await env.app.start();
  await env.app.captureItems([env.addItem(item(1))]);await until(()=>env.app.getSelectedTask().state==='not_found');const firstID=env.app.getSelectedTask().id;
  await env.app.saveSettings({points:35,pollSeconds:60,autoDownload:true});await env.app.captureItems([env.addItem(item(2))]);await until(()=>env.app.getSelectedTask().state==='not_found');
  assert.equal(env.app.getSnapshot().tasks.find(value=>value.id===firstID).requestedPoints,10);assert.equal(env.app.getSelectedTask().requestedPoints,35);
  await env.app.requestAssist(firstID);await until(()=>env.submissions.length===1);await until(()=>env.app.getSnapshot().tasks.find(value=>value.id===firstID).state==='waiting');
  assert.equal(env.submissions[0].points,10);await env.app.stop();
});

test('explicit fallback points update only the selected unsent task budget',async()=>{
  const env=environment({acquire:async()=>({state:'not_found',message:'fixture unavailable'})});await env.app.start();
  await env.app.captureItems([1,2].map(id=>env.addItem(item(id))));await until(()=>env.app.getSnapshot().tasks.every(t=>t.state==='not_found'));
  const [first,second]=env.app.getSnapshot().tasks;
  await env.app.requestAssist(first.id,{points:35});await until(()=>env.submissions.length===1);
  assert.equal(env.submissions[0].points,35);assert.equal(env.app.getSnapshot().tasks.find(t=>t.id===second.id).requestedPoints,10);
  await until(()=>env.app.getSnapshot().tasks.find(t=>t.id===first.id).state==='waiting');
  await env.app.retryTask(first.id,{points:60});await until(()=>env.app.getSnapshot().tasks.find(t=>t.id===first.id).state==='waiting');
  assert.equal(env.app.getSnapshot().tasks.find(t=>t.id===first.id).requestedPoints,35);assert.equal(env.submissions.length,1);await env.app.stop();
});

test('bulk fallback accepts only unresolved tasks and preserves per-task budgets',async()=>{
  const env=environment({acquire:async()=>({state:'not_found',message:'fixture unavailable'})});await env.app.start();
  await env.app.captureItems([1,2].map(id=>env.addItem(item(id))));
  await until(()=>env.app.getSnapshot().tasks.every(t=>t.state==='not_found'));
  const ids=env.app.getSnapshot().tasks.map(t=>t.id);
  await env.app.saveSettings({points:25});
  const result=await env.app.requestAssist([...ids,ids[0]]);
  assert.equal(result.accepted,2);assert.equal(result.skipped,0);
  await until(()=>env.app.getSnapshot().tasks.every(t=>t.state==='waiting'));
  assert.equal(env.submissions.length,2);assert.ok(env.submissions.every(t=>t.points===10));
  const again=await env.app.requestAssist(ids);assert.equal(again.accepted,0);assert.equal(again.skipped,2);
  assert.equal(env.submissions.length,2);await env.app.stop();
});

test('bulk fallback cannot queue completed, missing-DOI or uncertain submissions',async()=>{
  const states=['imported','submission_unknown','needs_review','submitting'];
  const initialTasks=states.map((state,index)=>MODEL.createTask({libraryID:1,itemID:index+1,itemKey:'ITEM'+(index+1),doi:index===2?'':'10.1234/paper'+(index+1),title:'Fixture',state,requestedPoints:10}));
  const env=environment({initialTasks});await env.app.start();
  const result=await env.app.requestAssist(initialTasks.map(t=>t.id));
  assert.equal(result.accepted,0);assert.equal(result.skipped,4);
  await settle();assert.equal(env.publisherCalls.length,0);assert.equal(env.submissions.length,0);await env.app.stop();
});

function remoteFixture(state='available') {
  return MODEL.createTask({libraryID:1,itemID:1,itemKey:'ITEM1',doi:'10.1234/paper1',title:'Fixture',state,requestedPoints:10,requestURL:'https://www.ablesci.com/assist/detail?id=Request1'});
}
function availableDownload(env,{expectedSize=null,allowedOrigins=['https://download.test']}={}) {
  const file={fileID:'File1',filename:'paper.pdf',status:'accept',downloadURL:'https://www.ablesci.com/assist/download?id=File1'};
  env.adapter.getRequest=async id=>{env.remoteRequests.push(id);return {requestID:id,doi:'10.1234/paper1',state:'available',files:[file]};};
  env.adapter.getDownload=async(result,selected)=>{assert.equal(result.requestID,'Request1');assert.equal(selected,file);return {url:'https://download.test/paper.pdf',method:'GET',resolved:true,costPoints:0,expectedSize,allowedOrigins};};
}

test('manual download works with automatic download disabled and imports under the linked parent',async()=>{
  const env=environment({initialTasks:[remoteFixture()]});const parent=env.addItem(item(1));availableDownload(env);
  await env.app.start();await env.app.saveSettings({autoDownload:false});await env.app.downloadTask(env.app.getSnapshot().tasks[0].id);
  const task=env.app.getSnapshot().tasks[0];assert.equal(task.state,'imported');assert.equal(task.source,'ablesci');assert.equal(task.attachmentID,900);
  assert.equal(env.importCount,1);assert.equal(env.imports[0].parentItemID,parent.id);assert.equal(env.imports[0].contentType,'application/pdf');assert.equal(env.submissions.length,0);await env.app.stop();
});

test('remote download rejects changed parent identity before fetching the file',async()=>{
  const env=environment({initialTasks:[remoteFixture()]});const parent=env.addItem(item(1));parent.key='REPLACED';availableDownload(env);
  await env.app.start();await env.app.downloadTask(env.app.getSnapshot().tasks[0].id);
  assert.equal(env.app.getSnapshot().tasks[0].state,'error');assert.equal(env.importCount,0);assert.equal(env.httpCalls.length,0);await env.app.stop();
});

test('remote download rejects a size mismatch even when PDF magic and EOF look valid',async()=>{
  const env=environment({initialTasks:[remoteFixture()]});env.addItem(item(1));availableDownload(env,{expectedSize:55555});
  await env.app.start();await env.app.downloadTask(env.app.getSnapshot().tasks[0].id);
  assert.equal(env.app.getSnapshot().tasks[0].state,'error');assert.equal(env.importCount,0);await env.app.stop();
});

test('remote download rejects a final redirect outside verified download origins',async()=>{
  const env=environment({initialTasks:[remoteFixture()]});env.addItem(item(1));availableDownload(env);
  const request=env.Zotero.HTTP.request;env.Zotero.HTTP.request=async(...args)=>({...await request(...args),responseURL:'https://unexpected.test/paper.pdf'});
  await env.app.start();await env.app.downloadTask(env.app.getSnapshot().tasks[0].id);
  assert.equal(env.app.getSnapshot().tasks[0].state,'error');assert.equal(env.importCount,0);await env.app.stop();
});

test('restart resumes an interrupted remote download without publishing another request',async()=>{
  const env=environment({initialTasks:[remoteFixture('downloading')]});env.addItem(item(1));availableDownload(env);
  await env.app.start();await until(()=>env.app.getSnapshot().tasks[0].state==='pending_login');
  assert.equal(env.submissions.length,0);assert.equal(env.publisherCalls.length,0);assert.equal(env.app.getSnapshot().tasks[0].requestID,'Request1');
  await env.app.downloadTask(env.app.getSnapshot().tasks[0].id);assert.equal(env.app.getSnapshot().tasks[0].state,'imported');assert.equal(env.submissions.length,0);await env.app.stop();
});

test('changing the saved username clears the old authenticated session before opening login',async()=>{
  const env=environment();env.credentials.saved=true;env.credentials.username='old-account';await env.app.start();await env.app.refreshAccount();
  assert.equal(env.app.getSnapshot().session.status,'authenticated');await env.app.saveCredentialsAndLogin({username:'new-account',password:'fictional-new-password'});
  assert.equal(env.session.cleared,1);assert.equal(env.app.getSnapshot().session.username,'new-account');assert.notEqual(env.app.getSnapshot().session.status,'authenticated');await env.app.stop();
});

test('logout invalidates an active publisher task before it can spend points on fallback',async()=>{
  const gate=deferred();const env=environment({acquire:async()=>{await gate.promise;return {state:'not_found',message:'fixture unavailable'};}});
  await env.app.start();await env.app.refreshAccount();await env.app.captureItems([env.addItem(item(1))],{allowAssist:true});await until(()=>env.publisherCalls.length===1);
  await env.app.logout();gate.resolve();for(let n=0;n<8;n++)await settle();
  assert.equal(env.submissions.length,0);assert.equal(env.app.getSelectedTask().state,'paused');assert.equal(env.app.getSnapshot().session.status,'signed_out');await env.app.stop();
});

test('a delayed account response cannot restore authenticated status after logout',async()=>{
  const gate=deferred();const env=environment();env.adapter.getAccount=async()=>gate.promise;await env.app.start();
  const refresh=env.app.refreshAccount();await settle();await env.app.logout();gate.resolve({authenticated:true,accountID:'OldAccount',username:'Old Display Name'});
  await refresh.catch(()=>{});assert.equal(env.app.getSnapshot().session.status,'signed_out');assert.notEqual(env.app.getSnapshot().session.displayName,'Old Display Name');await env.app.stop();
});

test('a delayed message response cannot reveal old account messages after logout',async()=>{
  const gate=deferred();const env=environment();await env.app.start();await env.app.refreshAccount();env.adapter.listMessages=async()=>gate.promise;
  const refresh=env.app.refreshMessages();await settle();await env.app.logout();gate.resolve([{id:'old-account-message',title:'Old account fixture message'}]);
  await refresh.catch(()=>{});assert.equal(env.app.getSnapshot().messages.length,0);assert.equal(env.app.getSnapshot().session.status,'signed_out');await env.app.stop();
});

test('known points preflight rejection is an ordinary error and remains safely retryable',async()=>{
  const env=environment({acquire:async()=>({state:'not_found',message:'fixture unavailable'})});
  env.adapter.submitRequest=async()=>{const error=new Error('Website minimum is 20; no request was posted');error.code='POINTS_TOO_LOW';throw error;};
  await env.app.start();await env.app.captureItems([env.addItem(item(1))],{allowAssist:true});await until(()=>['error','submission_unknown'].includes(env.app.getSelectedTask().state));
  assert.equal(env.app.getSelectedTask().state,'error');assert.equal(env.app.getSelectedTask().requestID,'');assert.equal(env.submissions.length,0);await env.app.stop();
});

test('logout preserves uncertain submission status so retry still reconciles instead of republishing',async()=>{
  const uncertain=MODEL.createTask({libraryID:1,itemID:1,itemKey:'ITEM1',doi:'10.1234/paper1',title:'Fixture',state:'submission_unknown',requestedPoints:10,allowAssist:true});
  const env=environment({initialTasks:[uncertain]});env.addItem(item(1));await env.app.start();await env.app.logout();
  assert.equal(env.app.getSnapshot().tasks[0].state,'submission_unknown');
  await assert.rejects(env.app.retryTask(uncertain.id));assert.equal(env.publisherCalls.length,0);assert.equal(env.submissions.length,0);await env.app.stop();
});

test('detecting an on-site account switch pauses old fallback tasks and clears old messages',async()=>{
  const gate=deferred();const env=environment({acquire:async()=>{await gate.promise;return {state:'not_found',message:'fixture unavailable'};}});
  await env.app.start();await env.app.refreshAccount();env.adapter.listMessages=async()=>[{id:'old-message',title:'Old account message'}];await env.app.refreshMessages();
  await env.app.captureItems([env.addItem(item(1))],{allowAssist:true});await until(()=>env.publisherCalls.length===1);
  env.account.accountID='DifferentAccount';env.account.username='Different Display';await env.app.refreshAccount();gate.resolve();for(let n=0;n<8;n++)await settle();
  assert.equal(env.app.getSelectedTask().state,'paused');assert.equal(env.app.getSnapshot().messages.length,0);assert.equal(env.app.getSnapshot().session.accountID,'DifferentAccount');assert.equal(env.submissions.length,0);await env.app.stop();
});

test('remote attachment download respects read-only library permissions',async()=>{
  const env=environment({initialTasks:[remoteFixture()]});env.addItem(item(1));availableDownload(env);env.Zotero.Libraries.get=()=>({editable:false,filesEditable:false});
  await env.app.start();await env.app.downloadTask(env.app.getSnapshot().tasks[0].id);
  assert.equal(env.app.getSnapshot().tasks[0].state,'error');assert.equal(env.importCount,0);assert.equal(env.httpCalls.length,0);await env.app.stop();
});

test('remote attachment download rechecks parent identity after the file response',async()=>{
  const env=environment({initialTasks:[remoteFixture()]});const parent=env.addItem(item(1));availableDownload(env);
  const request=env.Zotero.HTTP.request;env.Zotero.HTTP.request=async(...args)=>{const result=await request(...args);parent.key='REPLACED_DURING_DOWNLOAD';return result;};
  await env.app.start();await env.app.downloadTask(env.app.getSnapshot().tasks[0].id);
  assert.equal(env.app.getSnapshot().tasks[0].state,'error');assert.equal(env.importCount,0);await env.app.stop();
});

test('remote download rejects a changed live parent DOI before fetching a file',async()=>{
  const env=environment({initialTasks:[remoteFixture()]});const parent=env.addItem(item(1));availableDownload(env);
  const original=parent.getField;parent.getField=name=>name==='DOI'?'10.1234/different':original(name);
  await env.app.start();await env.app.downloadTask(env.app.getSnapshot().tasks[0].id);
  assert.equal(env.app.getSnapshot().tasks[0].state,'error');assert.match(env.app.getSnapshot().tasks[0].lastError,/DOI/);
  assert.equal(env.httpCalls.length,0);assert.equal(env.importCount,0);await env.app.stop();
});

test('remote download rechecks the live parent DOI after the file response',async()=>{
  const env=environment({initialTasks:[remoteFixture()]});const parent=env.addItem(item(1));availableDownload(env);
  const request=env.Zotero.HTTP.request,original=parent.getField;
  env.Zotero.HTTP.request=async(...args)=>{const result=await request(...args);parent.getField=name=>name==='DOI'?'10.1234/different':original(name);return result;};
  await env.app.start();await env.app.downloadTask(env.app.getSnapshot().tasks[0].id);
  assert.equal(env.app.getSnapshot().tasks[0].state,'error');assert.equal(env.httpCalls.length,1);assert.equal(env.importCount,0);await env.app.stop();
});

test('the remote DOI also protects tasks originally linked without a DOI',async()=>{
  const task=MODEL.updateTask(remoteFixture(),{doi:''}),env=environment({initialTasks:[task]});const parent=env.addItem(item(1));availableDownload(env);
  let doi='';const original=parent.getField;parent.getField=name=>name==='DOI'?doi:original(name);
  const download=env.adapter.getDownload;env.adapter.getDownload=async(...args)=>{const result=await download(...args);doi='10.1234/different';return result;};
  await env.app.start();await env.app.downloadTask(task.id);
  assert.equal(env.app.getSnapshot().tasks[0].state,'error');assert.equal(env.httpCalls.length,0);assert.equal(env.importCount,0);await env.app.stop();
});

test('associating the same request is idempotent and a different request cannot overwrite it',async()=>{
  const task=remoteFixture('paused'),env=environment({initialTasks:[task]});env.addItem(item(1));await env.app.start();
  assert.equal((await env.app.addExistingRequest(task.requestURL,task.id)).id,task.id);
  await assert.rejects(env.app.addExistingRequest('https://www.ablesci.com/assist/detail?id=OtherRequest',task.id),/已关联另一个求助/);
  assert.equal(env.app.getSnapshot().tasks.length,1);assert.equal(env.remoteRequests.length,0);assert.equal(env.app.getSnapshot().tasks[0].state,'paused');await env.app.stop();
});

test('a running task cannot be manually associated with an existing request',async()=>{
  const gate=deferred(),env=environment({acquire:async()=>{await gate.promise;return {state:'not_found'};}});await env.app.start();await env.app.captureItems([env.addItem(item(1))]);
  await until(()=>env.publisherCalls.length===1);const task=env.app.getSelectedTask();
  await assert.rejects(env.app.addExistingRequest('https://www.ablesci.com/assist/detail?id=Request1',task.id),/正在处理/);
  assert.equal(env.remoteRequests.length,0);await env.app.pauseTask(task.id);gate.resolve();await settle();await env.app.stop();
});

test('association rechecks a target that starts running while the request page is loading',async()=>{
  const task=MODEL.createTask({libraryID:1,itemID:1,itemKey:'ITEM1',doi:'10.1234/paper1',state:'not_found'}),remoteGate=deferred(),publisherGate=deferred();
  const env=environment({initialTasks:[task],acquire:async()=>{await publisherGate.promise;return {state:'not_found'};}});env.addItem(item(1));env.adapter.getRequest=async()=>remoteGate.promise;
  await env.app.start();const association=env.app.addExistingRequest('https://www.ablesci.com/assist/detail?id=Request1',task.id);await settle();
  await env.app.retryTask(task.id);await until(()=>env.publisherCalls.length===1);remoteGate.resolve({requestID:'Request1',doi:task.doi,state:'waiting',files:[]});
  await assert.rejects(association,/正在处理/);assert.equal(env.app.getSnapshot().tasks[0].requestID,'');
  await env.app.pauseTask(task.id);publisherGate.resolve();await settle();await env.app.stop();
});

test('association validates live DOI and refreshes stale unsubmitted task metadata',async()=>{
  const task=MODEL.createTask({libraryID:1,itemID:1,itemKey:'ITEM1',doi:'10.1234/old',state:'not_found'}),env=environment({initialTasks:[task]});env.addItem(item(1));
  env.adapter.getRequest=async id=>({requestID:id,doi:'10.1234/paper1',state:'waiting',files:[]});await env.app.start();
  const linked=await env.app.addExistingRequest('https://www.ablesci.com/assist/detail?id=Request1',task.id);
  assert.equal(linked.doi,'10.1234/paper1');assert.equal(linked.requestID,'Request1');await env.app.stop();
});

test('transient read failures keep remote tasks scheduled and recover without publication',async()=>{
  const task=remoteFixture('waiting'),env=environment({initialTasks:[task]});env.addItem(item(1));
  env.adapter.getRequest=async()=>{const error=new Error('Temporary connection failure');error.code='NETWORK';error.retryable=true;throw error;};await env.app.start();
  await env.app.checkTask(task.id);let current=env.app.getSnapshot().tasks[0];assert.equal(current.state,'waiting');assert.equal(current.attempts,1);assert.ok(Date.parse(current.nextCheckAt)>Date.now());assert.match(current.lastError,/60 秒后重试/);
  await env.app.checkTask(task.id);current=env.app.getSnapshot().tasks[0];assert.equal(current.state,'waiting');assert.equal(current.attempts,2);assert.match(current.lastError,/120 秒后重试/);
  env.adapter.getRequest=async()=>({requestID:'Request1',doi:task.doi,state:'waiting',files:[]});await env.app.checkTask(task.id);
  assert.equal(env.app.getSnapshot().tasks[0].attempts,0);assert.equal(env.app.getSnapshot().tasks[0].lastError,'');assert.equal(env.submissions.length,0);await env.app.stop();
});

test('a late transient read error cannot resume a paused remote task',async()=>{
  const task=remoteFixture('waiting'),gate=deferred(),env=environment({initialTasks:[task]});env.addItem(item(1));
  env.adapter.getRequest=async()=>{await gate.promise;const error=new Error('Temporary connection failure');error.code='NETWORK';error.retryable=true;throw error;};await env.app.start();
  const check=env.app.checkTask(task.id);await settle();await env.app.pauseTask(task.id);gate.resolve();await check;
  assert.equal(env.app.getSnapshot().tasks[0].state,'paused');assert.equal(env.app.getSnapshot().tasks[0].nextCheckAt,null);await env.app.stop();
});

test('closed remote requests explain manual handling and never automatically republish',async()=>{
  const task=remoteFixture('waiting'),env=environment({initialTasks:[task]});env.addItem(item(1));env.adapter.getRequest=async()=>({requestID:'Request1',doi:task.doi,state:'closed',files:[]});
  await env.app.start();await env.app.checkTask(task.id);const current=env.app.getSnapshot().tasks[0];
  assert.equal(current.state,'closed');assert.equal(current.nextCheckAt,null);assert.match(current.lastError,/历史求助已关闭/);assert.equal(env.submissions.length,0);await env.app.stop();
});

test('explicit context-menu fallback uses current points for an old unsubmitted task',async()=>{
  const env=environment({acquire:async()=>({state:'not_found'})}),parent=env.addItem(item(1));await env.app.start();await env.app.captureItems([parent]);await until(()=>env.app.getSelectedTask().state==='not_found');
  await env.app.saveSettings({points:40});await env.app.captureItems([parent],{allowAssist:true});await until(()=>env.app.getSelectedTask().state==='waiting');
  assert.equal(env.app.getSnapshot().tasks.length,1);assert.equal(env.app.getSelectedTask().requestedPoints,40);assert.equal(env.submissions[0].points,40);await env.app.stop();
});

test('context-menu fallback preserves protected or remote task budgets',async()=>{
  const unbound=MODEL.createTask({libraryID:1,itemID:2,itemKey:'ITEM2',doi:'10.1234/paper2',state:'error',requestedPoints:10}),bound=remoteFixture('paused');
  const env=environment({initialTasks:[bound,unbound],initialIntents:{'FixtureAccount:10.1234/paper2':{doi:unbound.doi,state:'confirmed',requestID:'OtherRequest'}},acquire:async()=>({state:'not_found'})});
  const parents=[env.addItem(item(1)),env.addItem(item(2))];await env.app.start();await env.app.saveSettings({points:40});await env.app.captureItems(parents,{allowAssist:true});
  assert.ok(env.app.getSnapshot().tasks.every(task=>task.requestedPoints===10));await until(()=>env.app.getSnapshot().tasks.every(task=>!['queued','resolving','submitting'].includes(task.state)));await env.app.stop();
});

test('automatic reuse prevents a request from binding to two parent items or disappearing on save',async()=>{
  const bound=remoteFixture('paused'),env=environment({initialTasks:[bound],acquire:async()=>({state:'not_found'})});env.addItem(item(1));
  const second=env.addItem(item(2)),original=second.getField;second.getField=name=>name==='DOI'?bound.doi:original(name);
  env.adapter.findExistingRequest=async()=>({requestID:bound.requestID,requestURL:bound.requestURL,doi:bound.doi});await env.app.start();await env.app.captureItems([second],{allowAssist:true});
  await until(()=>env.app.getSelectedTask().state==='error');assert.match(env.app.getSelectedTask().lastError,/已关联另一个条目/);assert.equal(env.app.getSelectedTask().requestID,'');
  assert.equal(env.app.getSnapshot().tasks.length,2);assert.equal(JSON.parse(env.files.get(queuePath)).tasks.length,2);assert.equal(env.submissions.length,0);await env.app.stop();
});

test('association cannot overwrite another association completed during its network wait',async()=>{
  const task=MODEL.createTask({libraryID:1,itemID:1,itemKey:'ITEM1',doi:'10.1234/paper1',state:'not_found'}),gate=deferred(),env=environment({initialTasks:[task]});env.addItem(item(1));
  env.adapter.getRequest=async id=>id==='Request1'?gate.promise:{requestID:id,doi:task.doi,state:'waiting',files:[]};await env.app.start();
  const first=env.app.addExistingRequest('https://www.ablesci.com/assist/detail?id=Request1',task.id);await settle();
  await env.app.addExistingRequest('https://www.ablesci.com/assist/detail?id=OtherRequest',task.id);gate.resolve({requestID:'Request1',doi:task.doi,state:'waiting',files:[]});
  await assert.rejects(first,/已关联另一个求助/);assert.equal(env.app.getSnapshot().tasks.length,1);assert.equal(env.app.getSnapshot().tasks[0].requestID,'OtherRequest');await env.app.stop();
});

test('a changed live DOI blocks manual association even when cached metadata matches the request',async()=>{
  const task=MODEL.createTask({libraryID:1,itemID:1,itemKey:'ITEM1',doi:'10.1234/old',state:'not_found'}),env=environment({initialTasks:[task]});env.addItem(item(1));
  env.adapter.getRequest=async id=>({requestID:id,doi:task.doi,state:'waiting',files:[]});await env.app.start();
  await assert.rejects(env.app.addExistingRequest('https://www.ablesci.com/assist/detail?id=Request1',task.id),/DOI/);
  assert.equal(env.app.getSnapshot().tasks[0].requestID,'');await env.app.stop();
});

test('the last import guard rejects a DOI changed while the temporary PDF is written',async()=>{
  const env=environment({initialTasks:[remoteFixture()]});const parent=env.addItem(item(1));availableDownload(env);
  const write=env.IOUtils.write,original=parent.getField;
  env.IOUtils.write=async(...args)=>{await write(...args);parent.getField=name=>name==='DOI'?'10.1234/different':original(name);};
  await env.app.start();await env.app.downloadTask(env.app.getSnapshot().tasks[0].id);
  assert.equal(env.app.getSnapshot().tasks[0].state,'error');assert.equal(env.httpCalls.length,1);assert.equal(env.importCount,0);await env.app.stop();
});

test('retryable login and uncertain errors do not enter the ordinary remote polling loop',async()=>{
  for(const code of ['LOGIN_REQUIRED','SUBMISSION_UNKNOWN']){
    const task=remoteFixture('waiting'),env=environment({initialTasks:[task]});env.addItem(item(1));
    env.adapter.getRequest=async()=>{const error=new Error(code);error.code=code;error.retryable=true;throw error;};await env.app.start();await env.app.checkTask(task.id);
    const current=env.app.getSnapshot().tasks[0];assert.equal(current.state,code==='LOGIN_REQUIRED'?'pending_login':'submission_unknown');assert.equal(current.nextCheckAt,null);assert.equal(env.submissions.length,0);await env.app.stop();
  }
});
