const test = require('node:test');
const assert = require('node:assert/strict');
const CNKI = require('../src/cnki.js');
const { create } = require('../src/cnki-controller.js');
const URL_A = 'https://kns.cnki.net/KCMS/detail/detail.aspx?dbcode=CJFD&dbname=CJFD2024&filename=TEST202401001';
const URL_B = URL_A.replace('001','002');
const record = CNKI.normalizeRecord(URL_A);
const data = { title:'研究不同环境条件下中文文献识别的实验方法',doi:'10.1234/cnki.fixture',authors:['王明','张林'],journal:'测试学报',date:'2024',abstract:'测试摘要',itemType:'journalArticle',keywords:[] };
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };
function env(options={}) {
  const prefs=new Map(),items=new Map(),calls=[],opens=[],hosts=[],selected=[];let nextID=1,saveCount=0;
  const libraries=new Map([[1,{editable:true}],[2,{editable:false}]]);let selectedLibrary=1;
  class Item {
    constructor(type='journalArticle'){this.itemType=type;this.itemTypeID=1;this.fields={};this.creators=[];this.libraryID=1;this.key='K'+nextID;this.deleted=false;}
    getField(name){return this.fields[name]||'';}setField(name,value){this.fields[name]=value;}
    getCreators(){return this.creators;}setCreators(values){this.creators=values;}isRegularItem(){return true;}
    setCollections(ids){this.collections=ids;}
    async saveTx(){await options.save?.(this);if(!this.id)this.id=nextID++;items.set(this.id,this);saveCount++;}
  }
  const Zotero={Item,Libraries:{userLibraryID:1,get:id=>libraries.get(id)},Items:{getAsync:async id=>items.get(id)},getActiveZoteroPane:()=>({getSelectedItems:()=>selected,getSelectedLibraryID:()=>selectedLibrary,getSelectedCollection:()=>({id:5,libraryID:1})})};
  Zotero.Search=class{addCondition(field,operator,value){this.field=field;this.operator=operator;this.value=value;}async search(){return [...items.values()].filter(item=>(!this.libraryID||item.libraryID===this.libraryID)&&(this.operator==='is'?item.getField(this.field).toLowerCase()===this.value.toLowerCase():item.getField(this.field).toLowerCase().includes(this.value.toLowerCase()))).map(item=>item.id);}};
  const publisher={async inspectCNKI(input,opts){calls.push({input,opts});return options.inspect?options.inspect(input,opts):{status:'pdf_available',record,metadata:data};}};
  const publisherSession={getStatus:()=>({hosts:[...hosts]}),async grantHosts(values){await options.grant?.();hosts.push(...values);},async forgetHosts(values,settings){calls.push({reset:values,settings});hosts.length=0;}};
  const api=create({Zotero,Services:{prefs:{getBoolPref:(key,fallback)=>prefs.get(key)??fallback,setBoolPref:(key,value)=>prefs.set(key,value)}},cnki:CNKI,publisher,publisherSession,publisherWindow:{open:value=>opens.push(value),closePurpose:value=>calls.push({close:value})},isProtected:options.isProtected,beforeReset:options.beforeReset});
  return {api,prefs,items,calls,opens,hosts,selected,libraries,Zotero,selectLibrary:id=>selectedLibrary=id,get saveCount(){return saveCount;},async add(fields={},libraryID=1){const item=new Item();item.fields={...fields};item.libraryID=libraryID;await item.saveTx();return item;}};
}
test('preview is read-only, safe and distinct from authenticated PDF access',async()=>{
  const e=env();const snapshot=await e.api.inspectURL(URL_A+'&v=private');assert.equal(snapshot.state,'metadata_ready');assert.equal(snapshot.canImport,true);assert.equal(snapshot.checking,false);assert.equal(snapshot.sessionRemembered,false);assert.equal(e.saveCount,0);assert.equal(snapshot.record.url.includes('private'),false);
  snapshot.metadata.authors.push('bad');assert.equal(e.api.getSnapshot().metadata.authors.length,2);await e.api.destroy();
});
test('explicit preview import preserves CNKI ID, single-field Chinese authors, collection and deduplicates',async()=>{
  const e=env();await e.api.inspectURL(URL_A);const first=await e.api.importPreview();assert.equal(first.imported,true);const item=e.items.get(first.itemID);assert.equal(item.getField('DOI'),data.doi);assert.match(item.getField('extra'),/CNKI: CNKI:CJFD:TEST202401001/);assert.deepEqual(item.collections,[5]);assert.equal(item.creators[0].lastName,'王明');assert.equal(item.creators[0].fieldMode,1);
  const again=await e.api.importPreview();assert.equal(again.existing,true);assert.equal(e.saveCount,1);await e.api.destroy();
});
test('no DOI is invented and existing CNKI URL deduplicates without extra fields',async()=>{
  const e=env({inspect:async()=>({status:'metadata_only',record,metadata:{...data,doi:''}})});const existing=await e.add({url:URL_A,title:data.title});await e.api.inspectURL(URL_A);const result=await e.api.importPreview();assert.equal(result.itemID,existing.id);assert.equal(result.existing,true);assert.equal(existing.getField('DOI'),'');await e.api.destroy();
});
test('same DOI with conflicting CNKI identity refuses a new ambiguous import',async()=>{
  const e=env();await e.add({DOI:data.doi,url:URL_B,title:data.title});await e.api.inspectURL(URL_A);await assert.rejects(e.api.importPreview(),/相同 DOI/);assert.equal(e.saveCount,1);await e.api.destroy();
});
test('metadata permission and PDF permission are distinct, CAJ never implies PDF',async()=>{
  for(const status of ['caj_only','purchase_required','access_denied','login_required']){const e=env({inspect:async()=>({status,record,metadata:data})});const s=await e.api.inspectURL(URL_A);assert.equal(s.state,status);assert.equal(s.canImport,true);assert.equal(e.saveCount,0);await e.api.destroy();}
});
test('mismatched and unavailable metadata cannot be imported',async()=>{
  for(const status of ['article_mismatch','metadata_unavailable','record_unavailable']){const e=env({inspect:async()=>({status,record,metadata:data})});const s=await e.api.inspectURL(URL_A);assert.equal(s.canImport,false);assert.throws(()=>e.api.importPreview(),/先解析/);await e.api.destroy();}
});
test('verify uses selected CNKI entry and no sample is not a failed login',async()=>{
  const e=env();assert.equal((await e.api.verify()).state,'no_sample');const item=await e.add({url:URL_A,title:data.title});e.selected.push(item);assert.equal((await e.api.verify()).state,'metadata_ready');assert.equal(e.calls[0].input,item);await e.api.destroy();
});
test('metadata enrichment fills blanks only and leaves existing user fields and creators',async()=>{
  const e=env();const item=await e.add({url:URL_A,title:data.title,publicationTitle:'用户期刊',extra:'My field: retained'});item.creators=[{lastName:'已有作者',fieldMode:1,creatorType:'author'}];e.selected.push(item);
  const result=await e.api.enrichSelected();assert.equal(result.updated,1);assert.equal(item.getField('publicationTitle'),'用户期刊');assert.equal(item.getField('DOI'),data.doi);assert.match(item.getField('extra'),/^My field: retained/);assert.equal(item.creators[0].lastName,'已有作者');await e.api.destroy();
});
test('enrichment skips changed identities and protected active assistance items',async()=>{
  const gate=deferred(),e=env({inspect:async()=>{await gate.promise;return {status:'metadata_only',record,metadata:data};},isProtected:item=>item.id===2});const a=await e.add({url:URL_A,title:data.title}),b=await e.add({url:URL_A,title:data.title});e.selected.push(a,b);const operation=e.api.enrichSelected();await new Promise(done=>setImmediate(done));a.setField('url',URL_B);gate.resolve();const result=await operation;assert.equal(result.skipped,2);assert.equal(a.getField('DOI'),'');assert.equal(e.saveCount,2);await e.api.destroy();
});
test('read-only library cannot import and metadata operation failures do not imply success',async()=>{
  const e=env();await e.api.inspectURL(URL_A);e.selectLibrary(2);assert.throws(()=>e.api.importPreview(),/不能编辑/);const item=await e.add({url:URL_A,title:data.title},2);e.selected.push(item);assert.equal((await e.api.enrichSelected()).skipped,1);await e.api.destroy();
});
test('duplicate import clicks are blocked while first explicit save is in progress',async()=>{
  const gate=deferred(),e=env({save:async()=>gate.promise});await e.api.inspectURL(URL_A);const operation=e.api.importPreview();await new Promise(done=>setImmediate(done));assert.throws(()=>e.api.importPreview(),/正在进行/);gate.resolve();assert.equal((await operation).imported,true);assert.equal(e.saveCount,1);await e.api.destroy();
});
test('reset invalidates pending probe and clears CNKI only after request settles',async()=>{
  const gate=deferred(),e=env({inspect:async()=>{await gate.promise;return {status:'metadata_only',record,metadata:data};}});const pending=e.api.inspectURL(URL_A);const reset=e.api.resetSession();assert.equal(e.calls.some(c=>c.reset),false);gate.resolve();await assert.rejects(pending,{name:'AbortError'});await reset;assert.deepEqual(e.calls.find(c=>c.reset).reset,['cnki.net','cnki.com.cn']);assert.equal(e.api.getSnapshot().canImport,false);assert.equal(e.api.getSnapshot().state,'idle');await e.api.destroy();
});
test('login persistence grants are drained before reset and do not reopen a stale login window',async()=>{
  const gate=deferred(),e=env({grant:async()=>gate.promise});const login=e.api.openLogin();const reset=e.api.resetSession();gate.resolve();await assert.rejects(login,{name:'AbortError'});await reset;assert.equal(e.opens.length,0);assert.equal(e.hosts.length,0);await e.api.destroy();
});
test('shutdown waits for a committed metadata save and prevents new operations',async()=>{
  const gate=deferred(),e=env({save:async()=>gate.promise});await e.api.inspectURL(URL_A);const operation=e.api.importPreview();await new Promise(done=>setImmediate(done));let done=false;const stopping=e.api.destroy().then(()=>done=true);assert.equal(done,false);gate.resolve();assert.equal((await operation).imported,true);await stopping;assert.equal(e.saveCount,1);await assert.rejects(e.api.inspectURL(URL_A),{name:'AbortError'});
});
test('disabled CNKI and non-article URLs make no network calls',async()=>{
  const e=env();assert.throws(()=>e.api.inspectURL('https://example.com/'),/详情页/);e.api.saveSettings({enabled:false});await assert.rejects(e.api.inspectURL(URL_A),/开启/);assert.equal(e.calls.length,0);await e.api.destroy();
});
test('references are fetched explicitly, remain partial and import only selected reliable titles',async()=>{
  const references={status:'partial',totalCount:50,partial:true,complete:false,references:[{id:'r1',title:'可确认的参考文献标题',authors:['李明'],year:'2021',doi:'10.2345/reference',canImport:true,raw:'李明. 可确认的参考文献标题.'},{id:'r2',raw:'没有可靠题名的整条引文',canImport:false,title:''}]};
  const e=env({inspect:async(input,options)=>({status:'metadata_only',record,metadata:data,...(options.includeReferences?{references}:{})})});
  await e.api.inspectURL(URL_A);assert.equal(e.api.getSnapshot().references.items.length,0);
  const snapshot=await e.api.fetchReferences();assert.equal(snapshot.checking,false);assert.equal(snapshot.references.state,'partial');assert.equal(snapshot.references.total,50);assert.equal(e.saveCount,0);
  assert.throws(()=>e.api.importReferences(['r2']),/可靠识别/);assert.throws(()=>e.api.importReferences([]),/1 至 50/);
  const imported=await e.api.importReferences(['r1']);assert.equal(imported.imported,1);const item=[...e.items.values()][0];assert.equal(item.itemType,'document');assert.match(item.getField('extra'),/CNKI Reference Source: CNKI:CJFD:TEST202401001/);assert.equal(item.getField('DOI'),'10.2345/reference');
  assert.equal((await e.api.importReferences(['r1'])).existing,1);assert.equal(e.saveCount,1);await e.api.destroy();
});
test('references use declared titles, scrub transient URLs and reset on article change',async()=>{
  const references={status:'partial',references:[{id:'r1',title:'独立来源的中文参考文献标题',canImport:true,url:URL_B+'&v=SECRET',record:CNKI.normalizeRecord(URL_B),year:'2020'}]};
  const e=env({inspect:async()=>({status:'metadata_only',record,metadata:data,references})});await e.api.inspectURL(URL_A);await e.api.fetchReferences();assert.doesNotMatch(JSON.stringify(e.api.getSnapshot()),/SECRET/);
  await e.api.inspectURL(URL_A);assert.equal(e.api.getSnapshot().references.items.length,0);assert.throws(()=>e.api.importReferences(['r1']),/重新提取/);await e.api.destroy();
});
test('unavailable references are not reported as an article with no citations',async()=>{
  const e=env({inspect:async()=>({status:'metadata_only',record,metadata:data,references:{status:'unavailable',references:[]}})});await e.api.inspectURL(URL_A);const s=await e.api.fetchReferences();assert.equal(s.references.state,'unavailable');assert.match(s.references.message,/不表示原文没有/);await e.api.destroy();
});
test('reference results for a different parent article are refused',async()=>{
  const e=env({inspect:async(_,opts)=>({status:'metadata_only',record:opts.includeReferences?CNKI.normalizeRecord(URL_B):record,metadata:data,references:{references:[{id:'r1',title:'wrong parent',canImport:true}]}})});await e.api.inspectURL(URL_A);const s=await e.api.fetchReferences();assert.equal(s.references.state,'error');assert.equal(s.references.items.length,0);await e.api.destroy();
});
test('reference extraction respects cancellation and never restores pre-reset rows',async()=>{
  const gate=deferred(),e=env({inspect:async(_,opts)=>{if(opts.includeReferences)await gate.promise;return {status:'metadata_only',record,metadata:data,references:{references:[{id:'r1',title:'引用',canImport:true}]}};}});await e.api.inspectURL(URL_A);const pending=e.api.fetchReferences(),reset=e.api.resetSession();gate.resolve();await assert.rejects(pending,{name:'AbortError'});await reset;assert.equal(e.api.getSnapshot().references.items.length,0);await e.api.destroy();
});
test('unknown result codes fail closed despite containing plausible metadata',async()=>{
  const e=env({inspect:async()=>({status:'network_error',record,metadata:data})});assert.equal((await e.api.inspectURL(URL_A)).canImport,false);assert.throws(()=>e.api.importPreview(),/先解析/);await e.api.destroy();
});
test('same generic reference title without author evidence is not declared a duplicate',async()=>{
  const references={references:[{id:'r1',title:'Introduction',year:'2021',canImport:true,raw:'A different author. Introduction.'}]};
  const e=env({inspect:async()=>({status:'metadata_only',record,metadata:data,references})});await e.add({title:'Introduction',date:'2021'});await e.api.inspectURL(URL_A);await e.api.fetchReferences();assert.equal((await e.api.importReferences(['r1'])).imported,1);assert.equal((await e.api.importReferences(['r1'])).existing,1);await e.api.destroy();
});
test('reference cancellation reports committed items and native busy snapshot',async()=>{
  const gate=deferred(),references={references:[{id:'r1',title:'第一条可识别参考文献的标题',canImport:true},{id:'r2',title:'第二条可识别参考文献的标题',canImport:true}]};
  const e=env({save:async()=>gate.promise,inspect:async()=>({status:'metadata_only',record,metadata:data,references})});await e.api.inspectURL(URL_A);await e.api.fetchReferences();const importing=e.api.importReferences(['r1','r2']);assert.equal(e.api.getSnapshot().checking,true);await new Promise(done=>setImmediate(done));const stopping=e.api.destroy();gate.resolve();const result=await importing;assert.equal(result.imported,1);assert.equal(result.cancelled,true);assert.match(result.message,/已保存/);await stopping;
});
test('reference author text and public thesis URL survive explicit import',async()=>{
  const thesisURL='https://cdmd.cnki.com.cn/Article/CDMD-10255-1021000001.htm',references={references:[{id:'r1',title:'中国学位论文的可确认参考文献题名',canImport:true,authorText:'张三;李四',url:thesisURL,itemType:'thesis',year:'2021'}]};
  const e=env({inspect:async()=>({status:'metadata_only',record,metadata:data,references})});await e.api.inspectURL(URL_A);await e.api.fetchReferences();assert.equal((await e.api.importReferences(['r1'])).imported,1);const item=[...e.items.values()][0];assert.equal(item.itemType,'thesis');assert.equal(item.getField('url'),thesisURL);assert.match(item.getField('extra'),/CNKI Reference Authors: 张三;李四/);await e.api.destroy();
});
