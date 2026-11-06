const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');
const MODEL = require('../src/task-model.js');
const appSource = fs.readFileSync(path.join(__dirname,'../src/app.js'),'utf8');
const publisherSource = fs.readFileSync(path.join(__dirname,'../src/publisher.js'),'utf8');
const publisherWindowSource = fs.readFileSync(path.join(__dirname,'../src/publisher-window.js'),'utf8');
const downloadWatchSource = fs.readFileSync(path.join(__dirname,'../src/download-watch.js'),'utf8');
const downloadFoldersSource = fs.readFileSync(path.join(__dirname,'../src/download-folders.js'),'utf8');
const downloadDirectory = 'C:\\isolated\\Downloads';
const queuePath = path.win32.join('C:\\isolated','fulltext-assistant','tasks.json');
const intentPath = path.win32.join('C:\\isolated','fulltext-assistant','submission-intents.json');
const deferred = () => {let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const settle = () => new Promise(resolve=>setImmediate(resolve));
async function until(condition) {const end=Date.now()+2000;while(!condition()){if(Date.now()>end)throw new Error('Fixture condition timed out');await settle();}}
function item(id) {return {id,key:'ITEM'+id,libraryID:1,deleted:false,isRegularItem:()=>true,getAttachments:()=>[],async getBestAttachment(){return null;},getField(name){return {DOI:'10.1234/paper'+id,title:'Fixture paper '+id,url:'https://publisher.test/paper'+id}[name]||'';}};}

function environment({acquire,initialTasks,initialQueue,initialAccessHistory,initialPrefs,initialIntents,realPublisher=false,writePDFError=false,pickPDF,pickDirectory,pdfIdentity,discoverDirectories,watchNow,appTime,edgeAcquire,edgeHost}={}) {
  const files=new Map(),prefs=new Map(),items=new Map(),menus=new Map(),publisherCalls=[],submissions=[],remoteRequests=[],errors=[],httpCalls=[],imports=[];
  const directories=new Set([downloadDirectory]),fileMetadata=new Map(),openedURLs=[],openedFiles=[],identityCalls=[],timers=[];
  let clock=Date.now(),fileRevision=1;
  let appClock=appTime===undefined?Date.now():Number(appTime);
  const AppDate=appTime===undefined?Date:class extends Date{constructor(...args){super(...(args.length?args:[appClock]));}static now(){return appClock;}};
  let accountCalls=0,active=0,peak=0,writeHook=null,importCount=0,oaCalls=0;
  if(initialTasks)files.set(queuePath,MODEL.serializeQueue(initialTasks));
  if(initialQueue)files.set(queuePath,MODEL.serializeQueue(initialQueue));
  if(initialAccessHistory)files.set(path.win32.join('C:\\isolated','fulltext-assistant','access-history.json'),JSON.stringify(initialAccessHistory));
  for(const [key,value] of Object.entries(initialPrefs||{}))prefs.set(key,value);
  if(initialIntents)files.set(intentPath,JSON.stringify(initialIntents));
  const account={authenticated:true,accountID:'FixtureAccount',username:'Display Name'};
  const session={destroyed:false,cleared:0,async initialize(){},getStatus(){return {hasCookies:false,persistent:true};},async flush(){},async destroy(){this.destroyed=true;},async clearSession(){this.cleared++;},async request(){throw new Error('No real request permitted in app fixture');}};
  const credentials={saved:false,username:'',async getSummary(){return {saved:this.saved,username:this.username};},async save(value){this.saved=true;this.username=value.username;},async remove(){this.saved=false;this.username='';}};
  const adapter={async getAccount(){accountCalls++;return account;},async findExistingRequest(){return null;},async submitRequest(value){submissions.push(value);return {requestID:'Request'+submissions.length,requestURL:'https://www.ablesci.com/assist/detail?id=Request'+submissions.length};},async getRequest(id){remoteRequests.push(id);return {requestID:id,doi:submissions[Number(id.replace('Request',''))-1]?.doi||'',state:'waiting',files:[]};},async listMessages(){return [];}};
  adapter.getCheckInStatus=async()=>{const date=new AppDate(),day=[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');return{accountID:account.accountID,day,signed:true,balance:88,reward:5,rewardVerified:true,checkedAt:date.toISOString()};};
  const IOUtils={async exists(file){return files.has(file);},async readUTF8(file){return files.get(file);},async makeDirectory(){},async writeUTF8(file,value){if(writeHook)await writeHook(file,value);files.set(file,value);},async write(file,value){if(writePDFError)throw new Error('fixture disk full');files.set(file,value);},async remove(file){files.delete(file);}};
  const Services={prefs:{getIntPref(key,fallback){return prefs.get(key)??fallback;},getBoolPref(key,fallback){return prefs.get(key)??fallback;},getStringPref(key,fallback){return prefs.get(key)??fallback;},setIntPref(key,value){prefs.set(key,value);},setBoolPref(key,value){prefs.set(key,value);},setStringPref(key,value){prefs.set(key,value);}},prompt:{alert(){}}};
  const pdf=new TextEncoder().encode('%PDF-1.7\n'+'0'.repeat(1200)+'\n%%EOF\n');
  const Zotero={DataDirectory:{dir:'C:\\isolated'},Items:{async getAsync(id){return items.get(id);}},Libraries:{get(){return {editable:true,filesEditable:true};}},MenuManager:{registerMenu(value){menus.set(value.menuID,value);return value.menuID;},unregisterMenu(id){menus.delete(id);}},PreferencePanes:{async register(value){return value.id;}},Utilities:{Internal:{openPreferences(){}}},getMainWindow(){return {openDialog(){return {closed:false,close(){this.closed=true;},focus(){}};}};},logError(error){errors.push(error);},Promise:{delay(ms){return new Promise(resolve=>setTimeout(resolve,Math.min(ms,5)));}},HTTP:{async request(method,url){httpCalls.push({method,url});return {status:200,response:pdf.buffer,responseURL:url,getResponseHeader(){return 'application/pdf';}};}},Attachments:{async createTemporaryStorageDirectory(){return {path:'C:\\isolated\\publisher-temp'};},async importFromFile(options){importCount++;imports.push(options);return {id:900,setField(){},async saveTx(){}};},getFileBaseNameFromItem(){return 'fixture-paper';},getFileResolvers(){oaCalls++;return [];}}};
  const scope={URL,URLSearchParams,Promise,Date:AppDate,JSON,Set,Map,Uint8Array,ArrayBuffer,TextDecoder,crypto:webcrypto,FulltextTaskModel:MODEL,FulltextPublisherWindow:{create(){return {open(){},destroy(){}};}},setInterval(callback,ms){timers.push({callback,ms});return timers.length;},clearInterval(){},FulltextCredentials:{create(){return credentials;}},FulltextSession:{create(){return session;}},FulltextAbleSci:{create(){return adapter;}}};
  vm.runInNewContext(publisherSource,scope);
  vm.runInNewContext(publisherWindowSource,scope);
  vm.runInNewContext(downloadWatchSource,scope);
  vm.runInNewContext(downloadFoldersSource,scope);
  scope.FulltextAccessHistory=require('../src/access-history.js');
  for(const moduleFile of ['i18n-backend-data.js','i18n.js']){const file=path.join(__dirname,'../src',moduleFile);if(fs.existsSync(file))vm.runInNewContext(fs.readFileSync(file,'utf8'),scope);}
  const createWatch=scope.FulltextDownloadWatch.create;
  scope.FulltextDownloadWatch.create=options=>createWatch({...options,now:watchNow||(()=>clock)});
  if(!realPublisher)scope.FulltextPublisher={validPDF:scope.FulltextPublisher.validPDF,findExistingPDF:scope.FulltextPublisher.findExistingPDF,create(){return {async acquire(value,options){publisherCalls.push({item:value,options});active++;peak=Math.max(peak,active);try{return await(acquire?acquire(value,options):{attachmentID:800+value.id,source:'publisher'});}finally{active--;}}};}};
  vm.runInNewContext(appSource,scope);
  Zotero.Search=class{addCondition(field,operator,value){this.doi=value;}async search(){return [...items.values()].filter(value=>value.getField&&value.getField('DOI').toLowerCase()===this.doi).map(value=>value.id);}};
  IOUtils.stat=async file=>{if(directories.has(file))return {type:'directory',size:0};if(!files.has(file))throw new Error('Fixture file missing');return {type:'regular',size:files.get(file)?.length||0,lastModified:1,...fileMetadata.get(file)};};
  IOUtils.read=async (file,{offset=0,maxBytes}={})=>{if(!files.has(file))throw new Error('Fixture file missing');return files.get(file).slice(offset,maxBytes===undefined?undefined:offset+maxBytes);};
  IOUtils.getChildren=async directory=>{if(!directories.has(directory))throw new Error('Fixture directory missing');return [...files.keys()].filter(file=>path.win32.dirname(file)===directory);};
  Zotero.launchURL=async url=>openedURLs.push(url);Zotero.launchFile=async file=>openedFiles.push(file);
  const identity=pdfIdentity||{async inspect(file,paper,options){identityCalls.push({file,paper,bytes:options?.bytes});return {status:'match',matchedBy:'doi',message:'Fixture DOI match'};}};
  const app=scope.FulltextApp.create({Zotero,Services,IOUtils,PathUtils:path.win32,rootURI:'file:///fixture/',pluginID:'fixture@local.invalid',version:'0.6.0',pickPDF,pickDirectory,pdfIdentity:identity,discoverDownloadDirectories:discoverDirectories||(async()=>[downloadDirectory]),edgeAcquire,edgeHost});
  return {app,Zotero,Services,IOUtils,files,prefs,items,menus,publisherCalls,submissions,remoteRequests,errors,httpCalls,imports,session,credentials,adapter,account,directories,fileMetadata,openedURLs,openedFiles,identityCalls,timers,pdf,downloadDirectory,advanceTime(ms){clock+=ms;},advanceAppTime(ms){appClock+=ms;},setAppTime(value){appClock=Number(value);},putFile(file,bytes,metadata={}){files.set(file,bytes);fileMetadata.set(file,{lastModified:++fileRevision,...metadata});},addItem(value){items.set(value.id,value);return value;},setWriteHook(value){writeHook=value;},get accountCalls(){return accountCalls;},get peak(){return peak;},get importCount(){return importCount;},get oaCalls(){return oaCalls;}};
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

test('a second batch appends new items and old retries after the first batch without restarting duplicate active or queued items',async()=>{
  const history=MODEL.createTask({libraryID:1,itemID:6,itemKey:'ITEM6',doi:'10.1234/paper6',state:'not_found',allowAssist:true,requestedPoints:19},{now:'2025-01-01T00:00:00Z'});
  const releases=new Map(),env=environment({initialTasks:[history],acquire:async value=>{const gate=deferred();releases.set(value.id,gate);await gate.promise;return {attachmentID:100+value.id,source:'publisher'};}});
  const parents=new Map([1,2,3,4,5,6].map(id=>[id,env.addItem(item(id))]));const order=()=>env.publisherCalls.map(call=>call.item.id);
  await env.app.start();await env.app.captureItems([1,2,3,4].map(id=>parents.get(id)));await until(()=>releases.size===2);
  const unchanged=env.app.getSnapshot().tasks.filter(task=>[1,2,3,4].includes(task.itemID));
  const second=await env.app.captureItems([5,1,3,6,5].map(id=>parents.get(id)));
  assert.deepEqual([second.queued,second.retained,second.duplicates],[2,2,1]);assert.deepEqual(order(),[1,2]);
  assert.equal(JSON.stringify(env.app.getSnapshot().tasks.filter(task=>[1,2,3,4].includes(task.itemID))),JSON.stringify(unchanged));
  assert.deepEqual(Array.from(env.app.getSnapshot().tasks,task=>task.itemID),[1,2,3,4,5,6]);
  assert.equal(env.app.getSnapshot().tasks.at(-1).id,history.id);assert.equal(env.app.getSnapshot().tasks.at(-1).allowAssist,false);
  releases.get(1).resolve();await until(()=>env.app.getSnapshot().tasks.find(task=>task.itemID===1).state==='imported');assert.deepEqual(order(),[1,2]);
  releases.get(2).resolve();await until(()=>releases.size===4);assert.deepEqual(order(),[1,2,3,4]);
  releases.get(3).resolve();releases.get(4).resolve();await until(()=>releases.size===6);assert.deepEqual(order(),[1,2,3,4,5,6]);
  releases.get(5).resolve();releases.get(6).resolve();await until(()=>env.app.getSnapshot().tasks.every(task=>task.state==='imported'));
  assert.equal(new Set(env.app.getSnapshot().tasks.map(task=>task.id)).size,6);assert.equal(new Set(order()).size,6);assert.equal(env.peak,2);assert.equal(env.accountCalls,0);assert.equal(env.submissions.length,0);
  assert.deepEqual(JSON.parse(env.files.get(queuePath)).tasks.map(task=>task.itemID),[1,2,3,4,5,6]);await env.app.stop();
});

test('explicit retry, assistance and missing-PDF repair all join the tail behind waiting work',async()=>{
  const history=[5,6,7].map(id=>MODEL.createTask({libraryID:1,itemID:id,itemKey:'ITEM'+id,doi:'10.1234/paper'+id,state:id===7?'imported':'not_found',attachmentID:id===7?107:null,requestedPoints:19},{now:'2025-01-01T00:00:00Z'}));
  const releases=new Map(),env=environment({initialTasks:history,acquire:async value=>{const gate=deferred();releases.set(value.id,gate);await gate.promise;return {attachmentID:100+value.id,source:'publisher'};}});
  const parents=new Map([1,2,3,4,5,6,7].map(id=>[id,env.addItem(item(id))]));const order=()=>env.publisherCalls.map(call=>call.item.id);
  await env.app.start();await env.app.captureItems([1,2,3,4].map(id=>parents.get(id)));await until(()=>releases.size===2);
  await env.app.retryTask(history[0].id);await env.app.requestAssist(history[1].id,{points:43});const repair=await env.app.captureItems([parents.get(7)]);
  assert.equal(repair.queued,1);assert.deepEqual(order(),[1,2]);assert.deepEqual(Array.from(env.app.getSnapshot().tasks,task=>task.itemID),[1,2,3,4,5,6,7]);
  for(const previous of history)assert.equal(env.app.getSnapshot().tasks.find(task=>task.itemID===previous.itemID).id,previous.id);
  const assist=env.app.getSnapshot().tasks.find(task=>task.itemID===6);assert.equal(assist.allowAssist,true);assert.equal(assist.requestedPoints,43);assert.equal(env.app.getSnapshot().tasks.at(-1).attachmentID,null);
  releases.get(1).resolve();releases.get(2).resolve();await until(()=>releases.size===4);assert.deepEqual(order(),[1,2,3,4]);
  releases.get(3).resolve();releases.get(4).resolve();await until(()=>releases.size===6);assert.deepEqual(order(),[1,2,3,4,5,6]);
  releases.get(5).resolve();releases.get(6).resolve();await until(()=>releases.size===7);assert.deepEqual(order(),[1,2,3,4,5,6,7]);
  releases.get(7).resolve();await until(()=>env.app.getSnapshot().tasks.every(task=>task.state==='imported'));
  assert.equal(env.peak,2);assert.equal(env.accountCalls,0);assert.equal(env.submissions.length,0);await env.app.stop();
});

test('public full text is acquired without checking or requiring an AbleSci account',async()=>{
  const env=environment();env.adapter.getAccount=async()=>{throw new Error('Account must not be consulted');};
  await env.app.start();await env.app.captureItems([env.addItem(item(1))]);
  await until(()=>env.app.getSelectedTask().state==='imported');
  assert.equal(env.app.getSelectedTask().source,'publisher');assert.equal(env.accountCalls,0);assert.equal(env.submissions.length,0);await env.app.stop();
});

test('existing PDF is skipped before task creation without HTTP or an account check',async()=>{
  const env=environment({realPublisher:true});const parent=env.addItem(item(1));parent.getAttachments=()=>[99];
  env.items.set(99,{id:99,attachmentContentType:'application/pdf',async getFilePathAsync(){return 'C:\\isolated\\existing.pdf';}});env.files.set('C:\\isolated\\existing.pdf',env.pdf);
  await env.app.start();const summary=await env.app.captureItems([parent],{allowAssist:true});
  assert.equal(summary.skippedExistingPDF,1);assert.equal(summary.queued,0);assert.equal(env.app.getSnapshot().tasks.length,0);assert.equal(env.httpCalls.length,0);assert.equal(env.importCount,0);assert.equal(env.accountCalls,0);await env.app.stop();
});

test('real publisher storage failure is surfaced as an error and never starts paid fallback',async()=>{
  const env=environment({realPublisher:true,writePDFError:true});await env.app.start();await env.app.captureItems([env.addItem(item(1))],{allowAssist:true});
  await until(()=>['error','not_found','submission_unknown','waiting'].includes(env.app.getSelectedTask().state));
  assert.equal(env.app.getSelectedTask().state,'error');assert.match(env.app.getSelectedTask().lastError,/写入或导入 Zotero 失败/);
  assert.equal(env.httpCalls.length,1);assert.equal(env.importCount,0);assert.equal(env.oaCalls,0);assert.equal(env.accountCalls,0);assert.equal(env.submissions.length,0);await env.app.stop();
});

test('mixed capture counts local PDFs, child selections, duplicates, unsupported entries and retained history',async()=>{
  const history=MODEL.createTask({libraryID:1,itemID:3,itemKey:'ITEM3',doi:'10.1234/paper3',state:'paused',requestedPoints:27,requestURL:'https://www.ablesci.com/assist/detail?id=Existing'});
  const env=environment({initialTasks:[history],acquire:async()=>({state:'not_found'})});
  const stored=env.addItem(item(1)),missing=env.addItem(item(2)),old=env.addItem(item(3)),linked=env.addItem(item(4));
  const attach=(parent,id,file,mode=0)=>{const value={id,parentID:parent.id,libraryID:1,attachmentContentType:'application/pdf',attachmentLinkMode:mode,isAttachment:()=>true,isRegularItem:()=>false,async getFilePathAsync(){return file;}};env.addItem(value);return value;};
  const storedAttachment=attach(stored,101,'C:\\isolated\\stored.pdf');stored.getAttachments=()=>[101];env.files.set('C:\\isolated\\stored.pdf',env.pdf);
  const missingAttachment=attach(missing,102,'C:\\isolated\\missing.pdf');missing.getAttachments=()=>[102];
  attach(linked,104,'C:\\isolated\\linked.pdf',2);linked.getAttachments=()=>[104];env.files.set('C:\\isolated\\linked.pdf',env.pdf);
  await env.app.start();assert.equal(env.app.getSnapshot().captureSummary,null);
  const before=JSON.stringify(env.app.getSnapshot().tasks[0]);
  const summary=await env.app.captureItems([stored,missingAttachment,old,storedAttachment,linked,{id:9,isAttachment:()=>true},{id:10,isNote:()=>true},null]);
  assert.deepEqual([summary.selected,summary.eligible,summary.queued,summary.skippedExistingPDF,summary.retained,summary.ignored,summary.duplicates,summary.failed],[8,4,1,2,1,3,1,0]);
  assert.match(summary.message,/加入 1 项，已有 PDF 跳过 2 项/);
  assert.equal(JSON.stringify(env.app.getSnapshot().tasks.find(t=>t.id===history.id)),before);
  assert.equal(env.app.getSnapshot().tasks.length,2);assert.equal(summary.queuedTaskIDs.length,1);
  summary.queuedTaskIDs.push('not-real');summary.queued=999;
  assert.equal(env.app.getSnapshot().captureSummary.queued,1);assert.equal(env.app.getSnapshot().captureSummary.queuedTaskIDs.length,1);
  assert.equal(JSON.parse(env.files.get(queuePath)).captureSummary,undefined);
  await until(()=>env.publisherCalls.length===1);assert.equal(env.publisherCalls[0].item.id,2);await env.app.stop();
});

test('capture leaves an existing PDF history and remote association byte-for-byte unchanged',async()=>{
  for(const state of ['imported','paused']){
    const history=MODEL.createTask({libraryID:1,itemID:1,itemKey:'ITEM1',doi:'10.1234/paper1',state,attachmentID:99,requestedPoints:28,requestURL:'https://www.ablesci.com/assist/detail?id=OldRemote',allowAssist:true});
    const env=environment({initialTasks:[history]}),parent=env.addItem(item(1));parent.getAttachments=()=>[99];
    env.addItem({id:99,attachmentContentType:'application/pdf',async getFilePathAsync(){return 'C:\\isolated\\existing.pdf';}});env.files.set('C:\\isolated\\existing.pdf',env.pdf);
    await env.app.start();const before=JSON.stringify(env.app.getSnapshot().tasks[0]);await env.app.saveSettings({points:55});
    const summary=await env.app.captureItems([parent],{allowAssist:true});
    assert.equal(summary.skippedExistingPDF,1);assert.equal(JSON.stringify(env.app.getSnapshot().tasks[0]),before);assert.equal(env.publisherCalls.length,0);assert.equal(env.remoteRequests.length,0);await env.app.stop();
  }
});

test('capture retains active work and retries corrected-DOI history without duplicating parent tasks',async()=>{
  const gate=deferred(),env=environment({acquire:async()=>{await gate.promise;return {state:'not_found'};}}),parent=env.addItem(item(1));
  await env.app.start();await env.app.captureItems([parent]);await until(()=>env.publisherCalls.length===1);
  const before=JSON.stringify(env.app.getSnapshot().tasks[0]);const activeResult=await env.app.captureItems([parent],{allowAssist:true});
  assert.equal(activeResult.retained,1);assert.equal(JSON.stringify(env.app.getSnapshot().tasks[0]),before);
  gate.resolve();await until(()=>env.app.getSelectedTask().state==='not_found');const oldID=env.app.getSelectedTask().id;
  const getField=parent.getField;parent.getField=name=>name==='DOI'?'10.1234/corrected':getField(name);
  const result=await env.app.captureItems([parent]);assert.equal(result.queued,1);assert.equal(env.app.getSnapshot().tasks.length,1);assert.equal(env.app.getSelectedTask().id,oldID);await until(()=>env.app.getSelectedTask().state==='not_found'&&env.app.getSelectedTask().doi==='10.1234/corrected');await env.app.stop();
});

test('an imported task whose PDF disappeared reuses its ID and does not inherit paid fallback authorization',async()=>{
  const history=MODEL.createTask({libraryID:1,itemID:1,itemKey:'ITEM1',doi:'10.1234/paper1',state:'imported',attachmentID:99,requestedPoints:28,allowAssist:true,source:'publisher'});
  const gate=deferred(),env=environment({initialTasks:[history],acquire:async()=>{await gate.promise;return {state:'not_found'};}}),parent=env.addItem(item(1));
  parent.getAttachments=()=>[99];env.addItem({id:99,attachmentContentType:'application/pdf',async getFilePathAsync(){return false;}});
  await env.app.start();const result=await env.app.captureItems([parent]);
  assert.equal(result.queued,1);assert.equal(env.app.getSnapshot().tasks.length,1);const current=env.app.getSelectedTask();assert.equal(current.id,history.id);assert.equal(current.attachmentID,null);assert.equal(current.completedAt,null);assert.equal(current.allowAssist,false);
  gate.resolve();await until(()=>env.app.getSelectedTask().state==='not_found');assert.equal(env.submissions.length,0);assert.equal(env.accountCalls,0);await env.app.stop();
});

test('repair of a missing imported remote PDF preserves request and points and never republishes',async()=>{
  const history=MODEL.createTask({libraryID:1,itemID:1,itemKey:'ITEM1',doi:'10.1234/paper1',state:'imported',attachmentID:99,requestedPoints:28,allowAssist:true,source:'ablesci',requestURL:'https://www.ablesci.com/assist/detail?id=OldRemote'});
  const env=environment({initialTasks:[history]});env.addItem(item(1));await env.app.start();await env.app.saveSettings({points:55});
  const result=await env.app.captureItems([env.items.get(1)],{allowAssist:true});await until(()=>env.remoteRequests.length===1);
  const current=env.app.getSnapshot().tasks[0];assert.equal(result.queued,1);assert.equal(current.id,history.id);assert.equal(current.requestID,'OldRemote');assert.equal(current.requestedPoints,28);assert.equal(current.attachmentID,null);assert.equal(env.publisherCalls.length,0);assert.equal(env.submissions.length,0);await env.app.stop();
});

test('one failed attachment enumeration does not abort a batch and capture summaries get unique IDs',async()=>{
  const env=environment({acquire:async()=>({state:'not_found'})}),bad=env.addItem(item(1)),good=env.addItem(item(2));bad.getAttachments=()=>{throw new Error('fixture failed enumeration');};
  await env.app.start();const one=await env.app.captureItems([bad,good]);assert.equal(one.failed,1);assert.equal(one.queued,1);
  const two=await env.app.captureItems([]);assert.notEqual(one.id,two.id);assert.equal(two.selected,0);assert.equal(two.queued,0);await env.app.stop();
});

test('overlapping captures deduplicate by current parent identity after asynchronous PDF checks',async()=>{
  const gate=deferred(),env=environment({acquire:async()=>{await gate.promise;return {state:'not_found'};}}),parent=env.addItem(item(1));
  await env.app.start();const [one,two]=await Promise.all([env.app.captureItems([parent]),env.app.captureItems([parent])]);
  assert.equal(one.queued+two.queued,1);assert.equal(one.retained+two.retained,1);assert.equal(env.app.getSnapshot().tasks.length,1);gate.resolve();await env.app.stop();
});

test('ordinary batch capture retries unresolved history using the same IDs without retaining old spending permission',async()=>{
  const states=['not_found','needs_login','pending_login','needs_review','paused','error'];
  const history=states.map((state,index)=>MODEL.createTask({libraryID:1,itemID:index+1,itemKey:'ITEM'+(index+1),doi:'10.1234/paper'+(index+1),state,allowAssist:true,requestedPoints:28}));
  const env=environment({initialTasks:history,acquire:async()=>({state:'not_found'})});const parents=states.map((_,index)=>env.addItem(item(index+1)));
  await env.app.start();await env.app.saveSettings({points:55});const result=await env.app.captureItems(parents);
  assert.equal(result.queued,states.length);assert.equal(env.app.getSnapshot().tasks.length,states.length);
  for(const previous of history){const current=env.app.getSnapshot().tasks.find(task=>task.id===previous.id);assert(current);assert.equal(current.allowAssist,false);assert.equal(current.requestedPoints,28);}
  await until(()=>env.app.getSnapshot().tasks.every(task=>task.state==='not_found'));assert.equal(env.submissions.length,0);assert.equal(env.accountCalls,0);await env.app.stop();
});

test('ordinary capture preserves an active manual download watch until explicit fallback is chosen',async()=>{
  const history=MODEL.createTask({libraryID:1,itemID:1,itemKey:'ITEM1',doi:'10.1234/paper1',title:'Fixture',state:'paused'});
  const env=environment({initialTasks:[history],acquire:async()=>({state:'not_found'})}),parent=env.addItem(item(1));
  await env.app.start();env.app.selectTask(history.id);await env.app.openSystemBrowserTask(history.id);assert.equal(env.app.getSelectedTask().state,'manual_waiting');
  const before=JSON.stringify(env.app.getSelectedTask());const result=await env.app.captureItems([parent]);assert.equal(result.retained,1);assert.equal(JSON.stringify(env.app.getSelectedTask()),before);assert.equal(env.publisherCalls.length,0);
  await env.app.saveSettings({points:55});const fallback=await env.app.captureItems([parent],{allowAssist:true});assert.equal(fallback.queued,1);await until(()=>env.submissions.length===1);assert.equal(env.submissions[0].points,55);await env.app.stop();
});

test('stopping during local PDF inspection cancels both the batch and its queued successor without later writes',async()=>{
  const gate=deferred(),env=environment(),parent=env.addItem(item(1));let inspections=0,opens=0;
  parent.getAttachments=()=>[99];env.addItem({id:99,attachmentContentType:'application/pdf',async getFilePathAsync(){inspections++;return gate.promise;}});
  await env.app.start();env.app.openPreferences=async()=>{opens++;};
  const first=env.app.captureItems([parent,env.addItem(item(2))]);const second=env.app.captureItems([env.addItem(item(3))]);
  await until(()=>inspections===1);await env.app.stop();const persisted=env.files.get(queuePath);let lateWrites=0;env.setWriteHook(async()=>{lateWrites++;});
  gate.resolve('C:\\isolated\\missing.pdf');const [one,two]=await Promise.all([first,second]);
  assert.equal(one.cancelled,true);assert.equal(one.unprocessed,2);assert.equal(one.queued,0);assert.equal(two.cancelled,true);assert.equal(two.unprocessed,1);
  assert.equal(env.app.getSnapshot().tasks.length,0);assert.equal(env.app.getSnapshot().captureSummary,null);assert.equal(env.files.get(queuePath),persisted);assert.equal(lateWrites,0);assert.equal(opens,0);assert.equal(env.publisherCalls.length,0);
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

test('an unsent task uses the latest default budget at explicit fallback submission',async()=>{
  const env=environment({acquire:async()=>({state:'not_found',message:'fixture unavailable'})});await env.app.start();
  await env.app.captureItems([env.addItem(item(1))]);await until(()=>env.app.getSelectedTask().state==='not_found');const firstID=env.app.getSelectedTask().id;
  await env.app.saveSettings({points:35,pollSeconds:60,autoDownload:true});await env.app.captureItems([env.addItem(item(2))]);await until(()=>env.app.getSelectedTask().state==='not_found');
  assert.equal(env.app.getSnapshot().tasks.find(value=>value.id===firstID).requestedPoints,10);assert.equal(env.app.getSelectedTask().requestedPoints,35);
  await env.app.requestAssist(firstID);await until(()=>env.submissions.length===1);await until(()=>env.app.getSnapshot().tasks.find(value=>value.id===firstID).state==='waiting');
  assert.equal(env.submissions[0].points,35);assert.equal(env.app.getSnapshot().tasks.find(value=>value.id===firstID).requestedPoints,35);await env.app.stop();
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

test('bulk fallback accepts only unresolved tasks and applies the current default budget',async()=>{
  const env=environment({acquire:async()=>({state:'not_found',message:'fixture unavailable'})});await env.app.start();
  await env.app.captureItems([1,2].map(id=>env.addItem(item(id))));
  await until(()=>env.app.getSnapshot().tasks.every(t=>t.state==='not_found'));
  const ids=env.app.getSnapshot().tasks.map(t=>t.id);
  await env.app.saveSettings({points:25});
  const result=await env.app.requestAssist([...ids,ids[0]]);
  assert.equal(result.accepted,2);assert.equal(result.skipped,0);
  await until(()=>env.app.getSnapshot().tasks.every(t=>t.state==='waiting'));
  assert.equal(env.submissions.length,2);assert.ok(env.submissions.every(t=>t.points===25));
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

function completionEnvironment(options={}) {
  const env=environment({...options,initialTasks:options.initialTasks||[remoteFixture()]}),parent=env.addItem(item(1));
  const accepts=[],messageReads=[],posts=[],downloadCalls=[];
  parent.getAttachments=()=>[...env.items.values()].filter(value=>value.parentID===parent.id&&!value.deleted).map(value=>value.id);
  parent.getBestAttachment=async()=>[...env.items.values()].find(value=>value.parentID===parent.id&&!value.deleted&&value.attachmentContentType==='application/pdf')||null;
  const installAttachment=({id=900,parentID=1,libraryID=1,bytes=env.pdf,file='C:\\isolated\\storage\\'+id+'\\fulltext.pdf'}={})=>{
    const attachment={id,parentID,libraryID,deleted:false,attachmentContentType:'application/pdf',attachmentFilename:'fulltext.pdf',isAttachment:()=>true,isFileAttachment:()=>true,async getFilePathAsync(){return file;},async fileExists(){return env.files.has(file);},setField(){},async saveTx(){}};
    env.addItem(attachment);if(bytes!==null)env.files.set(file,bytes.slice());return attachment;
  };
  const originalImport=env.Zotero.Attachments.importFromFile;
  env.Zotero.Attachments.importFromFile=async options=>{const bytes=env.files.get(options.file).slice(),original=await originalImport(options);return installAttachment({id:original.id,parentID:options.parentItemID,bytes});};
  availableDownload(env);const originalDownload=env.adapter.getDownload;
  env.adapter.getDownload=async(...args)=>{downloadCalls.push(args);return{...await originalDownload(...args),requestID:'Request1',fileID:'File1',accountID:'FixtureAccount',filename:'paper.pdf',route:'normal'};};
  env.adapter.acceptFile=async options=>{accepts.push(options);if(!options.reconcileOnly){await options.beforeSend();posts.push({requestID:options.requestID,fileID:options.fileID,accountID:options.accountID});}return{accepted:true};};
  env.adapter.markRequestMessagesRead=async options=>{messageReads.push(options);return{completed:true};};
  return Object.assign(env,{parent,accepts,messageReads,posts,downloadCalls,installAttachment});
}
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
function importedReceiptFixture(patch={}) {
  const task=remoteFixture('imported'),verifiedAt=new Date().toISOString();
  const bytes=new TextEncoder().encode('%PDF-1.7\n'+'0'.repeat(1200)+'\n%%EOF\n');
  const assistReceipt={requestID:'Request1',fileID:'File1',accountID:'FixtureAccount',attachmentID:900,sha256:sha256(bytes),doi:task.doi,title:task.title,verifiedBy:'doi',verifiedAt,adoption:'pending',messages:'pending',needsReconcile:false,attempts:0,nextCheckAt:null,lastError:'',acceptedAt:null,readAt:null,...patch};
  return MODEL.updateTask(task,{source:'ablesci',attachmentID:900,assistReceipt});
}

test('a verified assistance PDF persists its exact hash and attachment receipt before adoption and messages',async()=>{
  const env=completionEnvironment(),events=[];
  env.adapter.acceptFile=async options=>{
    const persisted=JSON.parse(env.files.get(queuePath)).tasks[0],receipt=persisted.assistReceipt;
    assert.equal(persisted.state,'imported');assert.equal(receipt.sha256,sha256(env.pdf));assert.equal(receipt.attachmentID,900);
    assert.equal(receipt.accountID,'FixtureAccount');assert.equal(receipt.requestID,'Request1');assert.equal(receipt.fileID,'File1');assert.equal(receipt.verifiedBy,'doi');assert.equal(receipt.needsReconcile,false);
    assert.equal(await env.items.get(900).fileExists(),true);events.push('receipt-persisted');
    await options.beforeSend();assert.equal(JSON.parse(env.files.get(queuePath)).tasks[0].assistReceipt.needsReconcile,true);events.push('post');return{accepted:true};
  };
  env.adapter.markRequestMessagesRead=async()=>{const receipt=JSON.parse(env.files.get(queuePath)).tasks[0].assistReceipt;assert.equal(receipt.adoption,'accepted');assert.equal(receipt.needsReconcile,false);events.push('messages');return{completed:true};};
  await env.app.start();await env.app.downloadTask(env.app.getSnapshot().tasks[0].id);
  assert.deepEqual(events,['receipt-persisted','post','messages']);assert.equal(env.identityCalls.length,1);assert.equal(sha256(env.identityCalls[0].bytes),sha256(env.pdf));assert.equal(env.identityCalls[0].paper.doi,'10.1234/paper1');
  const task=env.app.getSnapshot().tasks[0];assert.equal(task.assistReceipt.adoption,'accepted');assert.equal(task.assistReceipt.messages,'done');assert.equal(task.assistReceipt.sha256,sha256(env.pdf));assert.equal(env.importCount,1);assert.equal(env.submissions.length,0);await env.app.stop();
});

test('a mismatched assistance PDF is neither imported nor adopted',async()=>{
  const env=completionEnvironment({pdfIdentity:{async inspect(){return{status:'mismatch',message:'DOI differs'};}}});await env.app.start();await env.app.downloadTask(env.app.getSnapshot().tasks[0].id);
  const task=env.app.getSnapshot().tasks[0];assert.equal(task.state,'error');assert.match(task.lastError,/不匹配/);assert.equal(task.assistReceipt,null);assert.equal(env.importCount,0);assert.equal(env.accepts.length,0);assert.equal(env.messageReads.length,0);await env.app.stop();
});

test('an unknown assistance PDF is retained for preview and only explicit unchanged-file confirmation imports and adopts it',async()=>{
  const env=completionEnvironment({pdfIdentity:{async inspect(){return{status:'unknown',summary:'Scanned PDF'};}}});await env.app.start();const id=env.app.getSnapshot().tasks[0].id;await env.app.downloadTask(id);
  const pending=env.app.getSnapshot().tasks[0];assert.equal(pending.state,'manual_review');assert.equal(pending.assistReview.sha256,sha256(env.pdf));assert.equal(pending.assistReceipt,null);assert.equal(env.importCount,0);assert.equal(env.accepts.length,0);
  await env.app.previewDownloadedPDF(id);const file=env.openedFiles[0];assert.equal(file,path.win32.join('C:\\isolated','fulltext-assistant','review-'+id+'.pdf'));assert(env.files.has(file));
  await env.app.confirmDownloadedPDF(id);const done=env.app.getSnapshot().tasks[0];assert.equal(done.state,'imported');assert.equal(done.assistReview,null);assert.equal(done.assistReceipt.verifiedBy,'manual');assert.equal(done.assistReceipt.messages,'done');assert.equal(env.accepts.length,1);assert.equal(env.importCount,1);assert.equal(env.files.has(file),false);await env.app.stop();
});

test('an unknown assistance PDF changed after review cannot be confirmed or adopted',async()=>{
  const env=completionEnvironment({pdfIdentity:{async inspect(){return{status:'unknown'};}}});await env.app.start();const id=env.app.getSnapshot().tasks[0].id;await env.app.downloadTask(id);await env.app.previewDownloadedPDF(id);
  const file=env.openedFiles[0],replacement=env.pdf.slice();replacement[100]=49;env.files.set(file,replacement);
  await assert.rejects(env.app.confirmDownloadedPDF(id),/改变/);assert.equal(env.importCount,0);assert.equal(env.accepts.length,0);assert.equal(env.messageReads.length,0);assert.equal(env.app.getSnapshot().tasks[0].assistReceipt,null);await env.app.stop();
});

test('failed assistance transfer, PDF storage or receipt persistence never adopts a file',async()=>{
  for(const mode of ['transfer','storage','receipt']){
    const env=completionEnvironment({writePDFError:mode==='storage'});await env.app.start();
    if(mode==='transfer')env.Zotero.HTTP.request=async()=>{throw new Error('fixture network failure');};
    if(mode==='receipt')env.setWriteHook(async(file,value)=>{if(file===queuePath&&JSON.parse(value).tasks.some(task=>task.assistReceipt))throw new Error('fixture receipt disk full');});
    await env.app.downloadTask(env.app.getSnapshot().tasks[0].id);assert.equal(env.accepts.length,0,mode);assert.equal(env.messageReads.length,0,mode);if(mode!=='receipt')assert.equal(env.importCount,0,mode);
    env.setWriteHook(null);await env.app.stop();
  }
});

test('an existing local PDF is preserved without guessing which remote file supplied it',async()=>{
  const env=completionEnvironment();env.installAttachment({id:950});await env.app.start();await env.app.downloadTask(env.app.getSnapshot().tasks[0].id);
  const task=env.app.getSnapshot().tasks[0];assert.equal(task.state,'imported');assert.equal(task.source,'existing');assert.equal(task.attachmentID,950);assert.equal(task.assistReceipt,null);assert.equal(env.httpCalls.length,0);assert.equal(env.importCount,0);assert.equal(env.accepts.length,0);assert.equal(env.messageReads.length,0);await env.app.stop();
});

test('a corrupt existing PDF never blocks valid assistance, manual or browser import',async()=>{
  for(const route of ['assistance','manual','browser']){
    const task=route==='assistance'?remoteFixture():localFixture(),file='C:\\isolated\\selected.pdf';let browserCalls=0;
    const env=completionEnvironment({initialTasks:[task],pickPDF:async()=>file,edgeAcquire:{async acquire(){browserCalls++;return{bytes:env.pdf};}}});
    const corrupt=env.pdf.slice();corrupt[0]=60;const old=env.installAttachment({id:950,bytes:corrupt});env.files.set(file,env.pdf);
    await env.app.start();
    if(route==='assistance')await env.app.downloadTask(task.id);
    else if(route==='manual')await env.app.importLocalPDF(task.id);
    else{await env.app.openExternalTask(task.id);await until(()=>env.app.getSnapshot().tasks[0].state==='imported');}
    const current=env.app.getSnapshot().tasks[0];assert.equal(current.state,'imported',route);assert.equal(current.attachmentID,900,route);assert.equal(env.importCount,1,route);
    assert.equal(sha256(env.files.get(await old.getFilePathAsync())),sha256(corrupt),route);
    assert.equal(sha256(env.files.get(await env.items.get(900).getFilePathAsync())),sha256(env.pdf),route);
    assert.equal(env.accepts.length,route==='assistance'?1:0,route);assert.equal(browserCalls,route==='browser'?1:0,route);
    if(route==='assistance'){assert.equal(current.source,'ablesci');assert.equal(current.assistReceipt.attachmentID,900);assert.equal(current.assistReceipt.messages,'done');}
    await env.app.stop();
  }
});

test('an adoption timeout persists uncertainty and concurrent retries only reconcile without downloading again',async()=>{
  const env=completionEnvironment(),gate=deferred();let sends=0,reconciles=0;
  env.adapter.acceptFile=async options=>{if(!options.reconcileOnly){await options.beforeSend();sends++;throw Object.assign(new Error('adoption timed out'),{reconcileRequired:true});}reconciles++;await gate.promise;return{accepted:true};};
  await env.app.start();const id=env.app.getSnapshot().tasks[0].id;await env.app.downloadTask(id);
  const pending=env.app.getSnapshot().tasks[0];assert.equal(pending.state,'imported');assert.equal(pending.assistReceipt.adoption,'pending');assert.equal(pending.assistReceipt.needsReconcile,true);assert.equal(pending.assistReceipt.attempts,1);assert.equal(env.messageReads.length,0);
  const first=env.app.retryAssistCompletion(id),second=env.app.retryAssistCompletion(id);assert.equal(first,second);await until(()=>reconciles===1);assert.equal(sends,1);gate.resolve();await Promise.all([first,second]);
  assert.equal(env.app.getSnapshot().tasks[0].assistReceipt.messages,'done');assert.equal(env.httpCalls.length,1);assert.equal(env.downloadCalls.length,1);assert.equal(env.importCount,1);assert.equal(env.messageReads.length,1);await env.app.stop();
});

test('message failure after accepted adoption retries only message handling while keeping the imported PDF',async()=>{
  const env=completionEnvironment();let reads=0;env.adapter.markRequestMessagesRead=async()=>{reads++;if(reads===1)throw new Error('messages unavailable');return{completed:true};};
  await env.app.start();const id=env.app.getSnapshot().tasks[0].id;await env.app.downloadTask(id);const pending=env.app.getSnapshot().tasks[0];
  assert.equal(pending.state,'imported');assert.equal(pending.assistReceipt.adoption,'accepted');assert.equal(pending.assistReceipt.messages,'pending');assert.equal(pending.assistReceipt.needsReconcile,false);
  await env.app.retryAssistCompletion(id);assert.equal(reads,2);assert.equal(env.accepts.length,1);assert.equal(env.posts.length,1);assert.equal(env.httpCalls.length,1);assert.equal(env.importCount,1);assert.equal(env.app.getSnapshot().tasks[0].assistReceipt.messages,'done');await env.app.stop();
});

test('a persisted uncertain receipt resumes after restart with only reconciliation and message handling',async()=>{
  const initial=importedReceiptFixture({needsReconcile:true,attempts:2}),env=completionEnvironment({initialTasks:[initial]});env.installAttachment();await env.app.start();await env.app.stop();
  const saved=JSON.parse(env.files.get(queuePath)).tasks,restored=completionEnvironment({initialTasks:saved});restored.installAttachment();await restored.app.start();
  await restored.app.retryAssistCompletion(initial.id);assert.equal(restored.accepts.length,1);assert.equal(restored.accepts[0].reconcileOnly,true);assert.equal(restored.posts.length,0);assert.equal(restored.messageReads.length,1);assert.equal(restored.httpCalls.length,0);assert.equal(restored.importCount,0);assert.equal(restored.app.getSnapshot().tasks[0].assistReceipt.messages,'done');await restored.app.stop();
});

test('unknown assistance PDF review survives restart and can still be previewed and explicitly confirmed',async()=>{
  const identity={async inspect(){return{status:'unknown'};}},env=completionEnvironment({pdfIdentity:identity});await env.app.start();const id=env.app.getSnapshot().tasks[0].id;await env.app.downloadTask(id);await env.app.stop();
  const saved=JSON.parse(env.files.get(queuePath)).tasks;assert.equal(saved[0].state,'manual_review');assert(saved[0].assistReview);
  const restored=completionEnvironment({initialTasks:saved,pdfIdentity:identity});for(const [file,bytes] of env.files)restored.files.set(file,bytes);await restored.app.start();await restored.app.previewDownloadedPDF(id);assert.equal(restored.openedFiles.length,1);
  await restored.app.confirmDownloadedPDF(id);assert.equal(restored.app.getSnapshot().tasks[0].assistReceipt.messages,'done');assert.equal(restored.httpCalls.length,0);assert.equal(restored.importCount,1);assert.equal(restored.accepts.length,1);await restored.app.stop();
});

test('a different account or changed local attachment blocks adoption without redownloading the PDF',async()=>{
  for(const mode of ['account','parent','library','bytes','missing','deleted']){
    const task=importedReceiptFixture(),env=completionEnvironment({initialTasks:[task]}),attachment=env.installAttachment();
    if(mode==='account')env.account.accountID='OtherAccount';
    if(mode==='parent')attachment.parentID=2;if(mode==='library')attachment.libraryID=2;if(mode==='deleted')attachment.deleted=true;
    const file=await attachment.getFilePathAsync();if(mode==='bytes'){const bytes=env.pdf.slice();bytes[100]=49;env.files.set(file,bytes);}if(mode==='missing')env.files.delete(file);
    await env.app.start();const result=await env.app.retryAssistCompletion(task.id);assert.equal(result.completed,false,mode);assert.equal(env.accepts.length,0,mode);assert.equal(env.messageReads.length,0,mode);assert.equal(env.httpCalls.length,0,mode);assert.equal(env.importCount,0,mode);assert.equal(env.app.getSnapshot().tasks[0].state,'imported',mode);await env.app.stop();
  }
});

test('account changes after the adoption send prevent later message writes under the new account',async()=>{
  const task=importedReceiptFixture(),env=completionEnvironment({initialTasks:[task]}),gate=deferred();env.installAttachment();let sent=false;
  env.adapter.acceptFile=async options=>{await options.beforeSend();sent=true;await gate.promise;return{accepted:true};};
  await env.app.start();const completion=env.app.retryAssistCompletion(task.id);await until(()=>sent);await env.app.logout();gate.resolve();const result=await completion;
  assert.equal(result.cancelled,true);assert.equal(env.messageReads.length,0);assert.equal(env.app.getSnapshot().tasks[0].assistReceipt.needsReconcile,true);assert.equal(env.app.getSnapshot().tasks[0].state,'imported');await env.app.stop();
});

test('attachment changes during the adoption preflight are rechecked before the first POST',async()=>{
  const task=importedReceiptFixture(),env=completionEnvironment({initialTasks:[task]}),gate=deferred(),attachment=env.installAttachment();let preflight=false,posts=0;
  env.adapter.acceptFile=async options=>{preflight=true;await gate.promise;await options.beforeSend();posts++;return{accepted:true};};
  await env.app.start();const completion=env.app.retryAssistCompletion(task.id);await until(()=>preflight);
  const bytes=env.pdf.slice();bytes[100]=49;env.files.set(await attachment.getFilePathAsync(),bytes);gate.resolve();const result=await completion;
  assert.equal(result.completed,false);assert.equal(posts,0);assert.equal(env.messageReads.length,0);assert.equal(env.httpCalls.length,0);assert.equal(env.app.getSnapshot().tasks[0].assistReceipt.adoption,'pending');await env.app.stop();
});

test('explicit verification of legacy assistance history requires identical bytes and adopts without another import',async()=>{
  const task=MODEL.updateTask(remoteFixture('imported'),{source:'ablesci',attachmentID:900}),env=completionEnvironment({initialTasks:[task]});env.installAttachment();await env.app.start();
  const result=await env.app.verifyAssistCompletion(task.id);const current=env.app.getSnapshot().tasks[0];
  assert.equal(result.completed,true);assert.equal(current.id,task.id);assert.equal(current.attachmentID,900);assert.equal(current.assistReceipt.sha256,sha256(env.pdf));assert.equal(current.assistReceipt.adoption,'accepted');assert.equal(current.assistReceipt.messages,'done');assert.equal(env.importCount,0);assert.equal(env.downloadCalls.length,1);assert.equal(env.httpCalls.length,1);assert.equal(env.accepts.length,1);await env.app.stop();
});

test('explicit verification of legacy history rejects different remote bytes without replacing or adopting its attachment',async()=>{
  const task=MODEL.updateTask(remoteFixture('imported'),{source:'ablesci',attachmentID:900}),env=completionEnvironment({initialTasks:[task]}),local=env.pdf.slice();local[100]=49;
  const attachment=env.installAttachment({bytes:local}),file=await attachment.getFilePathAsync();await env.app.start();const result=await env.app.verifyAssistCompletion(task.id);const current=env.app.getSnapshot().tasks[0];
  assert.equal(result.completed,false);assert.equal(current.state,'imported');assert.equal(current.id,task.id);assert.equal(current.attachmentID,900);assert.equal(current.completedAt,task.completedAt);assert.equal(current.assistReceipt,null);assert.equal(sha256(env.files.get(file)),sha256(local));assert.equal(env.accepts.length,0);assert.equal(env.messageReads.length,0);assert.equal(env.importCount,0);await env.app.stop();
});

test('snapshot receipt and review evidence are defensive copies and old imported history never gains evidence',async()=>{
  const task=importedReceiptFixture(),env=completionEnvironment({initialTasks:[task]});env.installAttachment();await env.app.start();const snapshot=env.app.getSnapshot();snapshot.tasks[0].assistReceipt.fileID='Changed';snapshot.tasks[0].assistReceipt.sha256='0'.repeat(64);assert.equal(env.app.getSnapshot().tasks[0].assistReceipt.fileID,'File1');assert.equal(env.app.getSnapshot().tasks[0].assistReceipt.sha256,sha256(env.pdf));await env.app.stop();
  const review=completionEnvironment({pdfIdentity:{async inspect(){return{status:'unknown'};}}});await review.app.start();await review.app.downloadTask(review.app.getSnapshot().tasks[0].id);const visible=review.app.getSnapshot();visible.tasks[0].assistReview.accountID='Changed';assert.equal(review.app.getSnapshot().tasks[0].assistReview.accountID,'FixtureAccount');await review.app.stop();
  const legacy=MODEL.updateTask(remoteFixture('imported'),{source:'ablesci',attachmentID:900}),history=completionEnvironment({initialTasks:[legacy]});history.installAttachment();await history.app.start();const before=JSON.stringify(history.app.getSnapshot().tasks[0]);
  await history.app.retryAssistCompletion(legacy.id);await history.app.retryTask(legacy.id);await history.app.checkTask(legacy.id);await history.app.downloadTask(legacy.id);
  assert.equal(JSON.stringify(history.app.getSnapshot().tasks[0]),before);assert.equal(history.accepts.length,0);assert.equal(history.messageReads.length,0);assert.equal(history.httpCalls.length,0);assert.equal(history.importCount,0);await history.app.stop();
});

test('late unread upload notifications reopen only matching account and file completion without downloads or adoption',async()=>{
  const completedAt='2026-11-05T01:00:00.000Z';
  const cases=[
    {name:'matching unread upload',message:{read:false,kind:'assist_upload',fileID:'File1'},reopened:true},
    {name:'already read upload',message:{read:true,kind:'assist_upload',fileID:'File1'}},
    {name:'different file',message:{read:false,kind:'assist_upload',fileID:'File2'}},
    {name:'unrelated message kind',message:{read:false,kind:'other',fileID:'File1'}},
    {name:'request without file evidence',message:{read:false,kind:'assist_upload',requestID:'Request1',fileID:null}},
    {name:'receipt from another account',message:{read:false,kind:'assist_upload',fileID:'File1'},accountID:'AnotherAccount'}
  ];
  for(const entry of cases){
    const task=importedReceiptFixture({verifiedAt:completedAt,adoption:'accepted',acceptedAt:completedAt,messages:'done',readAt:completedAt,accountID:entry.accountID||'FixtureAccount'}),env=completionEnvironment({initialTasks:[task]});
    env.installAttachment();await env.app.start();await env.app.refreshAccount();
    env.adapter.listMessages=async()=>[{id:'LateMessage',title:'Fixture upload notice',...entry.message}];
    const before=env.app.getSnapshot().tasks[0];await env.app.refreshMessages();
    const current=env.app.getSnapshot().tasks[0],saved=JSON.parse(env.files.get(queuePath)).tasks[0];
    assert.equal(current.assistReceipt.messages,entry.reopened?'pending':'done',entry.name);
    assert.equal(current.assistReceipt.readAt,entry.reopened?null:completedAt,entry.name);
    assert.equal(saved.assistReceipt.messages,current.assistReceipt.messages,entry.name);
    assert.equal(current.assistReceipt.adoption,'accepted',entry.name);assert.equal(current.assistReceipt.acceptedAt,completedAt,entry.name);
    assert.equal(current.id,before.id,entry.name);assert.equal(current.attachmentID,before.attachmentID,entry.name);assert.equal(current.completedAt,before.completedAt,entry.name);
    assert.equal(env.accepts.length,0,entry.name);assert.equal(env.posts.length,0,entry.name);assert.equal(env.messageReads.length,0,entry.name);assert.equal(env.httpCalls.length,0,entry.name);assert.equal(env.downloadCalls.length,0,entry.name);assert.equal(env.importCount,0,entry.name);
    await env.app.stop();
  }
});

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

test('manual check resumes a paused remote task without publishing or replacing its parent title',async()=>{
  const task=MODEL.updateTask(remoteFixture('paused'),{title:'User chosen title',lastError:'Previously paused',nextCheckAt:'2099-01-01T00:00:00Z'}),env=environment({initialTasks:[task]});env.addItem(item(1));
  env.adapter.getRequest=async id=>{env.remoteRequests.push(id);const current=env.app.getSnapshot().tasks[0];assert.equal(current.state,'ready_to_check');assert.equal(current.lastError,'');assert.equal(current.nextCheckAt,null);return {requestID:id,doi:task.doi,title:'Title from request detail',state:'waiting',files:[]};};
  await env.app.start();await env.app.checkTask(task.id);const current=env.app.getSnapshot().tasks[0];
  assert.equal(current.state,'waiting');assert.ok(current.lastCheckedAt);assert.ok(current.nextCheckAt);assert.equal(current.title,task.title);assert.equal(env.remoteRequests.length,1);assert.equal(env.submissions.length,0);assert.equal(env.publisherCalls.length,0);await env.app.stop();
});

test('manual check refreshes the real title of an unbound tracked request',async()=>{
  const task=MODEL.createTask({requestURL:'https://www.ablesci.com/assist/detail?id=Request1',state:'paused',title:'Legacy request placeholder'}),env=environment({initialTasks:[task]});
  env.adapter.getRequest=async id=>({requestID:id,doi:'10.1234/paper1',title:'Actual request title',state:'waiting',files:[]});
  await env.app.start();await env.app.checkTask(task.id);const current=env.app.getSnapshot().tasks[0];
  assert.equal(current.state,'waiting');assert.equal(current.title,'Actual request title');assert.equal(current.doi,'10.1234/paper1');assert.equal(current.itemID,null);assert.equal(env.submissions.length,0);await env.app.stop();
});

test('a resumed manual check cannot overwrite a newer pause when its response arrives',async()=>{
  const task=remoteFixture('paused'),gate=deferred(),env=environment({initialTasks:[task]});env.addItem(item(1));
  env.adapter.getRequest=async id=>{env.remoteRequests.push(id);await gate.promise;return {requestID:id,doi:task.doi,title:'Late title',state:'waiting',files:[]};};
  await env.app.start();const check=env.app.checkTask(task.id);await until(()=>env.remoteRequests.length===1);await env.app.pauseTask(task.id);const paused=env.app.getSnapshot().tasks[0];gate.resolve();await check;
  assert.deepEqual(env.app.getSnapshot().tasks[0],paused);assert.equal(paused.state,'paused');assert.equal(paused.nextCheckAt,null);assert.equal(env.submissions.length,0);await env.app.stop();
});

test('manual check leaves an already active task unchanged and does not start another read',async()=>{
  const task=remoteFixture('waiting'),gate=deferred(),env=environment({initialTasks:[task]});env.addItem(item(1));
  env.adapter.getRequest=async id=>{env.remoteRequests.push(id);await gate.promise;return {requestID:id,doi:task.doi,state:'waiting',files:[]};};
  await env.app.start();const first=env.app.checkTask(task.id);await until(()=>env.remoteRequests.length===1);const before=env.app.getSnapshot().tasks[0];await env.app.checkTask(task.id);
  assert.deepEqual(env.app.getSnapshot().tasks[0],before);assert.equal(env.remoteRequests.length,1);gate.resolve();await first;assert.equal(env.submissions.length,0);await env.app.stop();
});

test('pausing while a resumed check is being persisted prevents the remote read',async()=>{
  const task=remoteFixture('paused'),gate=deferred(),env=environment({initialTasks:[task]});env.addItem(item(1));let held=false;
  await env.app.start();env.setWriteHook(async(file,value)=>{if(!held&&file===queuePath&&JSON.parse(value).tasks[0].state==='ready_to_check'){held=true;await gate.promise;}});
  const check=env.app.checkTask(task.id);await until(()=>held);const pause=env.app.pauseTask(task.id);gate.resolve();await Promise.all([check,pause]);
  assert.equal(env.app.getSnapshot().tasks[0].state,'paused');assert.equal(env.remoteRequests.length,0);assert.equal(env.submissions.length,0);assert.equal(JSON.parse(env.files.get(queuePath)).tasks[0].state,'paused');await env.app.stop();
});

test('completed history survives startup without rewriting its completion date',async()=>{
  const old=MODEL.createTask({libraryID:1,itemID:1,itemKey:'ITEM1',doi:'10.1234/paper1',state:'imported',attachmentID:901},{now:()=> '2026-10-01T00:00:00.000Z'});
  const env=environment({initialTasks:[old]});await env.app.start();const stored=env.app.getSnapshot().tasks[0];
  assert.equal(stored.completedAt,old.updatedAt);assert.equal(stored.updatedAt,old.updatedAt);await env.app.stop();
  assert.equal(JSON.stringify(MODEL.deserializeQueue(env.files.get(queuePath)).tasks[0]),JSON.stringify(MODEL.sanitizeTask(stored)));
});

test('available standalone request stays unimported until the user confirms a matching item',async()=>{
  const task=MODEL.createTask({doi:'10.1234/paper1',requestURL:'https://www.ablesci.com/assist/detail?id=Request1',state:'available'});
  const env=environment({initialTasks:[task]});env.addItem(item(1));env.addItem(item(2));availableDownload(env);
  await env.app.start();await env.app.refreshAccount();await env.app.checkTask(task.id);
  assert.equal(env.importCount,0);assert.equal(env.app.getSnapshot().tasks[0].itemID,null);
  const candidates=await env.app.getBindingCandidates(task.id);assert.deepEqual(Array.from(candidates,c=>c.itemID),[1]);
  await env.app.bindExistingTask(task.id,1);assert.equal(env.app.getSnapshot().tasks[0].state,'imported');
  assert.equal(env.imports[0].parentItemID,1);assert.equal(env.submissions.length,0);await env.app.stop();
});

test('explicit binding respects automatic-download-off and merges a prior item task',async()=>{
  const track=MODEL.createTask({doi:'10.1234/paper1',requestURL:'https://www.ablesci.com/assist/detail?id=Request1',state:'available'});
  const parent=MODEL.createTask({doi:'10.1234/paper1',libraryID:1,itemID:1,itemKey:'ITEM1',state:'not_found'});
  const env=environment({initialTasks:[track,parent]});env.addItem(item(1));availableDownload(env);
  await env.app.start();await env.app.saveSettings({autoDownload:false});await env.app.refreshAccount();
  const linked=await env.app.bindExistingTask(track.id,1);assert.equal(linked.id,parent.id);assert.equal(linked.state,'available');assert.equal(linked.requestID,'Request1');
  assert.equal(env.app.getSnapshot().tasks.length,1);assert.equal(env.importCount,0);assert.equal(env.submissions.length,0);await env.app.stop();
});

test('binding rejects mismatched or read-only items without changing the standalone tracker',async()=>{
  const task=MODEL.createTask({doi:'10.1234/paper1',requestURL:'https://www.ablesci.com/assist/detail?id=Request1',state:'available'});
  const env=environment({initialTasks:[task]});env.addItem(item(1));env.addItem(item(2));availableDownload(env);await env.app.start();
  await assert.rejects(env.app.bindExistingTask(task.id,2),/DOI/);assert.equal(env.app.getSnapshot().tasks[0].itemID,null);
  env.Zotero.Libraries.get=()=>({editable:true,filesEditable:false});assert.equal((await env.app.getBindingCandidates(task.id)).length,0);
  await assert.rejects(env.app.bindExistingTask(task.id,1),/不可写/);assert.equal(env.importCount,0);assert.equal(env.submissions.length,0);await env.app.stop();
});

test('a raw file timeout stays scheduled with increasing backoff and recovers without another request',async()=>{
  const task=remoteFixture(),env=environment({initialTasks:[task]});env.addItem(item(1));availableDownload(env);
  const request=env.Zotero.HTTP.request;let timeoutSeen=0;
  env.Zotero.HTTP.request=async(method,url,options)=>{timeoutSeen=options.timeout;const e=new Error('request timed out');e.name='TimeoutException';throw e;};
  await env.app.start();await env.app.refreshAccount();await env.app.checkTask(task.id);
  let current=env.app.getSnapshot().tasks[0];assert.equal(current.state,'waiting');assert.equal(current.attempts,1);assert.match(current.lastError,/下载超时/);assert.equal(timeoutSeen,180000);
  await env.app.checkTask(task.id);current=env.app.getSnapshot().tasks[0];assert.equal(current.attempts,2);assert.match(current.lastError,/120 秒后重试/);
  env.Zotero.HTTP.request=request;await env.app.checkTask(task.id);current=env.app.getSnapshot().tasks[0];assert.equal(current.state,'imported');assert.equal(current.attempts,0);assert.equal(env.importCount,1);assert.equal(env.submissions.length,0);await env.app.stop();
});

test('verified highspeed transport failure asks for a fresh fallback descriptor',async()=>{
  const task=remoteFixture(),env=environment({initialTasks:[task]});env.addItem(item(1));availableDownload(env);const options=[];
  env.adapter.getDownload=async(result,file,opt)=>{options.push(opt);return{url:'https://download.test/paper.pdf',method:'GET',route:'highspeed',transport:opt.fallback?'cdn':'vip',canFallback:!opt.fallback,allowedOrigins:['https://download.test'],timeoutMs:240000};};
  const request=env.Zotero.HTTP.request;let calls=0;
  env.Zotero.HTTP.request=async(...args)=>{calls++;if(calls===1){const e=new Error('network interrupted');e.status=503;throw e;}return request(...args);};
  await env.app.start();await env.app.refreshAccount();await env.app.checkTask(task.id);
  assert.equal(options.length,2);assert.equal(options[0].route,'auto-free');assert.equal(options[1].fallback,true);assert.equal(typeof options[1].isCancelled,'function');
  assert.equal(env.app.getSnapshot().tasks[0].state,'imported');assert.equal(env.app.getSnapshot().tasks[0].downloadRoute,'highspeed');assert.equal(env.importCount,1);await env.app.stop();
});

test('a CDN descriptor cannot admit a lookalike redirect domain',async()=>{
  const task=remoteFixture(),env=environment({initialTasks:[task]});env.addItem(item(1));availableDownload(env);
  env.adapter.getDownload=async()=>({url:'https://download.test/paper.pdf',route:'highspeed',transport:'cdn',allowedRedirectDomain:'ablesci.com',allowedOrigins:['https://download.test']});
  const request=env.Zotero.HTTP.request;env.Zotero.HTTP.request=async(...args)=>({...await request(...args),responseURL:'https://ablesci.com.evil.test/paper.pdf'});
  await env.app.start();await env.app.refreshAccount();await env.app.checkTask(task.id);assert.equal(env.importCount,0);assert.equal(env.app.getSnapshot().tasks[0].state,'error');await env.app.stop();
});

function localFixture(){return MODEL.createTask({libraryID:1,itemID:1,itemKey:'ITEM1',doi:'10.1234/paper1',title:'Expected paper',state:'needs_login'});}
test('normal download timeout retries a different offered server once',async()=>{
  const task=remoteFixture(),env=environment({initialTasks:[task]});env.addItem(item(1));availableDownload(env);const options=[];
  env.adapter.getDownload=async(result,file,opt)=>{options.push(opt);return{url:'https://download.test/paper.pdf',method:'GET',route:'normal',transport:'normal',normalServerIndex:opt.normalServerIndex||0,normalServerCount:3,allowedOrigins:['https://download.test']};};
  const request=env.Zotero.HTTP.request;let calls=0;
  env.Zotero.HTTP.request=async(...args)=>{if(++calls===1){const e=new Error('request timed out');e.name='TimeoutException';throw e;}return request(...args);};
  await env.app.start();await env.app.refreshAccount();await env.app.checkTask(task.id);
  assert.equal(options.length,2);assert.equal(options[1].route,'normal');assert.equal(options[1].normalServerIndex,1);assert.equal(env.app.getSnapshot().tasks[0].state,'imported');assert.equal(env.importCount,1);await env.app.stop();
});

test('failed message refresh preserves the last successful refresh date',async()=>{
  const env=environment();await env.app.start();await env.app.refreshAccount();
  env.adapter.listMessages=async()=>[];await env.app.refreshMessages();const successful=env.app.getSnapshot().messagesStatus.lastCheckedAt;
  env.adapter.listMessages=async()=>{throw new Error('temporary network failure');};await assert.rejects(env.app.refreshMessages(),/network/);
  const status=env.app.getSnapshot().messagesStatus;assert.equal(status.state,'error');assert.equal(status.lastCheckedAt,successful);assert.ok(status.lastAttemptAt);await env.app.stop();
});

test('cancelling while checking an existing local PDF preserves the paused state',async()=>{
  const task=localFixture(),env=environment({initialTasks:[task]}),gate=deferred();let checking=false;
  const parent=env.addItem(item(1)),file='C:\\isolated\\existing.pdf';parent.getAttachments=()=>[901];env.files.set(file,env.pdf);
  env.addItem({id:901,parentID:1,libraryID:1,attachmentContentType:'application/pdf',async getFilePathAsync(){checking=true;await gate.promise;return file;}});
  await env.app.start();const importing=env.app.importLocalPDF(task.id);await until(()=>checking);const pausing=env.app.pauseTask(task.id);gate.resolve();
  await Promise.all([pausing,assert.rejects(importing,/取消/)]);assert.equal(env.app.getSnapshot().tasks[0].state,'paused');assert.equal(env.importCount,0);await env.app.stop();
});

test('cancelled manual PDF selection preserves the task exactly',async()=>{
  const task=localFixture(),env=environment({initialTasks:[task],pickPDF:async()=>null});env.addItem(item(1));await env.app.start();const before=env.app.getSnapshot().tasks[0];
  const result=await env.app.importLocalPDF(task.id);assert.equal(result.cancelled,true);assert.deepEqual(env.app.getSnapshot().tasks[0],before);assert.equal(env.importCount,0);await env.app.stop();
});

test('manual PDF selection validates bytes and imports into the explicit original parent',async()=>{
  const task=localFixture(),file='C:\\isolated\\chosen.pdf',env=environment({initialTasks:[task],pickPDF:async()=>file});env.addItem(item(1));
  env.files.set(file,new TextEncoder().encode('%PDF-1.7\n'+'x'.repeat(1500)+'\n%%EOF'));await env.app.start();
  const result=await env.app.importLocalPDF(task.id);assert.equal(result.cancelled,false);assert.equal(result.attachmentID,900);assert.equal(env.imports[0].parentItemID,1);
  const stored=env.app.getSnapshot().tasks[0];assert.equal(stored.state,'imported');assert.equal(stored.source,'local_file');assert.ok(stored.completedAt);assert.equal(env.submissions.length,0);await env.app.stop();
});

test('manual PDF rejects an HTML file and a DOI changed while the picker was open',async()=>{
  const task=localFixture(),file='C:\\isolated\\chosen.pdf',env=environment({initialTasks:[task],pickPDF:async()=>file});const parent=env.addItem(item(1));env.files.set(file,new TextEncoder().encode('<html>'+'x'.repeat(1500)));
  await env.app.start();await assert.rejects(env.app.importLocalPDF(task.id),/PDF/);assert.equal(env.importCount,0);
  env.files.set(file,new TextEncoder().encode('%PDF-1.7\n'+'x'.repeat(1500)+'\n%%EOF'));
  const oldRead=env.IOUtils.read;env.IOUtils.read=async path=>{const bytes=await oldRead(path);const old=parent.getField;parent.getField=name=>name==='DOI'?'10.1234/changed':old(name);return bytes;};
  await assert.rejects(env.app.importLocalPDF(task.id),/DOI/);assert.equal(env.importCount,0);await env.app.stop();
});

test('browser start returns while human verification is pending and imports into original parent',async()=>{
  const gate=deferred();let called=0,focus=0,progress;
  const task={...localFixture(),allowAssist:true},env=environment({initialTasks:[task],edgeAcquire:{async acquire(value,options){called++;assert.equal(value.id,task.id);progress=options;await options.onProgress({state:'browser_waiting',message:'waiting for human'});return gate.promise;},async focus(){focus++;}}});
  env.addItem(item(1));await env.app.start();assert.equal((await env.app.openExternalTask(task.id)).started,true);await until(()=>called===1);
  assert.equal(env.app.getSnapshot().tasks[0].state,'browser_waiting');await env.app.openExternalTask(task.id);assert.equal(called,1);assert.equal(focus,1);
  await progress.onProgress({state:'browser_downloading',message:'downloading'});gate.resolve({bytes:new TextEncoder().encode('%PDF-1.7\n'+'x'.repeat(1500)+'\n%%EOF')});
  await until(()=>env.app.getSnapshot().tasks[0].state==='imported');assert.equal(env.imports[0].parentItemID,1);assert.equal(env.app.getSnapshot().tasks[0].source,'edge_browser');assert.equal(env.submissions.length,0);await env.app.stop();
});

test('browser cancellation prevents late PDF import and preserves history',async()=>{
  const gate=deferred();let began=false;
  const task=localFixture(),env=environment({initialTasks:[task],edgeAcquire:{async acquire(){began=true;return gate.promise;}}});env.addItem(item(1));await env.app.start();await env.app.openExternalTask(task.id);await until(()=>began);
  const pausing=env.app.pauseTask(task.id);gate.resolve({bytes:new TextEncoder().encode('%PDF-1.7\n'+'x'.repeat(1500)+'\n%%EOF')});await pausing;
  assert.equal(env.importCount,0);assert.equal(env.app.getSnapshot().tasks[0].state,'paused');assert.equal(MODEL.deserializeQueue(env.files.get(queuePath)).tasks[0].acquisitionMode,'browser');await env.app.stop();
});

test('legacy browser restart is paused with its old mode cleared until an explicit action',async()=>{
  const task={...localFixture(),state:'browser_scanning',acquisitionMode:'browser',allowAssist:true};let calls=0;
  const env=environment({initialTasks:[task],edgeAcquire:{async acquire(){calls++;throw new Error('Browser closed');}}});env.addItem(item(1));await env.app.start();await settle();
  const stored=env.app.getSnapshot().tasks[0];assert.equal(stored.state,'paused');assert.equal(stored.acquisitionMode,'');assert.match(stored.lastError,/已停用专用 Edge/);
  assert.equal(calls,0);assert.equal(env.publisherCalls.length,0);assert.equal(env.submissions.length,0);
  await env.app.openSystemBrowserTask(task.id);assert.equal(env.app.getSnapshot().tasks[0].state,'manual_waiting');assert.equal(env.app.getSnapshot().tasks[0].acquisitionMode,'manual');assert.equal(calls,0);await env.app.stop();
});

test('browser validates PDF and rechecks DOI before committing attachment',async()=>{
  const task=localFixture();let change=false,response={bytes:new TextEncoder().encode('<html>'+'x'.repeat(1500))};
  const env=environment({initialTasks:[task],edgeAcquire:{async acquire(){if(change){const old=parent.getField;parent.getField=name=>name==='DOI'?'10.1234/changed':old(name);}return response;}}});const parent=env.addItem(item(1));await env.app.start();await env.app.openExternalTask(task.id);await until(()=>env.app.getSnapshot().tasks[0].state==='error');assert.equal(env.importCount,0);
  response={bytes:new TextEncoder().encode('%PDF-1.7\n'+'x'.repeat(1500)+'\n%%EOF')};change=true;
  await env.app.openExternalTask(task.id);await until(()=>env.app.getSnapshot().tasks[0].state==='error');assert.match(env.app.getSnapshot().tasks[0].lastError,/DOI/);assert.equal(env.importCount,0);await env.app.stop();
});

test('shutdown waits for a committing browser attachment and leaves no late history writes',async()=>{
  const gate=deferred();let committing=false,stopped=false,writes=0;
  const task=localFixture(),env=environment({initialTasks:[task],edgeAcquire:{async acquire(){return{bytes:new TextEncoder().encode('%PDF-1.7\n'+'x'.repeat(1500)+'\n%%EOF')};}}});env.addItem(item(1));
  const original=env.Zotero.Attachments.importFromFile;env.Zotero.Attachments.importFromFile=async options=>{committing=true;await gate.promise;return original(options);};
  env.setWriteHook(()=>{if(stopped)writes++;});await env.app.start();await env.app.openExternalTask(task.id);await until(()=>committing);
  const stopping=env.app.stop().then(()=>{stopped=true;});await settle();assert.equal(stopped,false);gate.resolve();await stopping;await settle();
  assert.equal(writes,0);assert.equal(env.app.getSnapshot().tasks[0].state,'imported');assert.equal(MODEL.deserializeQueue(env.files.get(queuePath)).tasks[0].attachmentID,900);
});

test('an existing AbleSci request cannot enter the browser route',async()=>{
  const task={...localFixture(),requestID:'Existing',requestURL:'https://www.ablesci.com/assist/detail?id=Existing'};
  const env=environment({initialTasks:[task],edgeAcquire:{async acquire(){throw new Error('must not open');}}});env.addItem(item(1));await env.app.start();
  await assert.rejects(env.app.openExternalTask(task.id),/已关联科研通/);assert.equal(env.app.getSnapshot().tasks[0].acquisitionMode,'');await env.app.stop();
});

test('browser launch refreshes a formerly missing DOI and rejects a change during acquisition',async()=>{
  const task={...localFixture(),doi:''},gate=deferred();let captured;
  const env=environment({initialTasks:[task],edgeAcquire:{async acquire(value){captured=value;return gate.promise;}}});const parent=env.addItem(item(1));await env.app.start();await env.app.openExternalTask(task.id);await until(()=>captured);
  assert.equal(captured.doi,'10.1234/paper1');const get=parent.getField;parent.getField=name=>name==='DOI'?'10.1234/another':get(name);
  gate.resolve({bytes:new TextEncoder().encode('%PDF-1.7\n'+'x'.repeat(1500)+'\n%%EOF')});await until(()=>env.app.getSnapshot().tasks[0].state==='error');assert.equal(env.importCount,0);await env.app.stop();
});

test('browser download without DOI rechecks the title immediately before committing',async()=>{
  const task={...localFixture(),doi:''},gate=deferred();let started=false;
  const env=environment({initialTasks:[task],edgeAcquire:{async acquire(){started=true;return gate.promise;}}});const parent=env.addItem(item(1)),get=parent.getField;let title='A long exact paper title without any DOI';parent.getField=name=>name==='DOI'?'':name==='title'?title:get(name);
  await env.app.start();await env.app.openExternalTask(task.id);await until(()=>started);title='A completely different long paper title';gate.resolve({bytes:new TextEncoder().encode('%PDF-1.7\n'+'x'.repeat(1500)+'\n%%EOF')});
  await until(()=>env.app.getSnapshot().tasks[0].state==='error');assert.equal(env.importCount,0);assert.match(env.app.getSnapshot().tasks[0].lastError,/身份已改变/);await env.app.stop();
});

test('shutdown still closes Edge and clears sessions if queue storage fails',async()=>{
  let closed=0;const env=environment({edgeHost:{async destroy(){closed++;}}});await env.app.start();env.setWriteHook(()=>{throw new Error('disk full');});
  await assert.rejects(env.app.stop(),/disk full/);assert.equal(closed,1);assert.equal(env.session.destroyed,true);assert.equal(env.menus.size,0);
});

test('two historical browser tasks for the same Zotero item cannot run together',async()=>{
  const first=localFixture(),second=MODEL.createTask({...first,id:undefined,doi:'10.1234/old'},{id:'second-browser-task'}),gate=deferred();let calls=0;
  const env=environment({initialTasks:[first,second],edgeAcquire:{async acquire(){calls++;return gate.promise;}}});env.addItem(item(1));await env.app.start();await env.app.openExternalTask(first.id);await until(()=>calls===1);
  await assert.rejects(env.app.openExternalTask(second.id),/同一文献/);assert.equal(calls,1);const pausing=env.app.pauseTask(first.id);gate.resolve({bytes:new Uint8Array()});await pausing;await env.app.stop();
});

test('default browser handoff uses the current article and never starts automated acquisition or a request',async()=>{
  const task={...localFixture(),allowAssist:true},opened=[];
  const env=environment({initialTasks:[task],edgeAcquire:{async acquire(){throw new Error('must not automate');}}});
  const parent=env.addItem(item(1)),get=parent.getField;parent.getField=name=>name==='url'?'https://publisher.test/current-paper':get(name);
  env.Zotero.launchURL=url=>opened.push(url);await env.app.start();
  assert.equal((await env.app.openSystemBrowserTask(task.id)).opened,true);
  assert.deepEqual(opened,['https://publisher.test/current-paper']);assert.equal(env.submissions.length,0);assert.equal(env.publisherCalls.length,0);assert.equal(env.importCount,0);
  const saved=MODEL.deserializeQueue(env.files.get(queuePath)).tasks[0];assert.equal(saved.state,'manual_waiting');assert.equal(saved.acquisitionMode,'manual');assert.match(saved.lastError,/下载文件夹/);
  await env.app.stop();
});

test('default browser waits for cancellation cleanup and does not close another task browser',async()=>{
  const task=localFixture(),gate=deferred(),opened=[];let began=false,cancelled=0,hostClosed=0,finished=false;
  const env=environment({initialTasks:[task],edgeHost:{async destroy(){hostClosed++;}},edgeAcquire:{async acquire(){began=true;return gate.promise;},cancel(){cancelled++;}}});
  env.addItem(item(1));env.Zotero.launchURL=url=>opened.push(url);await env.app.start();await env.app.openExternalTask(task.id);await until(()=>began);
  const first=env.app.openSystemBrowserTask(task.id),second=env.app.openSystemBrowserTask(task.id);assert.equal(first,second);first.then(()=>finished=true);
  await until(()=>cancelled===1);await settle();assert.equal(finished,false);assert.equal(opened.length,0);
  await assert.rejects(env.app.openExternalTask(task.id),/切换/);
  gate.resolve({bytes:new TextEncoder().encode('%PDF-1.7\n'+'x'.repeat(1500)+'\n%%EOF')});await first;
  assert.equal(opened.length,1);assert.equal(env.importCount,0);assert.equal(hostClosed,0);assert.equal(env.app.getSnapshot().tasks[0].state,'manual_waiting');await env.app.stop();
});

test('default browser handoff falls back to DOI and rejects unsafe article URLs without opening',async()=>{
  for(const url of ['', 'javascript:alert(1)', 'file:///private.pdf', 'https://user:secret@publisher.test/paper']){
    const task=localFixture(),env=environment({initialTasks:[task]}),opened=[];const parent=env.addItem(item(1)),get=parent.getField;
    parent.getField=name=>name==='url'?url:get(name);env.Zotero.launchURL=value=>opened.push(value);await env.app.start();
    if(url) {await assert.rejects(env.app.openSystemBrowserTask(task.id),/地址/);assert.equal(opened.length,0);}
    else {await env.app.openSystemBrowserTask(task.id);assert.deepEqual(opened,['https://doi.org/10.1234/paper1']);}
    await env.app.stop();
  }
});

test('a newer pause cancels a handoff while the old browser operation is still stopping',async()=>{
  const task=localFixture(),gate=deferred(),opened=[];let began=false,cancelled=0;
  const env=environment({initialTasks:[task],edgeAcquire:{async acquire(){began=true;return gate.promise;},cancel(){cancelled++;}}});env.addItem(item(1));env.Zotero.launchURL=url=>opened.push(url);
  await env.app.start();await env.app.openExternalTask(task.id);await until(()=>began);
  const handoff=env.app.openSystemBrowserTask(task.id),rejected=assert.rejects(handoff,/切换已取消/);await until(()=>cancelled===1);
  const pause=env.app.pauseTask(task.id);gate.resolve({bytes:new Uint8Array()});await Promise.all([pause,rejected]);
  assert.equal(opened.length,0);assert.equal(env.app.getSnapshot().tasks[0].state,'paused');await env.app.stop();
});

test('default browser cannot hijack an existing assistance request or a deleted library item',async()=>{
  for(const hasRequest of [false,true]){
    const task={...localFixture(),...(hasRequest?{requestID:'Existing',requestURL:'https://www.ablesci.com/assist/detail?id=Existing'}:{})};
    const env=environment({initialTasks:[task]});const parent=env.addItem(item(1));if(!hasRequest)parent.deleted=true;
    env.Zotero.launchURL=()=>{throw new Error('must not open');};await env.app.start();
    await assert.rejects(env.app.openSystemBrowserTask(task.id),hasRequest?/科研通/:/删除/);assert.equal(env.submissions.length,0);await env.app.stop();
  }
});

test('pause waits for browser cleanup before local PDF import is available',async()=>{
  const task=localFixture(),gate=deferred();let began=false,finished=false;
  const env=environment({initialTasks:[task],pickPDF:async()=>null,edgeAcquire:{async acquire(){began=true;return gate.promise;}}});env.addItem(item(1));await env.app.start();await env.app.openExternalTask(task.id);await until(()=>began);
  const pausing=env.app.pauseTask(task.id).then(()=>{finished=true;});await settle();assert.equal(finished,false);await assert.rejects(env.app.importLocalPDF(task.id),/仍在处理/);
  gate.resolve({bytes:new Uint8Array()});await pausing;assert.equal((await env.app.importLocalPDF(task.id)).cancelled,true);await env.app.stop();
});

test('missing browser page reports an actionable error without silently launching a second browser',async()=>{
  const task=localFixture(),gate=deferred();let began=false,calls=0;
  const env=environment({initialTasks:[task],edgeAcquire:{async acquire(){calls++;began=true;return gate.promise;},async focus(){return false;}}});env.addItem(item(1));await env.app.start();
  await assert.rejects(env.app.focusExternalTask(task.id),/已停止/);assert.equal(calls,0);
  await env.app.openExternalTask(task.id);await until(()=>began);await assert.rejects(env.app.focusExternalTask(task.id),/未就绪或已关闭/);assert.equal(calls,1);
  const pausing=env.app.pauseTask(task.id);gate.resolve({bytes:new Uint8Array()});await pausing;await env.app.stop();
});

test('manual selection rejects a mismatched PDF without creating a confirmation override',async()=>{
  const task=localFixture(),file='C:\\isolated\\wrong.pdf';let inspected=0;
  const env=environment({initialTasks:[task],pickPDF:async()=>file,pdfIdentity:{async inspect(value,paper,{bytes}){inspected++;assert.equal(value,file);assert.equal(paper.doi,task.doi);assert(bytes.length>1024);return {status:'mismatch',message:'DOI differs'};}}});
  env.addItem(item(1));env.files.set(file,env.pdf);await env.app.start();
  await assert.rejects(env.app.importLocalPDF(task.id),/不匹配/);
  assert.equal(inspected,1);assert.equal(env.importCount,0);assert.equal(env.app.getSnapshot().tasks[0].state,'error');
  assert.equal(env.app.getSnapshot().tasks[0].pendingFilename,undefined);assert.throws(()=>env.app.confirmDownloadedPDF(task.id),/没有待确认/);await env.app.stop();
});

test('an unknown selected PDF offers preview and requires explicit confirmation before import',async()=>{
  const task=localFixture(),file='C:\\isolated\\scan.pdf';let inspected=0;
  const env=environment({initialTasks:[task],pickPDF:async()=>file,pdfIdentity:{async inspect(){inspected++;return {status:'unknown',message:'No text',summary:'Scanned document; inspect the first page'};}}});
  env.addItem(item(1));env.files.set(file,env.pdf);await env.app.start();
  const result=await env.app.importLocalPDF(task.id);assert.equal(result.needsReview,true);assert.equal(env.importCount,0);
  const pending=env.app.getSnapshot().tasks[0];assert.equal(pending.state,'manual_review');assert.equal(pending.acquisitionMode,'manual');assert.equal(pending.pendingFilename,'scan.pdf');assert.match(pending.pendingSummary,/Scanned/);
  assert.doesNotMatch(JSON.stringify(pending),/C:\\\\isolated|digest/);assert.equal(MODEL.deserializeQueue(env.files.get(queuePath)).tasks[0].pendingFilename,undefined);
  await env.app.previewDownloadedPDF(task.id);assert.deepEqual(env.openedFiles,[file]);assert.equal(env.importCount,0);
  await env.app.confirmDownloadedPDF(task.id);assert.equal(inspected,2);assert.equal(env.importCount,1);assert.equal(env.imports[0].parentItemID,1);
  assert.equal(env.app.getSnapshot().tasks[0].state,'imported');assert.equal(env.app.getSnapshot().tasks[0].pendingFilename,undefined);await env.app.stop();
});

test('confirming an unknown PDF rejects a same-size file replaced since review',async()=>{
  const task=localFixture(),file='C:\\isolated\\scan.pdf';
  const env=environment({initialTasks:[task],pickPDF:async()=>file,pdfIdentity:{async inspect(){return {status:'unknown',message:'No text'};}}});
  env.addItem(item(1));env.files.set(file,env.pdf);await env.app.start();await env.app.importLocalPDF(task.id);
  const replacement=env.pdf.slice();replacement[100]=49;assert.equal(replacement.length,env.pdf.length);env.files.set(file,replacement);
  await assert.rejects(env.app.confirmDownloadedPDF(task.id),/已改变/);assert.equal(env.importCount,0);assert.equal(env.app.getSnapshot().tasks[0].pendingFilename,undefined);await env.app.stop();
});

test('dismissing an unknown selected PDF removes review state without importing',async()=>{
  const task=localFixture(),file='C:\\isolated\\scan.pdf';
  const env=environment({initialTasks:[task],pickPDF:async()=>file,pdfIdentity:{async inspect(){return {status:'unknown'};}}});
  env.addItem(item(1));env.files.set(file,env.pdf);await env.app.start();await env.app.importLocalPDF(task.id);await env.app.dismissDownloadedPDF(task.id);
  assert.equal(env.importCount,0);assert.equal(env.app.getSnapshot().tasks[0].state,'paused');assert.equal(env.app.getSnapshot().tasks[0].pendingFilename,undefined);assert.throws(()=>env.app.confirmDownloadedPDF(task.id),/没有待确认/);await env.app.stop();
});

test('pause during identity extraction blocks a late match or unknown review',async()=>{
  for(const status of ['match','unknown']){
    const task=localFixture(),file='C:\\isolated\\late.pdf',gate=deferred();let began=false;
    const env=environment({initialTasks:[task],pickPDF:async()=>file,pdfIdentity:{async inspect(){began=true;await gate.promise;return {status};}}});
    env.addItem(item(1));env.files.set(file,env.pdf);await env.app.start();const importing=env.app.importLocalPDF(task.id);await until(()=>began);
    const rejected=assert.rejects(importing,/取消/),pausing=env.app.pauseTask(task.id);gate.resolve();await Promise.all([rejected,pausing]);
    assert.equal(env.importCount,0);assert.equal(env.app.getSnapshot().tasks[0].state,'paused');assert.equal(env.app.getSnapshot().tasks[0].pendingFilename,undefined);await env.app.stop();
  }
});

test('shutdown waits for identity extraction and prevents late review or attachment writes',async()=>{
  const task=localFixture(),file='C:\\isolated\\late.pdf',gate=deferred();let began=false,finished=false;
  const env=environment({initialTasks:[task],pickPDF:async()=>file,pdfIdentity:{async inspect(){began=true;await gate.promise;return {status:'unknown'};}}});
  env.addItem(item(1));env.files.set(file,env.pdf);await env.app.start();const importing=env.app.importLocalPDF(task.id);await until(()=>began);
  const rejected=assert.rejects(importing,/取消/),stopping=env.app.stop().then(()=>{finished=true;});await settle();assert.equal(finished,false);gate.resolve();await Promise.all([rejected,stopping]);
  assert.equal(env.importCount,0);assert.equal(env.app.getSnapshot().tasks[0].pendingFilename,undefined);assert.notEqual(env.app.getSnapshot().tasks[0].state,'manual_review');
});

test('pause during an unknown PDF fingerprint prevents stale pending review from reappearing',async()=>{
  const task=localFixture(),file='C:\\isolated\\scan.pdf',gate=deferred();let hashing=false;
  const env=environment({initialTasks:[task],pickPDF:async()=>file,pdfIdentity:{async inspect(){return {status:'unknown'};}}});
  env.Zotero.getMainWindow=()=>({crypto:{subtle:{async digest(algorithm,bytes){hashing=true;await gate.promise;return webcrypto.subtle.digest(algorithm,bytes);}}}});
  env.addItem(item(1));env.files.set(file,env.pdf);await env.app.start();const importing=env.app.importLocalPDF(task.id);await until(()=>hashing);
  const rejected=assert.rejects(importing,/取消/),pausing=env.app.pauseTask(task.id);gate.resolve();await Promise.all([rejected,pausing]);
  assert.equal(env.app.getSnapshot().tasks[0].state,'paused');assert.equal(env.app.getSnapshot().tasks[0].pendingFilename,undefined);assert.equal(env.importCount,0);await env.app.stop();
});

test('an item DOI changed during review cannot be confirmed into that item',async()=>{
  const task=localFixture(),file='C:\\isolated\\scan.pdf';
  const env=environment({initialTasks:[task],pickPDF:async()=>file,pdfIdentity:{async inspect(){return {status:'unknown'};}}});
  const parent=env.addItem(item(1));env.files.set(file,env.pdf);await env.app.start();await env.app.importLocalPDF(task.id);
  const original=parent.getField;parent.getField=name=>name==='DOI'?'10.1234/changed':original(name);
  await assert.rejects(env.app.confirmDownloadedPDF(task.id),/DOI|改变/);assert.equal(env.importCount,0);await env.app.stop();
});

test('cancelling a picker while watching ends the watch and never imports a later download',async()=>{
  const task=localFixture(),env=environment({initialTasks:[task],pickPDF:async()=>null});env.addItem(item(1));await env.app.start();await env.app.openSystemBrowserTask(task.id);
  assert.equal((await env.app.importLocalPDF(task.id)).cancelled,true);assert.equal(env.app.getSnapshot().tasks[0].state,'paused');
  env.putFile(path.win32.join(downloadDirectory,'later.pdf'),env.pdf);await env.app.checkDownloads();env.advanceTime(2500);await env.app.checkDownloads();
  assert.equal(env.importCount,0);assert.equal(env.identityCalls.length,0);await env.app.stop();
});

test('a browser watch ignores baseline and mismatched files then imports a stable matching download',async()=>{
  const task=localFixture(),seen=[],old=path.win32.join(downloadDirectory,'old.pdf'),wrong=path.win32.join(downloadDirectory,'wrong.pdf'),correct=path.win32.join(downloadDirectory,'correct.pdf');
  const env=environment({initialTasks:[task],pdfIdentity:{async inspect(file,paper,{bytes}){seen.push(file);assert.equal(paper.doi,task.doi);assert(bytes.length>1024);return {status:file===correct?'match':'mismatch'};}}});
  env.addItem(item(1));env.putFile(old,env.pdf);await env.app.start();await env.app.openSystemBrowserTask(task.id);
  env.putFile(wrong,env.pdf);await env.app.checkDownloads();env.advanceTime(2100);await env.app.checkDownloads();assert.deepEqual(seen,[wrong]);assert.equal(env.importCount,0);assert.equal(env.app.getSnapshot().tasks[0].state,'manual_waiting');
  env.putFile(correct,env.pdf);await env.app.checkDownloads();assert.equal(env.importCount,0);env.advanceTime(2100);await env.app.checkDownloads();
  assert.equal(env.importCount,1);assert.equal(env.imports[0].parentItemID,1);assert.equal(env.app.getSnapshot().tasks[0].source,'browser_download');assert.equal(env.app.getSnapshot().tasks[0].state,'imported');assert.equal(env.submissions.length,0);assert(!seen.includes(old));
  await env.app.checkDownloads();assert.equal(env.importCount,1);await env.app.stop();
});

test('an unknown browser download remains unimported without opening a manual confirmation',async()=>{
  const task=localFixture(),env=environment({initialTasks:[task],pdfIdentity:{async inspect(){return {status:'unknown'};}}});env.addItem(item(1));await env.app.start();await env.app.openSystemBrowserTask(task.id);
  env.putFile(path.win32.join(downloadDirectory,'scan.pdf'),env.pdf);await env.app.checkDownloads();env.advanceTime(2100);await env.app.checkDownloads();
  assert.equal(env.importCount,0);assert.equal(env.app.getSnapshot().tasks[0].state,'manual_waiting');assert.equal(env.app.getSnapshot().tasks[0].pendingFilename,undefined);await env.app.stop();
});

test('automatic import persists the checked byte snapshot if the disk file changes during inspection',async()=>{
  const task=localFixture(),file=path.win32.join(downloadDirectory,'download.pdf');let env,inspections=0,stored;
  env=environment({initialTasks:[task],pdfIdentity:{async inspect(value,paper,{bytes}){inspections++;assert.equal(bytes[100],48);if(inspections===1){const replacement=env.pdf.slice();replacement[100]=49;env.putFile(file,replacement);}return {status:'match'};}}});
  const original=env.Zotero.Attachments.importFromFile;env.Zotero.Attachments.importFromFile=async options=>{stored=env.files.get(options.file).slice();return original(options);};
  env.addItem(item(1));await env.app.start();await env.app.openSystemBrowserTask(task.id);env.putFile(file,env.pdf);await env.app.checkDownloads();env.advanceTime(2100);await env.app.checkDownloads();
  assert.equal(inspections,2);assert.equal(env.importCount,1);assert.equal(stored[100],48);assert.equal(env.files.get(file)[100],49);await env.app.stop();
});

test('pausing a download watch during extraction blocks a late matching attachment',async()=>{
  const task=localFixture(),gate=deferred();let began=false;
  const env=environment({initialTasks:[task],pdfIdentity:{async inspect(){began=true;await gate.promise;return {status:'match'};}}});env.addItem(item(1));await env.app.start();await env.app.openSystemBrowserTask(task.id);
  env.putFile(path.win32.join(downloadDirectory,'late.pdf'),env.pdf);await env.app.checkDownloads();env.advanceTime(2100);const checking=env.app.checkDownloads();await until(()=>began);
  await env.app.pauseTask(task.id);gate.resolve();await checking;assert.equal(env.importCount,0);assert.equal(env.app.getSnapshot().tasks[0].state,'paused');await env.app.stop();
});

test('manual waiting can switch to explicit assistance using the latest default points',async()=>{
  const task=localFixture(),env=environment({initialTasks:[task],acquire:async()=>({state:'not_found',message:'Unavailable'})});env.addItem(item(1));await env.app.start();await env.app.openSystemBrowserTask(task.id);await env.app.saveSettings({points:47});
  assert.equal((await env.app.requestAssist(task.id)).accepted,1);await until(()=>env.app.getSnapshot().tasks[0].state==='waiting');
  assert.equal(env.submissions.length,1);assert.equal(env.submissions[0].points,47);assert.equal(env.app.getSnapshot().tasks[0].acquisitionMode,'');
  env.putFile(path.win32.join(downloadDirectory,'late.pdf'),env.pdf);await env.app.checkDownloads();env.advanceTime(2100);await env.app.checkDownloads();assert.equal(env.importCount,0);assert.equal(env.identityCalls.length,0);await env.app.stop();
});

test('manual review can switch to assistance and clears the pending confirmation',async()=>{
  const task=localFixture(),file='C:\\isolated\\scan.pdf';
  const env=environment({initialTasks:[task],pickPDF:async()=>file,pdfIdentity:{async inspect(){return {status:'unknown'};}},acquire:async()=>({state:'not_found',message:'Unavailable'})});env.addItem(item(1));env.files.set(file,env.pdf);await env.app.start();await env.app.importLocalPDF(task.id);await env.app.saveSettings({points:29});
  assert.equal((await env.app.requestAssist(task.id)).accepted,1);await until(()=>env.app.getSnapshot().tasks[0].state==='waiting');
  assert.equal(env.submissions.length,1);assert.equal(env.submissions[0].points,29);assert.equal(env.app.getSnapshot().tasks[0].pendingFilename,undefined);assert.throws(()=>env.app.confirmDownloadedPDF(task.id),/没有待确认/);assert.equal(env.importCount,0);await env.app.stop();
});

test('switching to assistance while a watcher is extracting cancels its late local match',async()=>{
  const task=localFixture(),gate=deferred();let began=false;
  const env=environment({initialTasks:[task],pdfIdentity:{async inspect(){began=true;await gate.promise;return {status:'match'};}},acquire:async()=>({state:'not_found',message:'Unavailable'})});
  env.addItem(item(1));await env.app.start();await env.app.openSystemBrowserTask(task.id);env.putFile(path.win32.join(downloadDirectory,'late.pdf'),env.pdf);
  await env.app.checkDownloads();env.advanceTime(2100);const checking=env.app.checkDownloads();await until(()=>began);
  assert.equal((await env.app.requestAssist(task.id)).accepted,1);gate.resolve();await checking;await until(()=>env.app.getSnapshot().tasks[0].state==='waiting');
  assert.equal(env.importCount,0);assert.equal(env.submissions.length,1);assert.equal(env.app.getSnapshot().tasks[0].source,'');await env.app.stop();
});

test('binding an existing assistance request clears a prior manual PDF confirmation',async()=>{
  const task=localFixture(),file='C:\\isolated\\scan.pdf';
  const env=environment({initialTasks:[task],pickPDF:async()=>file,pdfIdentity:{async inspect(){return {status:'unknown'};}}});env.addItem(item(1));env.files.set(file,env.pdf);await env.app.start();await env.app.importLocalPDF(task.id);
  env.adapter.getRequest=async()=>({requestID:'Existing',requestURL:'https://www.ablesci.com/assist/detail?id=Existing',doi:task.doi,state:'waiting',files:[]});
  await env.app.addExistingRequest('https://www.ablesci.com/assist/detail?id=Existing',task.id);
  assert.equal(env.app.getSnapshot().tasks[0].requestID,'Existing');assert.equal(env.app.getSnapshot().tasks[0].pendingFilename,undefined);assert.throws(()=>env.app.confirmDownloadedPDF(task.id),/没有待确认/);assert.equal(env.importCount,0);await env.app.stop();
});

test('download folders are discovered, selectable and persisted, and removal pauses active watches',async()=>{
  const task=localFixture(),second='D:\\Papers',env=environment({initialTasks:[task],pickDirectory:async()=>second});env.directories.add(second);env.addItem(item(1));await env.app.start();
  assert.deepEqual(Array.from(env.app.getSnapshot().settings.downloadDirectories),[downloadDirectory]);assert.deepEqual(JSON.parse(env.prefs.get('extensions.fulltext-assistant.downloadDirectories')),[downloadDirectory]);
  await env.app.chooseDownloadDirectory();assert.deepEqual(Array.from(env.app.getSnapshot().settings.downloadDirectories),[downloadDirectory,second]);await env.app.openSystemBrowserTask(task.id);
  await env.app.removeDownloadDirectory(second);assert.equal(env.app.getSnapshot().tasks[0].state,'paused');assert.deepEqual(JSON.parse(env.prefs.get('extensions.fulltext-assistant.downloadDirectories')),[downloadDirectory]);await env.app.stop();
});

test('additional detected directories merge without duplicates or losing a custom folder',async()=>{
  const second='D:\\Papers';let calls=0;
  const env=environment({discoverDirectories:async()=>++calls===1?[downloadDirectory]:[downloadDirectory,second]});env.directories.add(second);await env.app.start();
  const result=await env.app.detectDownloadDirectories();assert.equal(result.added,1);assert.deepEqual(Array.from(result.directories),[downloadDirectory,second]);await env.app.stop();
});

test('a browser download cannot be armed without any available download folders',async()=>{
  const task=localFixture(),env=environment({initialTasks:[task],discoverDirectories:async()=>[]});env.addItem(item(1));await env.app.start();
  await assert.rejects(env.app.openSystemBrowserTask(task.id),/下载文件夹/);assert.deepEqual(env.openedURLs,[]);assert.equal(env.importCount,0);await env.app.stop();
});

test('directory changes pause a current watch but detecting the same directories does not',async()=>{
  const task=localFixture(),second='D:\\Papers',env=environment({initialTasks:[task],pickDirectory:async()=>second});
  env.addItem(item(1));env.directories.add(second);await env.app.start();await env.app.openSystemBrowserTask(task.id);
  assert.equal((await env.app.detectDownloadDirectories()).paused,0);assert.equal(env.app.getSnapshot().tasks[0].state,'manual_waiting');
  assert.equal((await env.app.chooseDownloadDirectory()).paused,1);assert.equal(env.app.getSnapshot().tasks[0].state,'paused');
  assert.match(env.app.getSnapshot().tasks[0].lastError,/文件夹已更改/);
  env.putFile(path.win32.join(downloadDirectory,'late.pdf'),env.pdf);await env.app.checkDownloads();env.advanceTime(2100);await env.app.checkDownloads();
  assert.equal(env.importCount,0);await env.app.stop();
});

test('logging out of assistance leaves an unrelated browser folder watch active',async()=>{
  const task={...localFixture(),allowAssist:true},env=environment({initialTasks:[task]});
  env.addItem(item(1));await env.app.start();await env.app.openSystemBrowserTask(task.id);await env.app.logout();
  assert.equal(env.app.getSnapshot().tasks[0].state,'manual_waiting');
  env.putFile(path.win32.join(downloadDirectory,'paper.pdf'),env.pdf);await env.app.checkDownloads();env.advanceTime(2100);await env.app.checkDownloads();
  assert.equal(env.importCount,1);assert.equal(env.submissions.length,0);await env.app.stop();
});

test('manual waiting and review history restart paused without a restored file confirmation',async()=>{
  for(const state of ['manual_waiting','manual_review']){
    const task={...localFixture(),state,acquisitionMode:'manual'},env=environment({initialTasks:[task]});env.addItem(item(1));await env.app.start();
    assert.equal(env.app.getSnapshot().tasks[0].state,'paused');assert.equal(env.app.getSnapshot().tasks[0].pendingFilename,undefined);assert.throws(()=>env.app.confirmDownloadedPDF(task.id),/没有待确认/);
    env.putFile(path.win32.join(downloadDirectory,'late.pdf'),env.pdf);await env.app.checkDownloads();env.advanceTime(2100);await env.app.checkDownloads();assert.equal(env.importCount,0);assert.deepEqual(env.openedURLs,[]);assert.equal(env.submissions.length,0);await env.app.stop();
  }
});

test('context menu has one branded submenu, live points, and selection-aware actions',async()=>{
  const env=environment();await env.app.start();
  assert.equal(env.menus.size,1);
  const registration=env.menus.get('fulltext-assistant');assert.equal(registration.target,'main/library/item');
  assert.equal(registration.menus.length,1);const parent=registration.menus[0];
  assert.equal(parent.menuType,'submenu');assert.equal(parent.icon,'file:///fixture/assets/icon-16.png');
  assert.deepEqual(Array.from(parent.menus,entry=>entry.menuType),['menuitem','menuitem','separator','menuitem']);
  const context={items:[],label:'',enabled:null,menuElem:{setAttribute(name,value){if(name==='label')context.label=value;}},setEnabled(value){context.enabled=!!value;}};
  parent.onShowing(null,context);assert.equal(context.label,'全文助手');assert.equal(context.enabled,true);
  parent.menus[0].onShowing(null,context);assert.equal(context.label,'批量获取全文');assert.equal(context.enabled,false);
  parent.menus[3].onShowing(null,context);assert.equal(context.label,'任务与设置');assert.equal(context.enabled,true);
  context.items=[item(1)];parent.menus[0].onShowing(null,context);assert.equal(context.enabled,true);
  parent.menus[1].onShowing(null,context);assert.match(context.label,/10 积分/);
  await env.app.saveSettings({points:27});parent.menus[1].onShowing(null,context);assert.match(context.label,/27 积分/);
  context.items=[{isRegularItem:()=>false,isAttachment:()=>true,parentID:1}];parent.menus[0].onShowing(null,context);assert.equal(context.enabled,true);
  context.items=[{isRegularItem:()=>false,isAttachment:()=>true,parentID:null}];parent.menus[0].onShowing(null,context);assert.equal(context.enabled,false);
  await env.app.stop();assert.equal(env.menus.size,0);
});

test('current batch membership is a persisted view and never replaces older active or completed tasks',async()=>{
  const gates=new Map(),env=environment({acquire:async value=>{const gate=deferred();gates.set(value.id,gate);await gate.promise;return {attachmentID:800+value.id,source:'publisher'};}});
  const parents=[1,2,3].map(id=>env.addItem(item(id)));await env.app.start();
  await env.app.captureItems(parents.slice(0,2));await until(()=>gates.size===2);
  const first=env.app.getSnapshot().currentBatch;
  await env.app.captureItems([parents[1],parents[2]]);
  const snapshot=env.app.getSnapshot(),current=snapshot.currentBatch;
  assert.notEqual(current.id,first.id);assert.equal(snapshot.tasks.length,3);
  assert.deepEqual(Array.from(current.taskIDs,id=>snapshot.tasks.find(t=>t.id===id).itemID),[2,3]);
  current.taskIDs.length=0;current.summary.queuedTaskIDs.push('tampered');
  assert.equal(env.app.getSnapshot().currentBatch.taskIDs.length,2);
  gates.get(1).resolve();gates.get(2).resolve();await until(()=>gates.has(3));gates.get(3).resolve();
  await until(()=>env.app.getSnapshot().tasks.every(t=>t.state==='imported'));await env.app.stop();
  const persisted=MODEL.deserializeQueue(env.files.get(queuePath)),restored=environment({initialQueue:persisted});await restored.app.start();
  assert.equal(restored.app.getSnapshot().tasks.length,3);
  assert.equal(restored.app.getSnapshot().currentBatch.id,persisted.currentBatch.id);
  assert.deepEqual(Array.from(restored.app.getSnapshot().currentBatch.taskIDs),persisted.currentBatch.taskIDs);
  assert.equal(restored.app.getSnapshot().captureSummary.id,persisted.currentBatch.summary.id);
  await restored.app.captureItems([]);assert.equal(restored.app.getSnapshot().currentBatch.taskIDs.length,0);assert.equal(restored.app.getSnapshot().tasks.length,3);
  await restored.app.stop();
});

test('explicit recheck finds a recent already-downloaded PDF without reopening the browser or including older files',async()=>{
  const task=MODEL.createTask({libraryID:1,itemID:1,itemKey:'ITEM1',doi:'10.1234/paper1',state:'paused'});
  const env=environment({initialTasks:[task]});env.addItem(item(1));await env.app.start();
  env.putFile(path.win32.join(downloadDirectory,'older.pdf'),env.pdf,{lastModified:Date.parse(task.createdAt)-86400000});
  env.putFile(path.win32.join(downloadDirectory,'downloaded.pdf'),env.pdf,{lastModified:Date.parse(task.createdAt)+100});
  await env.app.recheckDownloadedPDFs(task.id);assert.equal(env.openedURLs.length,0);
  await env.app.checkDownloads();env.advanceTime(2500);await env.app.checkDownloads();
  assert.equal(env.app.getSnapshot().tasks[0].state,'imported');assert.equal(env.importCount,1);
  assert.equal(env.identityCalls.some(c=>c.file.endsWith('older.pdf')),false);
  assert.equal(env.submissions.length,0);await env.app.stop();
});

test('unknown browser files become bounded preview candidates and still require explicit confirmation',async()=>{
  const task=MODEL.createTask({libraryID:1,itemID:1,itemKey:'ITEM1',doi:'10.1234/paper1',state:'paused'});
  const env=environment({initialTasks:[task],pdfIdentity:{async inspect(){return{status:'unknown',related:true,candidateScore:0.85,message:'The title starts after an earlier article'};}}});env.addItem(item(1));await env.app.start();
  await env.app.openSystemBrowserTask(task.id);const file=path.win32.join(downloadDirectory,'needs-review.pdf');env.putFile(file,env.pdf);
  await env.app.checkDownloads();env.advanceTime(2500);await env.app.checkDownloads();
  let snapshot=env.app.getSnapshot();assert.equal(snapshot.tasks[0].state,'manual_waiting');assert.equal(env.importCount,0);
  assert.equal(snapshot.tasks[0].downloadCandidates.length,1);assert.equal(snapshot.tasks[0].downloadStatus.unknown,1);
  const id=snapshot.tasks[0].downloadCandidates[0].id;snapshot.tasks[0].downloadCandidates[0].id='tampered';
  assert.equal(env.app.getSnapshot().tasks[0].downloadCandidates[0].id,id);
  await env.app.reviewDownloadCandidate(task.id,id);assert.equal(env.app.getSnapshot().tasks[0].state,'manual_review');assert.equal(env.importCount,0);assert.deepEqual(env.openedFiles,[file]);
  await env.app.confirmDownloadedPDF(task.id);assert.equal(env.importCount,1);assert.equal(env.app.getSnapshot().tasks[0].downloadCandidates.length,0);await env.app.stop();
});

test('changed or mismatched browser candidates never inherit a preview confirmation',async()=>{
  const task=MODEL.createTask({libraryID:1,itemID:1,itemKey:'ITEM1',doi:'10.1234/paper1',state:'paused'});
  const env=environment({initialTasks:[task],pdfIdentity:{async inspect(file){return{status:file.endsWith('wrong.pdf')?'mismatch':'unknown',related:!file.endsWith('wrong.pdf'),candidateScore:0.8,message:'Fixture diagnostic'};}}});env.addItem(item(1));await env.app.start();
  await env.app.openSystemBrowserTask(task.id);const file=path.win32.join(downloadDirectory,'uncertain.pdf');env.putFile(file,env.pdf);env.putFile(path.win32.join(downloadDirectory,'wrong.pdf'),env.pdf);
  await env.app.checkDownloads();env.advanceTime(2500);await env.app.checkDownloads();
  const taskView=env.app.getSnapshot().tasks[0];assert.equal(taskView.downloadCandidates.length,1);assert.equal(taskView.downloadStatus.mismatched,1);
  const changed=env.pdf.slice();changed[30]=65;env.putFile(file,changed);
  await assert.rejects(env.app.reviewDownloadCandidate(task.id,taskView.downloadCandidates[0].id),/已改变/);
  assert.equal(env.importCount,0);assert.equal(env.openedFiles.length,0);await env.app.stop();
});

test('a candidate that becomes identifiable during preview still requires explicit confirmation',async()=>{
  const task=localFixture();let matches=false;
  const env=environment({initialTasks:[task],pdfIdentity:{async inspect(){return{status:matches?'match':'unknown',related:true,candidateScore:0.8,message:'Candidate identity'};}}});
  env.addItem(item(1));await env.app.start();await env.app.openSystemBrowserTask(task.id);
  const file=path.win32.join(downloadDirectory,'candidate.pdf');env.putFile(file,env.pdf);
  await env.app.checkDownloads();env.advanceTime(2500);await env.app.checkDownloads();matches=true;
  const candidate=env.app.getSnapshot().tasks[0].downloadCandidates[0];
  const result=await env.app.reviewDownloadCandidate(task.id,candidate.id);
  assert.equal(result.needsReview,true);assert.equal(env.importCount,0);assert.deepEqual(env.openedFiles,[file]);
  assert.equal(env.app.getSnapshot().tasks[0].state,'manual_review');
  await env.app.confirmDownloadedPDF(task.id);assert.equal(env.importCount,1);await env.app.stop();
});

test('pausing while a candidate file is read prevents a late preview and task revival',async()=>{
  const task=localFixture(),gate=deferred();let reading=false;
  const env=environment({initialTasks:[task],pdfIdentity:{async inspect(){return{status:'unknown',related:true,candidateScore:0.8,message:'Candidate identity'};}}});
  env.addItem(item(1));await env.app.start();await env.app.openSystemBrowserTask(task.id);
  const file=path.win32.join(downloadDirectory,'candidate.pdf');env.putFile(file,env.pdf);
  await env.app.checkDownloads();env.advanceTime(2500);await env.app.checkDownloads();
  const candidate=env.app.getSnapshot().tasks[0].downloadCandidates[0],read=env.IOUtils.read;
  env.IOUtils.read=async(...args)=>{if(args[0]===file&&!reading){reading=true;await gate.promise;}return read(...args);};
  const pending=env.app.reviewDownloadCandidate(task.id,candidate.id);await until(()=>reading);
  const rejected=assert.rejects(pending,/已取消/);await env.app.pauseTask(task.id);gate.resolve();await rejected;
  assert.equal(env.app.getSnapshot().tasks[0].state,'paused');assert.equal(env.importCount,0);assert.equal(env.openedFiles.length,0);
  await env.app.stop();
});

test('only the three strongest related PDF candidates are exposed, with evidence and separate diagnostics',async()=>{
  const task=localFixture();const scores={weak:0.7,middle:0.85,strong:0.94,best:0.98,scan:0,unrelated:0};
  const env=environment({initialTasks:[task],pdfIdentity:{async inspect(file){
    const name=path.win32.basename(file,'.pdf'),score=scores[name];
    return {status:'unknown',related:score>0,candidateScore:score,titleSimilarity:name==='scan'?null:score,
      detectedTitle:name==='scan'?'':name+' scientific paper',detectedDOIs:[],
      evidence:{extractionSucceeded:true,firstPageCharacterCount:name==='scan'?0:450,titleReliable:name!=='scan',candidateBasis:score?['similar_title']:[]}};
  }}});
  env.addItem(item(1));await env.app.start();await env.app.openSystemBrowserTask(task.id);
  let n=0;for(const name of Object.keys(scores)){const bytes=env.pdf.slice();bytes[40]=++n;env.putFile(path.win32.join(downloadDirectory,name+'.pdf'),bytes);}
  await env.app.checkDownloads();env.advanceTime(2500);await env.app.checkDownloads();
  const row=env.app.getSnapshot().tasks[0];assert.equal(env.importCount,0);
  assert.deepEqual(Array.from(row.downloadCandidates,c=>c.filename),['best.pdf','strong.pdf','middle.pdf']);
  assert.equal(row.downloadStatus.related,4);assert.equal(row.downloadStatus.unreadable,1);assert.equal(row.downloadStatus.unrelated,1);
  assert.deepEqual(Array.from(row.downloadDiagnostics,d=>d.filename).sort(),['scan.pdf','unrelated.pdf']);
  assert.match(row.lastError,/相关候选/);assert.doesNotMatch(JSON.stringify(row.downloadDiagnostics),/isolated|Downloads/);
  row.downloadCandidates[0].evidence.candidateBasis.push('tampered');row.downloadDiagnostics[0].detectedDOIs.push('tampered');
  assert.doesNotMatch(JSON.stringify(env.app.getSnapshot().tasks[0]),/tampered/);
  await env.app.stop();
});

test('a changed candidate that is now a different paper is removed from review suggestions',async()=>{
  const task=localFixture();let different=false;
  const env=environment({initialTasks:[task],pdfIdentity:{async inspect(){return different?{status:'mismatch',related:false,candidateScore:0}:{status:'unknown',related:true,candidateScore:0.9};}}});
  env.addItem(item(1));await env.app.start();await env.app.openSystemBrowserTask(task.id);
  const file=path.win32.join(downloadDirectory,'candidate.pdf');env.putFile(file,env.pdf);
  await env.app.checkDownloads();env.advanceTime(2500);await env.app.checkDownloads();assert.equal(env.app.getSnapshot().tasks[0].downloadCandidates.length,1);
  different=true;const changed=env.pdf.slice();changed[40]=65;env.putFile(file,changed);
  await env.app.checkDownloads();env.advanceTime(2500);await env.app.checkDownloads();
  const row=env.app.getSnapshot().tasks[0];assert.equal(row.downloadCandidates.length,0);assert.equal(row.downloadStatus.related,0);assert.equal(row.downloadStatus.mismatched,1);assert.equal(row.downloadStatus.scanned,1);
  assert.equal(env.importCount,0);await env.app.stop();
});

test('institutional experience requires explicit user confirmation, survives restart, and does not prevent explicit fallback',async()=>{
  const task=MODEL.createTask({libraryID:1,itemID:1,itemKey:'ITEM1',doi:'10.1234/paper1',officialURL:'https://publisher.test/paper1',source:'browser_download',attachmentID:900,state:'imported'});
  const env=environment({initialTasks:[task]});env.addItem(item(1));await env.app.start();
  assert.equal(env.app.getSnapshot().tasks[0].accessHint.kind,'browser_success');assert.equal(env.app.getSnapshot().tasks[0].accessHint.institutionalConfirmed,false);
  await env.app.confirmInstitutionalAccess(task.id);assert.equal(env.app.getSnapshot().tasks[0].accessHint.institutionalConfirmed,true);
  const history=JSON.parse(env.files.get(path.win32.join('C:\\isolated','fulltext-assistant','access-history.json')));await env.app.stop();
  const restarted=environment({initialTasks:[task],initialAccessHistory:history,acquire:async()=>({state:'not_found',message:'No automatic PDF'})});const parent=restarted.addItem(item(1));await restarted.app.start();
  await restarted.app.captureItems([parent]);await until(()=>restarted.app.getSnapshot().tasks[0].state==='needs_login');assert.equal(restarted.submissions.length,0);
  await restarted.app.requestAssist(task.id);await until(()=>restarted.submissions.length===1);
  await restarted.app.forgetInstitutionalAccess(task.id);assert.equal(restarted.app.getSnapshot().tasks[0].accessHint.institutionalConfirmed,false);
  await restarted.app.stop();
});

test('an article with only a resolved publisher URL can retain explicit institutional experience',async()=>{
  const task=MODEL.createTask({libraryID:1,itemID:1,itemKey:'ITEM1',doi:'10.1234/paper1',publisherURL:'https://publisher.test/paper1',source:'browser_download',attachmentID:900,state:'imported'});
  const env=environment({initialTasks:[task]});env.addItem(item(1));await env.app.start();
  await env.app.confirmInstitutionalAccess(task.id);
  assert.equal(env.app.getSnapshot().tasks[0].accessHint.institutionalConfirmed,true);
  assert.equal(JSON.parse(env.files.get(path.win32.join('C:\\isolated','fulltext-assistant','access-history.json'))).entries.length,1);
  await env.app.stop();
});

test('institutional confirmation cannot silently succeed without an article identity or publisher host',async()=>{
  for(const fields of [{doi:'',officialURL:'https://publisher.test/article'},{doi:'10.1234/paper1',officialURL:''},{doi:'10.1234/paper1',officialURL:'https://doi.org/10.1234/paper1'}]){
    const task=MODEL.createTask({libraryID:1,itemID:1,itemKey:'ITEM1',source:'local_file',attachmentID:900,state:'imported',...fields});
    const env=environment({initialTasks:[task]});env.addItem(item(1));await env.app.start();
    await assert.rejects(env.app.confirmInstitutionalAccess(task.id),/缺少 DOI 或有效出版社/);
    assert.equal(env.app.getSnapshot().tasks[0].accessHint.institutionalConfirmed,false);await env.app.stop();
  }
});

test('language changes persist without changing other settings and context-menu labels update on display',async()=>{
  const env=environment();await env.app.start();assert.equal(env.app.getSnapshot().settings.language,'zh-CN');
  await env.app.saveSettings({points:31});await env.app.saveSettings({language:'en'});
  assert.equal(env.app.getSnapshot().settings.points,31);assert.equal(env.app.translate('检查已下载文件'),'Check downloaded files');
  const menu=env.menus.get('fulltext-assistant').menus[0],labels=[];
  menu.onShowing(null,{menuElem:{setAttribute(name,value){if(name==='label')labels.push(value);}},setEnabled(){}});
  menu.menus[0].onShowing(null,{items:[item(1)],menuElem:{setAttribute(name,value){if(name==='label')labels.push(value);}},setEnabled(){}});
  assert.equal(labels[0],'Full Text Assistant');assert.equal(/[\u3400-\u9fff]/u.test(labels[1]),false);assert.equal(env.menus.size,1);
  await assert.rejects(env.app.saveSettings({language:'unsupported'}),/不支持/);assert.equal(env.app.getSnapshot().settings.language,'en');
  const prefs=Object.fromEntries(env.prefs);await env.app.stop();const restored=environment({initialPrefs:prefs});await restored.app.start();
  assert.equal(restored.app.getSnapshot().settings.language,'en');assert.equal(restored.app.getSnapshot().settings.points,31);
  await restored.app.saveSettings({language:'zh-TW'});assert.equal(restored.app.translate('任务'),'任務');await restored.app.stop();
});

test('copy bridge writes the exact supplied title or DOI and reports invalid or failed copies',async()=>{
  const env=environment(),copied=[];env.Zotero.Utilities.Internal.copyTextToClipboard=value=>copied.push(value);await env.app.start();
  env.app.copyText('A title with < and > symbols');env.app.copyText('10.1111/mec.12915');
  assert.deepEqual(copied,['A title with < and > symbols','10.1111/mec.12915']);assert.throws(()=>env.app.copyText('  '),/可复制/);
  env.Zotero.Utilities.Internal.copyTextToClipboard=()=>{throw new Error('clipboard unavailable');};assert.throws(()=>env.app.copyText('Title'),/clipboard unavailable/);await env.app.stop();
});

test('verified identical assistance bytes recover local and browser history without a duplicate import or completion-date change',async()=>{
  for(const source of ['local_file','browser_download','existing']){
    const task=MODEL.updateTask(remoteFixture('imported'),{source,attachmentID:900,officialURL:'https://publisher.test/paper1'});
    const env=completionEnvironment({initialTasks:[task]});env.installAttachment();await env.app.start();
    const result=await env.app.verifyAssistCompletion(task.id),current=env.app.getSnapshot().tasks[0];
    assert.equal(result.completed,true,source);assert.equal(current.source,'ablesci');assert.equal(current.attachmentID,900);
    assert.equal(current.completedAt,task.completedAt);assert.equal(current.assistReceipt.sha256,sha256(env.pdf));
    assert.equal(current.assistReceipt.messages,'done');assert.equal(env.importCount,0);assert.equal(env.posts.length,1);
    assert.equal(current.accessHint.kind==='browser_success',false,'an assistance-linked import is not publisher-access evidence');
    await env.app.verifyAssistCompletion(task.id);assert.equal(env.posts.length,1);assert.equal(env.downloadCalls.length,1);
    await env.app.stop();
  }
});

test('a request link alone never changes a local source, replaces its file or adopts different remote bytes',async()=>{
  for(const source of ['local_file','browser_download','existing']){
    const task=MODEL.updateTask(remoteFixture('imported'),{source,attachmentID:900}),env=completionEnvironment({initialTasks:[task]});
    const local=env.pdf.slice();local[100]=49;const attachment=env.installAttachment({bytes:local});await env.app.start();
    const result=await env.app.verifyAssistCompletion(task.id),current=env.app.getSnapshot().tasks[0];
    assert.equal(result.completed,false);assert.equal(current.source,source);assert.equal(current.state,'imported');
    assert.equal(current.completedAt,task.completedAt);assert.equal(current.attachmentID,900);assert.equal(current.assistReceipt,null);
    assert.equal(sha256(env.files.get(await attachment.getFilePathAsync())),sha256(local));
    assert.equal(env.importCount,0);assert.equal(env.posts.length,0);assert.equal(env.messageReads.length,0);await env.app.stop();
  }
});

test('manually selecting a matching PDF for an assistance task waits for explicit confirmation then recovers its verified source',async()=>{
  const task=remoteFixture('waiting'),file='C:\\isolated\\manually-downloaded.pdf';
  const env=completionEnvironment({initialTasks:[task],pickPDF:async()=>file});env.files.set(file,env.pdf);await env.app.start();
  const result=await env.app.importLocalPDF(task.id),pending=env.app.getSnapshot().tasks[0];
  assert.equal(result.needsReview,true);assert.equal(pending.state,'manual_review');assert.equal(pending.requestID,'Request1');
  assert.equal(env.importCount,0);assert.equal(env.downloadCalls.length,0);assert.equal(env.posts.length,0);
  await env.app.previewDownloadedPDF(task.id);assert.deepEqual(env.openedFiles,[file]);
  await env.app.confirmDownloadedPDF(task.id);await until(()=>env.app.getSnapshot().tasks[0].assistReceipt?.messages==='done');
  const current=env.app.getSnapshot().tasks[0];assert.equal(current.source,'ablesci');assert.equal(current.requestID,'Request1');
  assert.equal(env.importCount,1);assert.equal(env.posts.length,1);assert.equal(env.messageReads.length,1);
  assert.equal(current.accessHint.kind==='browser_success',false);await env.app.stop();
});

test('confirming a local assistance-task PDF preserves the local source when website bytes differ',async()=>{
  const task=remoteFixture('waiting'),file='C:\\isolated\\independent-copy.pdf';
  const env=completionEnvironment({initialTasks:[task],pickPDF:async()=>file}),local=env.pdf.slice();local[100]=49;env.files.set(file,local);await env.app.start();
  assert.equal((await env.app.importLocalPDF(task.id)).needsReview,true);await env.app.confirmDownloadedPDF(task.id);
  await until(()=>env.downloadCalls.length===1);await settle();
  const current=env.app.getSnapshot().tasks[0];assert.equal(current.state,'imported');assert.equal(current.source,'local_file');
  assert.equal(current.assistReceipt,null);assert.equal(current.requestID,'Request1');assert.equal(env.posts.length,0);
  assert.equal(env.importCount,1);assert.equal(sha256(env.files.get(await env.items.get(900).getFilePathAsync())),sha256(local));
  await env.app.stop();
});

test('a confirmed assistance-task selection cannot bypass a contradictory PDF identity',async()=>{
  const task=remoteFixture('waiting'),file='C:\\isolated\\wrong-assistance.pdf';
  const env=completionEnvironment({initialTasks:[task],pickPDF:async()=>file,pdfIdentity:{async inspect(){return{status:'mismatch',message:'Different DOI'};}}});env.files.set(file,env.pdf);await env.app.start();
  await assert.rejects(env.app.importLocalPDF(task.id),/不匹配/);
  assert.equal(env.importCount,0);assert.equal(env.downloadCalls.length,0);assert.equal(env.posts.length,0);assert.equal(env.app.getSnapshot().tasks[0].assistReceipt,null);await env.app.stop();
});

test('an existing assistance task can recheck recent downloads without opening a page and recover a matching website file',async()=>{
  const task=remoteFixture('waiting'),file=path.win32.join(downloadDirectory,'downloaded-assistance.pdf');
  const env=completionEnvironment({initialTasks:[task]});env.putFile(file,env.pdf,{lastModified:Date.parse(task.createdAt)+100});await env.app.start();
  await env.app.recheckDownloadedPDFs(task.id);let current=env.app.getSnapshot().tasks[0];
  assert.equal(current.state,'manual_waiting');assert.equal(current.requestID,'Request1');assert.equal(current.downloadStatus.watching,true);assert.equal(env.openedURLs.length,0);
  await env.app.checkDownloads();env.advanceTime(2500);await env.app.checkDownloads();await until(()=>env.app.getSnapshot().tasks[0].assistReceipt?.messages==='done');
  current=env.app.getSnapshot().tasks[0];assert.equal(current.source,'ablesci');assert.equal(current.requestID,'Request1');assert.equal(env.importCount,1);assert.equal(env.posts.length,1);
  assert.equal(env.submissions.length,0);assert.equal(current.accessHint.kind==='browser_success',false);await env.app.stop();
});

test('checking a request after rechecking local downloads stops that watcher before remote processing',async()=>{
  const task=remoteFixture('waiting'),env=completionEnvironment({initialTasks:[task]});
  env.adapter.getRequest=async id=>({requestID:id,doi:task.doi,state:'waiting',files:[]});await env.app.start();await env.app.recheckDownloadedPDFs(task.id);
  assert.equal(env.app.getSnapshot().tasks[0].downloadStatus.watching,true);await env.app.checkTask(task.id);
  const current=env.app.getSnapshot().tasks[0];assert.equal(current.state,'waiting');assert.equal(current.downloadStatus.watching,false);
  assert.equal(current.requestID,'Request1');assert.equal(env.importCount,0);assert.equal(env.posts.length,0);assert.equal(env.submissions.length,0);await env.app.stop();
});

test('site-minimum acceptance defaults off and persists independently of language and other settings',async()=>{
  const env=environment();await env.app.start();assert.equal(env.app.getSnapshot().settings.acceptSiteMinimum,false);
  await env.app.saveSettings({points:13,acceptSiteMinimum:true});await env.app.saveSettings({language:'en'});
  assert.equal(env.app.getSnapshot().settings.acceptSiteMinimum,true);assert.equal(env.app.getSnapshot().settings.points,13);
  const prefs=Object.fromEntries(env.prefs);await env.app.stop();const restored=environment({initialPrefs:prefs});await restored.app.start();
  assert.equal(restored.app.getSnapshot().settings.acceptSiteMinimum,true);assert.equal(restored.app.getSnapshot().settings.points,13);
  await restored.app.saveSettings({acceptSiteMinimum:false});assert.equal(restored.app.getSnapshot().settings.acceptSiteMinimum,false);await restored.app.stop();
});

test('submission passes the minimum policy and preserves the verified actual reward across refresh, settings changes and restart',async()=>{
  const env=environment({acquire:async()=>({state:'not_found',message:'Unavailable'})}),parent=env.addItem(item(1));
  env.adapter.submitRequest=async value=>{env.submissions.push(value);return{requestID:'Request1',requestURL:'https://www.ablesci.com/assist/detail?id=Request1',requestedPoints:37,pointsVerified:true};};
  await env.app.start();await env.app.saveSettings({points:10,acceptSiteMinimum:true});await env.app.captureItems([parent],{allowAssist:true});
  await until(()=>env.app.getSnapshot().tasks[0]?.state==='waiting');let current=env.app.getSnapshot().tasks[0];
  assert.equal(env.submissions[0].acceptSiteMinimum,true);assert.equal(env.submissions[0].points,10);
  assert.equal(current.requestedPoints,37);assert.equal(current.pointsVerified,true);
  await env.app.saveSettings({points:99,acceptSiteMinimum:false});await env.app.checkTask(current.id);current=env.app.getSnapshot().tasks[0];
  assert.equal(current.requestedPoints,37);assert.equal(current.pointsVerified,true);assert.equal(env.submissions.length,1);
  await env.app.stop();const restored=environment({initialQueue:MODEL.deserializeQueue(env.files.get(queuePath))});await restored.app.start();
  assert.equal(restored.app.getSnapshot().tasks[0].requestedPoints,37);assert.equal(restored.app.getSnapshot().tasks[0].pointsVerified,true);await restored.app.stop();
});

test('unverified old rewards stay unknown until the website provides a verified amount',async()=>{
  const task=remoteFixture('waiting'),env=completionEnvironment({initialTasks:[task]});
  let proven=false;env.adapter.getRequest=async id=>({requestID:id,doi:task.doi,state:'waiting',files:[],...(proven?{requestedPoints:42,pointsVerified:true}:{})});
  await env.app.start();await env.app.saveSettings({points:99});await env.app.checkTask(task.id);
  assert.equal(env.app.getSnapshot().tasks[0].pointsVerified,false);assert.equal(env.app.getSnapshot().tasks[0].requestedPoints,10);
  proven=true;await env.app.checkTask(task.id);assert.equal(env.app.getSnapshot().tasks[0].pointsVerified,true);assert.equal(env.app.getSnapshot().tasks[0].requestedPoints,42);await env.app.stop();
});

test('an old polling snapshot cannot replace a newer explicit folder check on a queued remote task',async()=>{
  const first=remoteFixture('waiting'),second=MODEL.createTask({libraryID:1,itemID:2,itemKey:'ITEM2',doi:'10.1234/paper2',title:'Fixture paper 2',state:'waiting',requestURL:'https://www.ablesci.com/assist/detail?id=Request2'});
  const env=environment({initialTasks:[first,second]}),gate=deferred(),checked=[];env.addItem(item(1));env.addItem(item(2));
  env.adapter.getRequest=async id=>{checked.push(id);if(id==='Request1')await gate.promise;return{requestID:id,doi:id==='Request1'?first.doi:second.doi,state:'waiting',files:[]};};
  await env.app.start();const polling=env.timers.find(timer=>timer.ms===15000).callback();await until(()=>checked.includes('Request1'));
  await env.app.recheckDownloadedPDFs(second.id);gate.resolve();await polling;
  const current=env.app.getSnapshot().tasks.find(task=>task.id===second.id);
  assert.deepEqual(checked,['Request1']);assert.equal(current.state,'manual_waiting');assert.equal(current.downloadStatus.watching,true);
  assert.equal(env.submissions.length,0);assert.equal(env.importCount,0);await env.app.stop();
});

test('manual confirmation of an unidentifiable local PDF can settle only the identical website file with a manual receipt',async()=>{
  const task=remoteFixture('waiting'),file='C:\\isolated\\scanned-assistance.pdf';
  const env=completionEnvironment({initialTasks:[task],pickPDF:async()=>file,pdfIdentity:{async inspect(){return{status:'unknown',message:'Scanned PDF'};}}});env.files.set(file,env.pdf);await env.app.start();
  assert.equal((await env.app.importLocalPDF(task.id)).needsReview,true);assert.equal(env.importCount,0);assert.equal(env.posts.length,0);
  await env.app.confirmDownloadedPDF(task.id);await until(()=>env.app.getSnapshot().tasks[0].assistReceipt?.messages==='done');
  const current=env.app.getSnapshot().tasks[0];assert.equal(current.source,'ablesci');assert.equal(current.assistReceipt.verifiedBy,'manual');
  assert.equal(current.assistReceipt.sha256,sha256(env.pdf));assert.equal(env.importCount,1);assert.equal(env.posts.length,1);await env.app.stop();
});

test('old local history with unknown PDF identity cannot obtain a manual receipt from identical bytes alone',async()=>{
  const task=MODEL.updateTask(remoteFixture('imported'),{source:'local_file',attachmentID:900});
  const env=completionEnvironment({initialTasks:[task],pdfIdentity:{async inspect(){return{status:'unknown'};}}});env.installAttachment();await env.app.start();
  const result=await env.app.verifyAssistCompletion(task.id),current=env.app.getSnapshot().tasks[0];
  assert.equal(result.completed,false);assert.equal(current.source,'local_file');assert.equal(current.assistReceipt,null);
  assert.equal(env.posts.length,0);assert.equal(env.messageReads.length,0);assert.equal(env.importCount,0);await env.app.stop();
});

test('a local manual confirmation never overrides a contradictory remote PDF identity',async()=>{
  const task=remoteFixture('waiting'),file='C:\\isolated\\manual-then-conflicting.pdf';
  const env=completionEnvironment({initialTasks:[task],pickPDF:async()=>file,pdfIdentity:{async inspect(file){return file?{status:'unknown'}:{status:'mismatch',message:'Remote DOI contradicts target'};}}});env.files.set(file,env.pdf);await env.app.start();
  await env.app.importLocalPDF(task.id);await env.app.confirmDownloadedPDF(task.id);
  const current=env.app.getSnapshot().tasks[0];assert.equal(current.state,'imported');assert.equal(current.source,'local_file');
  assert.equal(current.assistReceipt,null);assert.equal(env.posts.length,0);assert.equal(env.messageReads.length,0);assert.equal(env.importCount,1);await env.app.stop();
});

test('changing the saved file while manually confirmed remote verification is downloading prevents source recovery and adoption',async()=>{
  const task=remoteFixture('waiting'),file='C:\\isolated\\manual-snapshot.pdf',gate=deferred();let downloading=false;
  const env=completionEnvironment({initialTasks:[task],pickPDF:async()=>file,pdfIdentity:{async inspect(){return{status:'unknown'};}}});env.files.set(file,env.pdf);
  const request=env.Zotero.HTTP.request;env.Zotero.HTTP.request=async(...args)=>{downloading=true;await gate.promise;return request(...args);};await env.app.start();
  await env.app.importLocalPDF(task.id);const confirming=env.app.confirmDownloadedPDF(task.id);await until(()=>downloading);
  const saved=await env.items.get(900).getFilePathAsync(),changed=env.pdf.slice();changed[100]=49;env.files.set(saved,changed);gate.resolve();await confirming;
  const current=env.app.getSnapshot().tasks[0];assert.equal(current.source,'local_file');assert.equal(current.assistReceipt,null);
  assert.equal(env.posts.length,0);assert.equal(env.messageReads.length,0);assert.equal(sha256(env.files.get(saved)),sha256(changed));await env.app.stop();
});

test('logout during a remote source verification prevents late attribution, account restoration and website writes',async()=>{
  const task=MODEL.updateTask(remoteFixture('imported'),{source:'local_file',attachmentID:900}),env=completionEnvironment({initialTasks:[task]}),gate=deferred();let downloading=false;
  env.installAttachment();const request=env.Zotero.HTTP.request;env.Zotero.HTTP.request=async(...args)=>{downloading=true;await gate.promise;return request(...args);};await env.app.start();
  const verifying=env.app.verifyAssistCompletion(task.id);await until(()=>downloading);await env.app.logout();const accountCalls=env.accountCalls;
  gate.resolve();const result=await verifying,current=env.app.getSnapshot().tasks[0];
  assert.equal(result.cancelled,true);assert.equal(current.source,'local_file');assert.equal(current.assistReceipt,null);
  assert.equal(env.app.getSnapshot().session.status,'signed_out');assert.equal(env.accountCalls,accountCalls);assert.equal(env.posts.length,0);assert.equal(env.messageReads.length,0);await env.app.stop();
});

test('changing the global minimum-price setting cannot change an already-authorized queued task budget policy',async()=>{
  const gate=deferred(),env=environment({acquire:async()=>{await gate.promise;return{state:'not_found',message:'Unavailable'};}}),parent=env.addItem(item(1));
  await env.app.start();await env.app.saveSettings({points:10,acceptSiteMinimum:true});await env.app.captureItems([parent],{allowAssist:true});await until(()=>env.publisherCalls.length===1);
  await env.app.saveSettings({points:99,acceptSiteMinimum:false});gate.resolve();await until(()=>env.submissions.length===1);
  assert.equal(env.submissions[0].acceptSiteMinimum,true);assert.equal(env.submissions[0].points,10);await env.app.stop();
});

test('a verified website amount returned by adoption replaces a stale reward without changing the completed attachment',async()=>{
  const task=importedReceiptFixture(),env=completionEnvironment({initialTasks:[task]});env.installAttachment();
  const accept=env.adapter.acceptFile;env.adapter.acceptFile=async options=>({...await accept(options),requestedPoints:46,pointsVerified:true});await env.app.start();
  const result=await env.app.retryAssistCompletion(task.id),current=env.app.getSnapshot().tasks[0];
  assert.equal(result.completed,true);assert.equal(current.requestedPoints,46);assert.equal(current.pointsVerified,true);
  assert.equal(current.attachmentID,900);assert.equal(current.completedAt,task.completedAt);assert.equal(env.importCount,0);assert.equal(env.posts.length,1);await env.app.stop();
});

function submissionReviewFixture(state='submission_unknown') {
  return MODEL.createTask({libraryID:1,itemID:1,itemKey:'ITEM1',doi:'10.1234/paper1',title:'Fixture paper 1',state,allowAssist:true,requestedPoints:10,
    submissionReview:{requestID:'Published1',requestURL:'https://www.ablesci.com/assist/detail?id=Published1',expectedDOI:'10.1234/paper1',receivedDOI:'10.1234/other',reason:'DOI_MISMATCH'}});
}

test('an uncertain response after publication retains the exact unbound request for read-only review and restart',async()=>{
  const review=submissionReviewFixture().submissionReview,env=environment({acquire:async()=>({state:'not_found',message:'Unavailable'})});env.addItem(item(1));
  env.adapter.submitRequest=async value=>{env.submissions.push(value);throw Object.assign(new Error('Published but detail parsing failed'),{code:'SUBMISSION_UNCERTAIN',reconcileRequired:true,submissionReview:{...review,receivedDOI:'',reason:'DETAIL_UNAVAILABLE'}});};
  await env.app.start();await env.app.captureItems([env.items.get(1)],{allowAssist:true});await until(()=>env.app.getSnapshot().tasks[0]?.state==='submission_unknown');
  const current=env.app.getSnapshot().tasks[0];assert.equal(current.requestID,'');assert.equal(current.requestURL,'');assert.equal(current.submissionReview.requestID,'Published1');
  current.submissionReview.requestID='Tampered';assert.equal(env.app.getSnapshot().tasks[0].submissionReview.requestID,'Published1');
  await env.app.stop();const restored=environment({initialQueue:MODEL.deserializeQueue(env.files.get(queuePath))});await restored.app.start();
  assert.equal(restored.app.getSnapshot().tasks[0].submissionReview.requestID,'Published1');assert.equal(restored.submissions.length,0);assert.equal(env.submissions.length,1);await restored.app.stop();
});

test('review checks only the retained published request and binds after a corrected live DOI agrees without reposting',async()=>{
  const task=submissionReviewFixture(),env=environment({initialTasks:[task]}),parent=env.addItem(item(1)),calls=[];let doi=task.doi;
  const get=parent.getField;parent.getField=name=>name==='DOI'?doi:get(name);
  env.adapter.findExistingRequest=async()=>{throw new Error('Do not replace the exact retained candidate with a search');};
  env.adapter.getRequest=async id=>{calls.push(id);return{requestID:'Published1',requestURL:task.submissionReview.requestURL,doi:'10.1234/other',ownerID:'FixtureAccount',state:'waiting',files:[],requestedPoints:30,pointsVerified:true};};
  await env.app.start();await env.app.checkTask(task.id);let current=env.app.getSnapshot().tasks[0];
  assert.equal(current.state,'submission_unknown');assert.equal(current.requestID,'');assert.equal(current.submissionReview.receivedDOI,'10.1234/other');
  doi='10.1234/other';await env.app.checkTask(task.id);current=env.app.getSnapshot().tasks[0];
  assert.equal(current.state,'waiting');assert.equal(current.doi,doi);assert.equal(current.requestID,'Published1');assert.equal(current.submissionReview,null);
  assert.equal(current.requestedPoints,30);assert.equal(current.pointsVerified,true);assert(calls.every(id=>id==='Published1'));assert.equal(env.submissions.length,0);assert.equal(env.publisherCalls.length,0);await env.app.stop();
});

test('published review refuses another owner, changed item identity and changed request ID without binding or reposting',async()=>{
  for(const mode of ['owner','item','request']){
    const task=submissionReviewFixture(),env=environment({initialTasks:[task]}),parent=env.addItem(item(1));
    env.adapter.getRequest=async()=>{if(mode==='item')parent.key='REPLACED';return{requestID:mode==='request'?'Other':'Published1',requestURL:task.submissionReview.requestURL,doi:task.doi,ownerID:mode==='owner'?'SomeoneElse':'FixtureAccount',state:'waiting',files:[]};};
    await env.app.start();const result=await env.app.checkTask(task.id),current=env.app.getSnapshot().tasks[0];
    assert.equal(result.completed,false,mode);assert.equal(current.state,'submission_unknown');assert.equal(current.requestID,'');assert.equal(current.submissionReview.requestID,'Published1');assert.equal(env.submissions.length,0);await env.app.stop();
  }
});

test('a paused published review retries the retained request and its separate open action never binds it',async()=>{
  const task=submissionReviewFixture('paused'),env=environment({initialTasks:[task]}),dialogs=[];env.addItem(item(1));
  env.Zotero.getMainWindow=()=>({openDialog(...args){dialogs.push(args);return{closed:false,close(){this.closed=true;},focus(){}};}});
  env.adapter.getRequest=async id=>{env.remoteRequests.push(id);return{requestID:id,requestURL:task.submissionReview.requestURL,doi:'10.1234/other',ownerID:'FixtureAccount',state:'waiting',files:[]};};
  await env.app.start();await env.app.openSubmissionReview(task.id);assert.equal(dialogs.length,1);assert.equal(dialogs[0][3].url,task.submissionReview.requestURL);
  assert.equal(env.app.getSnapshot().tasks[0].requestID,'');await env.app.retryTask(task.id);
  assert.deepEqual(env.remoteRequests,['Published1']);assert.equal(env.app.getSnapshot().tasks[0].state,'submission_unknown');assert.equal(env.submissions.length,0);assert.equal(env.publisherCalls.length,0);await env.app.stop();
});

test('a delayed published-review read cannot bind after pause or logout',async()=>{
  for(const action of ['pause','logout']){
    const task=submissionReviewFixture(),env=environment({initialTasks:[task]}),gate=deferred();env.addItem(item(1));let reading=false;
    env.adapter.getRequest=async()=>{reading=true;await gate.promise;return{requestID:'Published1',requestURL:task.submissionReview.requestURL,doi:task.doi,ownerID:'FixtureAccount',state:'waiting',files:[]};};
    await env.app.start();const checking=env.app.checkTask(task.id);await until(()=>reading);await(action==='pause'?env.app.pauseTask(task.id):env.app.logout());gate.resolve();const result=await checking;
    const current=env.app.getSnapshot().tasks[0];assert.equal(result.cancelled,true);assert.equal(current.requestID,'');assert.equal(current.submissionReview.requestID,'Published1');assert.equal(env.submissions.length,0);
    if(action==='pause')assert.equal(current.state,'paused');else assert.equal(env.app.getSnapshot().session.status,'signed_out');await env.app.stop();
  }
});

test('a late failed published-review read preserves a newer pause instead of reopening the review task',async()=>{
  const task=submissionReviewFixture(),env=environment({initialTasks:[task]}),gate=deferred();env.addItem(item(1));let reading=false;
  env.adapter.getRequest=async()=>{reading=true;await gate.promise;throw new Error('late network failure');};
  await env.app.start();const checking=env.app.checkTask(task.id);await until(()=>reading);await env.app.pauseTask(task.id);gate.resolve();await checking;
  const current=env.app.getSnapshot().tasks[0];assert.equal(current.state,'paused');assert.equal(current.requestID,'');assert.equal(current.submissionReview.requestID,'Published1');assert.equal(env.submissions.length,0);await env.app.stop();
});

test('a retained published-review reference blocks another batch or assistance authorization even without an intent file',async()=>{
  for(const state of ['paused','error']){
    const task=submissionReviewFixture(state),env=environment({initialTasks:[task]}),parent=env.addItem(item(1));await env.app.start();
    const result=await env.app.requestAssist(task.id);assert.equal(result.accepted,0);assert.equal(result.skipped,1);
    const capture=await env.app.captureItems([parent],{allowAssist:true});assert.equal(capture.queued,0);assert.equal(capture.retained,1);
    const current=env.app.getSnapshot().tasks[0];assert.equal(current.submissionReview.requestID,'Published1');assert.equal(current.state,state);
    assert.equal(env.submissions.length,0);assert.equal(env.publisherCalls.length,0);await env.app.stop();
  }
});

test('a paused published-review reference cannot be discarded by switching to a local or browser download route',async()=>{
  for(const method of ['importLocalPDF','recheckDownloadedPDFs','openSystemBrowserTask','openExternalTask']){
    const task=submissionReviewFixture('paused'),env=environment({initialTasks:[task],pickPDF:async()=>null});env.addItem(item(1));await env.app.start();
    await assert.rejects(env.app[method](task.id),/求助|核对|核实|请先/);
    const current=env.app.getSnapshot().tasks[0];assert.equal(current.submissionReview.requestID,'Published1',method);assert.equal(current.state,'paused',method);
    assert.equal(env.openedURLs.length,0);assert.equal(env.importCount,0);assert.equal(env.submissions.length,0);await env.app.stop();
  }
});

test('read-only DOI inspection uses live item metadata, saves a safe diagnostic, and refuses changes during lookup',async()=>{
  const task=localFixture(),env=environment({initialTasks:[task]}),parent=env.addItem(item(1)),calls=[];let doi='10.1234/corrected',title='Corrected title';
  const get=parent.getField;parent.getField=name=>name==='DOI'?doi:name==='title'?title:get(name);
  env.adapter.inspectDOI=async value=>{calls.push(value);return{receivedDOI:value,title:'Website title',reason:'match',cookie:'private-secret',raw:{token:'private-secret'}};};
  await env.app.start();await env.app.inspectDOI(task.id);const current=env.app.getSnapshot().tasks[0];
  assert.deepEqual(calls,['10.1234/corrected']);assert.equal(current.doi,task.doi);assert.equal(current.doiCheck.expectedDOI,doi);assert.equal(current.doiCheck.expectedTitle,title);assert.equal(current.doiCheck.receivedTitle,'Website title');
  assert.equal(current.doiCheck.cookie,undefined);assert.equal(current.doiCheck.raw,undefined);assert.equal(env.files.get(queuePath).includes('private-secret'),false);
  current.doiCheck.expectedTitle='Tampered';assert.equal(env.app.getSnapshot().tasks[0].doiCheck.expectedTitle,title);
  const before=JSON.stringify(env.app.getSnapshot().tasks[0].doiCheck),gate=deferred();let reading=false;
  env.adapter.inspectDOI=async()=>{reading=true;await gate.promise;return{receivedDOI:doi,title:'Late website title',reason:'match'};};
  const checking=env.app.inspectDOI(task.id);await until(()=>reading);title='Changed during lookup';gate.resolve();await assert.rejects(checking,/条目信息已改变/);
  assert.equal(JSON.stringify(env.app.getSnapshot().tasks[0].doiCheck),before);assert.equal(env.submissions.length,0);assert.equal(env.publisherCalls.length,0);await env.app.stop();
});

test('old assistance costs refresh read-only with exact owner and DOI checks, preserving receipts and throttling unknown amounts',async()=>{
  for(const mode of ['verified','unknown','wrong-owner','wrong-doi']){
    const pending=importedReceiptFixture(),at=pending.assistReceipt.verifiedAt,task=MODEL.updateTask(pending,{assistReceipt:{...pending.assistReceipt,adoption:'accepted',messages:'done',acceptedAt:at,readAt:at}}),env=completionEnvironment({initialTasks:[task]});env.installAttachment();let reads=0;
    env.adapter.getRequest=async()=>{reads++;return{requestID:task.requestID,doi:mode==='wrong-doi'?'10.1234/other':task.doi,ownerID:mode==='wrong-owner'?'SomeoneElse':'FixtureAccount',state:'available',files:[],...(mode==='unknown'?{}:{requestedPoints:42,pointsVerified:true})};};
    await env.app.start();const before=env.app.getSnapshot().tasks[0],result=await env.app.refreshAssistPoints(task.id),current=env.app.getSnapshot().tasks[0];
    assert.equal(result.verified,mode==='verified',mode);assert.equal(current.requestedPoints,mode==='verified'?42:10);assert.equal(current.pointsVerified,mode==='verified');
    assert.equal(current.attachmentID,before.attachmentID);assert.equal(current.completedAt,before.completedAt);assert.equal(current.assistReceipt.messages,'done');assert.equal(JSON.stringify(current.assistReceipt),JSON.stringify(before.assistReceipt));
    assert.equal(env.posts.length,0);assert.equal(env.messageReads.length,0);assert.equal(env.downloadCalls.length,0);assert.equal(env.submissions.length,0);
    assert.ok(current.lastCheckedAt,'every attempted cost lookup is throttled, including unmatched ownership or DOI');
    await env.timers.find(timer=>timer.ms===15000).callback();assert.equal(reads,1,'poll cannot immediately repeat the cost lookup');await env.app.stop();
  }
});

const checkInPath=path.win32.join('C:\\isolated','fulltext-assistant','checkin-status.json');
function checkInStatus(time,overrides={}){
  const date=new Date(time),day=[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
  return{accountID:'FixtureAccount',day,signed:false,balance:88,reward:null,rewardVerified:false,checkedAt:date.toISOString(),...overrides};
}

test('check-in reminder defaults on, persists independently, and disabled reminders leave explicit read-only refresh available',async()=>{
  const time=new Date(2026,10,8,8).getTime(),env=environment({appTime:time});let reads=0;
  env.adapter.getCheckInStatus=async()=>{reads++;return checkInStatus(time);};await env.app.start();assert.equal(env.app.getSnapshot().settings.checkInReminder,true);
  await env.app.saveSettings({checkInReminder:false,points:29});await env.app.saveSettings({language:'en'});await env.app.refreshAccount();
  await env.app.preferencesOpened();await env.timers.find(timer=>timer.ms===60000).callback();assert.equal(reads,0);
  await env.app.refreshCheckIn({force:true});assert.equal(reads,1);assert.equal(env.submissions.length,0);assert.equal(env.httpCalls.length,0);
  const prefs=Object.fromEntries(env.prefs);await env.app.stop();const restored=environment({initialPrefs:prefs,appTime:time});await restored.app.start();
  assert.equal(restored.app.getSnapshot().settings.checkInReminder,false);assert.equal(restored.app.getSnapshot().settings.points,29);assert.equal(restored.app.getSnapshot().settings.language,'en');await restored.app.stop();
});

test('concurrent check-in reads share one request and persist only safe account-scoped status, balance and verified reward',async()=>{
  const time=new Date(2026,10,8,8).getTime(),env=environment({appTime:time}),gate=deferred();let reads=0;
  env.adapter.getCheckInStatus=async()=>{reads++;await gate.promise;return{...checkInStatus(time,{signed:true,balance:93,reward:5,rewardVerified:true}),cookie:'private-secret',password:'private-secret'};};
  await env.app.start();await env.app.refreshAccount();const first=env.app.refreshCheckIn(),second=env.app.refreshCheckIn({force:true});await until(()=>reads===1);
  assert.equal(env.app.getSnapshot().checkIn.state,'checking');gate.resolve();await Promise.all([first,second]);
  const current=env.app.getSnapshot().checkIn;assert.equal(current.state,'loaded');assert.equal(current.signed,true);assert.equal(current.balance,93);assert.equal(current.reward,5);assert.equal(current.rewardVerified,true);assert.equal(current.accountID,undefined);
  current.balance=999;assert.equal(env.app.getSnapshot().checkIn.balance,93);
  const saved=env.files.get(checkInPath);assert.equal(saved.includes('private-secret'),false);assert.equal(JSON.parse(saved).accounts[0].accountID,'FixtureAccount');assert.equal(env.submissions.length,0);assert.equal(env.httpCalls.length,0);await env.app.stop();
});

test('check-in state restores for the matching account and never exposes the previous account balance after a switch or logout',async()=>{
  const time=new Date(2026,10,8,8).getTime(),env=environment({appTime:time});env.adapter.getCheckInStatus=async()=>checkInStatus(time,{signed:true,balance:93,reward:5,rewardVerified:true});
  await env.app.start();await env.app.refreshAccount();await env.app.refreshCheckIn();const saved=env.files.get(checkInPath);await env.app.stop();
  const restored=environment({appTime:time});restored.files.set(checkInPath,saved);await restored.app.start();assert.equal(restored.app.getSnapshot().checkIn.balance,null);
  await restored.app.refreshAccount();assert.equal(restored.app.getSnapshot().checkIn.balance,93);assert.equal(restored.app.getSnapshot().checkIn.rewardVerified,true);
  restored.account.accountID='OtherAccount';await restored.app.refreshAccount();assert.equal(restored.app.getSnapshot().checkIn.balance,null);assert.equal(restored.app.getSnapshot().checkIn.signed,null);
  restored.account.accountID='FixtureAccount';await restored.app.refreshAccount();assert.equal(restored.app.getSnapshot().checkIn.balance,93);
  await restored.app.logout();assert.equal(restored.app.getSnapshot().checkIn.state,'signed_out');assert.equal(restored.app.getSnapshot().checkIn.balance,null);assert.equal(restored.app.getSnapshot().checkIn.reward,null);await restored.app.stop();
});

test('daily check-in timer waits until local six, checks once per day, and clears yesterday success and reward at midnight',async()=>{
  let time=new Date(2026,10,8,5,59).getTime();const env=environment({appTime:time});let reads=0;
  env.adapter.getCheckInStatus=async()=>{reads++;return checkInStatus(time,{signed:true,reward:5,rewardVerified:true});};await env.app.start();await env.app.refreshAccount();
  const tick=env.timers.find(timer=>timer.ms===60000).callback;await tick();assert.equal(reads,0);
  time+=60000;env.setAppTime(time);await tick();assert.equal(reads,1);assert.equal(env.app.getSnapshot().checkIn.signed,true);
  time+=6*3600000;env.setAppTime(time);await tick();assert.equal(reads,1);
  time=new Date(2026,10,9,0,1).getTime();env.setAppTime(time);let current=env.app.getSnapshot().checkIn;
  assert.equal(current.state,'idle');assert.equal(current.signed,null);assert.equal(current.reward,null);assert.equal(current.rewardVerified,false);assert.equal(current.balance,88);
  await tick();assert.equal(reads,1);time=new Date(2026,10,9,6).getTime();env.setAppTime(time);await tick();assert.equal(reads,2);assert.equal(env.submissions.length,0);await env.app.stop();
});

test('opening preferences restores an available session and throttles unsigned check-in reads for two minutes',async()=>{
  let time=new Date(2026,10,8,5).getTime();const env=environment({appTime:time});let reads=0;
  env.adapter.getCheckInStatus=async()=>{reads++;return checkInStatus(time);};await env.app.start();assert.equal(env.app.getSnapshot().session.status,'signed_out');
  env.session.getStatus=()=>({hasCookies:true,persistent:true});await env.app.preferencesOpened();assert.equal(env.accountCalls,1);assert.equal(reads,1);assert.equal(env.app.getSnapshot().checkIn.signed,false);
  time+=119000;env.setAppTime(time);await env.app.preferencesOpened();assert.equal(reads,1);
  time+=1000;env.setAppTime(time);await env.app.preferencesOpened();assert.equal(reads,2);
  await env.app.refreshCheckIn({force:true});assert.equal(reads,3);assert.equal(env.submissions.length,0);await env.app.stop();
});

test('failed check-in reads retry automatically only after fifteen minutes and do not claim a successful reward',async()=>{
  let time=new Date(2026,10,8,8).getTime();const env=environment({appTime:time});let reads=0;
  env.adapter.getCheckInStatus=async()=>{reads++;if(reads<2)throw new Error('Temporary website error');return checkInStatus(time);};await env.app.start();await env.app.refreshAccount();
  await assert.rejects(env.app.refreshCheckIn(),/Temporary website/);assert.equal(env.app.getSnapshot().checkIn.state,'error');assert.equal(env.app.getSnapshot().checkIn.rewardVerified,false);
  time+=14*60000;env.setAppTime(time);await env.app.preferencesOpened();await env.timers.find(timer=>timer.ms===60000).callback();assert.equal(reads,1);
  time+=60000;env.setAppTime(time);await env.timers.find(timer=>timer.ms===60000).callback();assert.equal(reads,2);assert.equal(env.app.getSnapshot().checkIn.state,'loaded');assert.equal(env.app.getSnapshot().checkIn.signed,false);await env.app.stop();
});

test('opening check-in only opens the official page and briefly observes human completion without any submission',async()=>{
  let time=new Date(2026,10,8,5).getTime();const env=environment({appTime:time}),dialogs=[];let reads=0,signed=false;
  env.Zotero.getMainWindow=()=>({openDialog(...args){dialogs.push(args);return{closed:false,close(){this.closed=true;},focus(){}};}});
  env.adapter.getCheckInStatus=async()=>{reads++;return checkInStatus(time,{signed,balance:signed?93:88,reward:signed?5:null,rewardVerified:signed});};
  await env.app.start();await env.app.refreshAccount();await env.app.refreshCheckIn();await env.app.openCheckIn();
  assert.equal(dialogs.length,1);assert.equal(dialogs[0][3].url,'https://www.ablesci.com/');assert.equal(dialogs[0][3].mode,'checkin');assert.equal(reads,1);
  const tick=env.timers.find(timer=>timer.ms===60000).callback;time+=60000;env.setAppTime(time);await tick();assert.equal(reads,1);
  signed=true;time+=60000;env.setAppTime(time);await tick();assert.equal(reads,2);assert.equal(env.app.getSnapshot().checkIn.rewardVerified,true);
  time+=11*60000;env.setAppTime(time);await tick();assert.equal(reads,2);assert.equal(env.submissions.length,0);assert.equal(env.httpCalls.length,0);await env.app.stop();
});

test('late check-in responses cannot restore old account data after logout, account switch or shutdown',async()=>{
  for(const action of ['logout','switch','stop']){
    const time=new Date(2026,10,8,8).getTime(),env=environment({appTime:time}),gate=deferred();let reading=false;
    env.adapter.getCheckInStatus=async()=>{reading=true;await gate.promise;return checkInStatus(time,{signed:true,balance:93,reward:5,rewardVerified:true});};
    await env.app.start();await env.app.refreshAccount();const pending=env.app.refreshCheckIn().catch(error=>error);await until(()=>reading);
    if(action==='logout')await env.app.logout();else if(action==='switch'){env.account.accountID='OtherAccount';await env.app.refreshAccount();}else await env.app.stop();
    gate.resolve();const result=await pending;assert.equal(result.name,'AbortError');assert.equal(env.app.getSnapshot().checkIn.balance,null);assert.equal(env.files.has(checkInPath),false);assert.equal(env.submissions.length,0);
    if(action!=='stop')await env.app.stop();
  }
});

test('a new account can start its own check-in read while an obsolete account read is still pending',async()=>{
  const time=new Date(2026,10,8,8).getTime(),env=environment({appTime:time}),gate=deferred();let reads=0;
  env.adapter.getCheckInStatus=async()=>{const accountID=env.account.accountID;reads++;if(accountID==='FixtureAccount')await gate.promise;return checkInStatus(time,{accountID,balance:accountID==='OtherAccount'?17:93});};
  await env.app.start();await env.app.refreshAccount();const old=env.app.refreshCheckIn().catch(error=>error);await until(()=>reads===1);
  env.account.accountID='OtherAccount';await env.app.refreshAccount();await env.app.refreshCheckIn();assert.equal(reads,2);assert.equal(env.app.getSnapshot().checkIn.balance,17);
  gate.resolve();await old;assert.equal(env.app.getSnapshot().checkIn.balance,17);assert.deepEqual(JSON.parse(env.files.get(checkInPath)).accounts.map(record=>record.accountID),['OtherAccount']);await env.app.stop();
});

test('check-in replies from another account or day cannot claim a reward and malformed rewards remain unverified',async()=>{
  const time=new Date(2026,10,8,8).getTime();
  for(const patch of [{accountID:'OtherAccount'},{day:'2026-11-07'}]){
    const env=environment({appTime:time});env.adapter.getCheckInStatus=async()=>checkInStatus(time,{...patch,signed:true,balance:93,reward:5,rewardVerified:true});await env.app.start();await env.app.refreshAccount();
    await assert.rejects(env.app.refreshCheckIn());assert.equal(env.app.getSnapshot().checkIn.state,'error');assert.equal(env.app.getSnapshot().checkIn.signed,null);assert.equal(env.app.getSnapshot().checkIn.balance,null);assert.equal(env.app.getSnapshot().checkIn.rewardVerified,false);await env.app.stop();
  }
  const env=environment({appTime:time});env.adapter.getCheckInStatus=async()=>checkInStatus(time,{signed:true,balance:93,reward:-1,rewardVerified:true});await env.app.start();await env.app.refreshAccount();await env.app.refreshCheckIn();
  assert.equal(env.app.getSnapshot().checkIn.balance,93);assert.equal(env.app.getSnapshot().checkIn.reward,null);assert.equal(env.app.getSnapshot().checkIn.rewardVerified,false);await env.app.stop();
});
