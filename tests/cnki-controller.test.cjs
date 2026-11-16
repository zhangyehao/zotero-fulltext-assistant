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
  const prefs=new Map(),items=new Map(),calls=[],opens=[],launches=[],copied=[],hosts=[],selected=[];let nextID=1,saveCount=0;
  const libraries=new Map([[1,{editable:true}],[2,{editable:false}]]);let selectedLibrary=1;
  class Item {
    constructor(type='journalArticle'){this.itemType=type;this.itemTypeID=1;this.fields={};this.creators=[];this.libraryID=1;this.key='K'+nextID;this.deleted=false;}
    getField(name){return this.fields[name]||'';}setField(name,value){this.fields[name]=value;}
    getCreators(){return this.creators;}setCreators(values){this.creators=values;}isRegularItem(){return true;}
    setCollections(ids){this.collections=ids;}
    async saveTx(){await options.save?.(this);if(!this.id)this.id=nextID++;items.set(this.id,this);saveCount++;}
  }
  const Zotero={Item,Libraries:{userLibraryID:1,get:id=>libraries.get(id)},Items:{getAsync:async id=>items.get(id)},getActiveZoteroPane:()=>({getSelectedItems:()=>selected,getSelectedLibraryID:()=>selectedLibrary,getSelectedCollection:()=>({id:5,libraryID:1})})};
  Zotero.launchURL=async url=>{await options.launch?.(url);launches.push(url);};
  Zotero.Utilities={Internal:{copyTextToClipboard:async text=>{await options.copy?.(text);copied.push(text);}}};
  Zotero.Search=class{addCondition(field,operator,value){this.field=field;this.operator=operator;this.value=value;}async search(){return [...items.values()].filter(item=>(!this.libraryID||item.libraryID===this.libraryID)&&(this.operator==='is'?item.getField(this.field).toLowerCase()===this.value.toLowerCase():item.getField(this.field).toLowerCase().includes(this.value.toLowerCase()))).map(item=>item.id);}};
  const publisher={async inspectCNKI(input,opts){calls.push({input,opts});return options.inspect?options.inspect(input,opts):{status:'pdf_available',record,metadata:data};}};
  const publisherSession={getStatus:()=>({hosts:[...hosts]}),async grantHosts(values){await options.grant?.();hosts.push(...values);},async forgetHosts(values,settings){calls.push({reset:values,settings});hosts.length=0;}};
  const api=create({Zotero,Services:{prefs:{getBoolPref:(key,fallback)=>prefs.get(key)??fallback,setBoolPref:(key,value)=>prefs.set(key,value)}},cnki:CNKI,publisher,publisherSession,publisherWindow:{open:value=>opens.push(value),closePurpose:value=>calls.push({close:value})},isProtected:options.isProtected,beforeReset:options.beforeReset});
  return {api,prefs,items,calls,opens,launches,copied,hosts,selected,libraries,Zotero,selectLibrary:id=>selectedLibrary=id,get saveCount(){return saveCount;},async add(fields={},libraryID=1){const item=new Item();item.fields={...fields};item.libraryID=libraryID;await item.saveTx();return item;}};
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
test('automatic access verification ignores a selected generic DOI and does not test account login',async()=>{
  const e=env(),item=await e.add({DOI:'10.1234/ordinary.paper',url:'https://other-publisher.test/article',title:'An unrelated article'});e.selected.push(item);
  await e.api.openLogin();const snapshot=await e.api.verify();
  assert.equal(snapshot.state,'no_sample');assert.equal(snapshot.sessionRemembered,true);assert.equal(snapshot.lastCheckedAt,null);
  assert.match(snapshot.message,/明确关联知网/);assert.match(snapshot.message,/不用于判定账号是否已登录/);assert.equal(snapshot.canImport,false);assert.equal(e.calls.length,0);
  await e.api.destroy();
});
test('automatic verification selects explicit CNKI evidence before unrelated selected DOI entries',async()=>{
  const e=env(),other=await e.add({DOI:'10.1234/ordinary.paper',title:'Another article'}),known=await e.add({url:URL_A,title:data.title});
  e.selected.push(other);assert.equal((await e.api.verify()).state,'metadata_ready');assert.equal(e.calls.at(-1).input,known);assert.equal(e.calls.at(-1).opts.userInitiated,true);
  await e.api.destroy();
});
test('automatic library samples include CNKI IDs and DOI-only CNKI records',async()=>{
  for(const fields of [{extra:'CNKI: '+record.id},{extra:'CNKI ID: '+record.id},{extra:'CNKI URL: '+URL_A},{DOI:'10.1234/d.cnki.fixture.2026.000001'}]){
    const e=env(),known=await e.add({...fields,title:data.title});assert.equal((await e.api.verify()).state,'metadata_ready');assert.equal(e.calls.at(-1).input,known);await e.api.destroy();
  }
  for(const DOI of ['10.1234/notcnki.paper','10.1234/paper.cnkiOther']){
    const e=env(),item=await e.add({DOI,title:data.title});e.selected.push(item);assert.equal((await e.api.verify()).state,'no_sample');assert.equal(e.calls.length,0);await e.api.destroy();
  }
});
test('explicit verification input wins over preview and selection and supports generic valid DOI input',async()=>{
  const e=env(),selected=await e.add({url:URL_A,title:data.title});e.selected.push(selected);await e.api.inspectURL(URL_A);
  await e.api.verify(URL_B);assert.equal(e.calls.at(-1).input,URL_B);assert.equal(e.calls.at(-1).opts.userInitiated,true);
  await e.api.verify(' DOI: 10.1234/ordinary.paper ');assert.equal(e.calls.at(-1).input,'https://doi.org/10.1234/ordinary.paper');assert.equal(e.calls.at(-1).opts.userInitiated,true);
  const count=e.calls.length;await assert.rejects(e.api.verify('https://other-publisher.test/article'),/有效 DOI/);assert.equal(e.calls.length,count);
  await e.api.destroy();
});
test('empty verification input rechecks the current CNKI preview before a different selection',async()=>{
  const e=env(),selected=await e.add({url:URL_B,title:data.title});await e.api.inspectURL(URL_A);e.selected.push(selected);
  await e.api.verify(' ');assert.equal(e.calls.at(-1).input,URL_A);assert.equal(e.calls.at(-1).opts.userInitiated,true);await e.api.destroy();
});
test('a mismatched item cannot become a context-free URL preview on the next empty verification',async()=>{
  const e=env({inspect:async input=>({status:typeof input==='string'?'pdf_available':'article_mismatch',record,metadata:data})});
  const item=await e.add({url:URL_A,title:'A conflicting item title',DOI:'10.1234/conflicting.item'});e.selected.push(item);
  assert.equal((await e.api.verify()).state,'article_mismatch');const retry=await e.api.verify(' ');
  assert.equal(e.calls.length,2);assert(e.calls.every(call=>call.input===item));assert.equal(retry.state,'article_mismatch');assert.equal(retry.canImport,false);
  assert.throws(()=>e.api.importPreview(),/先解析/);await e.api.destroy();
});
test('explicit title verification uses the existing search handoff without requesting arbitrary DOI samples',async()=>{
  const e=env(),item=await e.add({DOI:'10.1234/ordinary.paper',title:'Unrelated paper'});e.selected.push(item);
  const result=await e.api.verify('明确输入的中文文献完整标题');assert.equal(result.state,'search_required');assert.equal(e.launches.length,1);assert.equal(e.calls.length,0);await e.api.destroy();
});
test('opening login clears a previous check error without claiming authenticated access',async()=>{
  const e=env({inspect:async()=>({status:'unsupported_url'})});const failed=await e.api.inspectURL(URL_A);assert.equal(failed.state,'unsupported_url');assert(failed.lastCheckedAt);
  const opened=await e.api.openLogin();assert.equal(opened.state,'idle');assert.equal(opened.lastCheckedAt,null);assert.equal(opened.canImport,false);assert.equal(opened.sessionRemembered,true);
  assert.match(opened.message,/打开窗口不代表已验证登录/);assert.equal(e.opens.length,1);assert.equal(e.calls.length,1);await e.api.destroy();
});
test('CNKI check failures retain distinct causes and never become a login verdict',async()=>{
  for(const status of ['timeout','network_error','http_error','rate_limited','unsafe_redirect','response_too_large','redirect_limit','article_mismatch','unsupported_url','not_cnki']){
    const e=env({inspect:async()=>({status,record,metadata:data})}),snapshot=await e.api.inspectURL(URL_A);
    assert.equal(snapshot.state,status,status);assert.equal(snapshot.canImport,false,status);assert(snapshot.lastCheckedAt,status);
    assert.doesNotMatch(snapshot.message,/请[^；。]*(?:重新|完成)[^；。]*登录|需要知网登录/,status);assert.throws(()=>e.api.importPreview(),/先解析/);await e.api.destroy();
  }
});
test('unexpected request exceptions distinguish timeout and discard stale preview metadata',async()=>{
  for(const error of [Object.assign(new Error('private diagnostic'),{code:'timeout'}),new Error('private diagnostic')]){
    let calls=0;const e=env({inspect:async()=>{if(calls++)throw error;return {status:'metadata_only',record,metadata:data};}});await e.api.inspectURL(URL_A);
    await assert.rejects(e.api.inspectURL(URL_B),/不能判断账号是否已登录/);const failed=e.api.getSnapshot();
    assert.equal(failed.state,error.code==='timeout'?'timeout':'network_error');assert.equal(failed.record,null);assert.equal(failed.metadata,null);assert.equal(failed.canImport,false);assert.equal(failed.checking,false);assert.doesNotMatch(failed.message,/private diagnostic/);
    assert.equal((await e.api.verify()).state,'no_sample');await e.api.destroy();
  }
});
test('explicit checks may retry a solved website challenge while enrichment keeps normal cooldown semantics',async()=>{
  const e=env(),item=await e.add({url:URL_A,title:data.title});e.selected.push(item);
  await e.api.inspectURL(URL_A);assert.equal(e.calls.at(-1).opts.userInitiated,true);
  await e.api.verify();assert.equal(e.calls.at(-1).opts.userInitiated,true);
  await e.api.enrichSelected();assert.equal(e.calls.at(-1).opts.userInitiated,undefined);await e.api.destroy();
});
test('verification does not replace an active check or inspect disabled and invalid inputs',async()=>{
  const gate=deferred(),e=env({inspect:async()=>{await gate.promise;return {status:'metadata_only',record,metadata:data};}}),pending=e.api.inspectURL(URL_A);
  await assert.rejects(e.api.verify(),/正在进行/);assert.equal(e.api.getSnapshot().state,'checking');gate.resolve();await pending;
  await assert.rejects(e.api.verify({url:URL_A}),/有效 DOI/);e.api.saveSettings({enabled:false});await assert.rejects(e.api.verify(),/开启/);assert.equal(e.calls.length,1);await e.api.destroy();
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
  const e=env();assert.throws(()=>e.api.inspectURL('https://example.com/'),/有效 DOI/);e.api.saveSettings({enabled:false});await assert.rejects(e.api.inspectURL(URL_A),/开启/);assert.equal(e.calls.length,0);await e.api.destroy();
});

test('unified input sends normalized DOI or official article URL to the same preview API',async()=>{
  const e=env();
  for(const value of [' DOI: 10.1234/CNKI.Fixture ','https://doi.org/10.1234/CNKI.Fixture','https://link.cnki.net/doi/10.1234/CNKI.Fixture','https://link.oversea.cnki.net/doi/10.1234/CNKI.Fixture','https://www.chndoi.org/Resolution/Handler?doi=10.1234%2FCNKI.Fixture']){
    assert.equal(e.api.normalizeInput(value).kind,'doi');const result=await e.api.inspectURL(value);
    assert.equal(e.calls.at(-1).input,CNKI.normalizeInput(value).url);assert.equal(result.canImport,true);assert.equal(e.saveCount,0);
  }
  await e.api.inspectURL(URL_A);assert.equal(e.calls.at(-1).input,URL_A);assert.equal(e.launches.length,0);
  await e.api.fetchReferences();assert.equal(e.calls.at(-1).opts.includeReferences,true);assert.equal(e.calls.at(-1).input,URL_A);
  await e.api.destroy();
});

test('title search clears stale preview and requires the user to select a website result',async()=>{
  const title='复杂中文题名的生物学机制与分子研究';
  const e=env();await e.api.inspectURL(URL_A);assert.equal(e.api.getSnapshot().canImport,true);
  const before=e.calls.length,snapshot=await e.api.inspectURL(title);
  assert.equal(snapshot.state,'search_required');assert.equal(snapshot.checking,false);assert.equal(snapshot.canImport,false);
  assert.equal(snapshot.record,null);assert.equal(snapshot.metadata,null);assert.equal(snapshot.lastCheckedAt,null);assert.equal(snapshot.references.items.length,0);
  assert.match(snapshot.message,/标题已复制/);assert.match(snapshot.message,/尚未解析或导入/);
  assert.deepEqual(e.copied,[title]);assert.deepEqual(e.launches,[CNKI.searchURL(title)]);assert.equal(e.calls.length,before);assert.equal(e.saveCount,0);
  assert.throws(()=>e.api.importPreview(),/先解析/);await assert.rejects(e.api.fetchReferences(),/先解析/);
  await e.api.destroy();
});

test('title handoff reports clipboard and launch failures accurately without restoring old metadata',async()=>{
  const title='复杂中文题名的生物学机制与分子研究',e=env({copy:async()=>{throw new Error('clipboard unavailable');}});
  const snapshot=await e.api.inspectURL(title);assert.equal(snapshot.state,'search_required');assert.doesNotMatch(snapshot.message,/已复制/);assert.equal(e.launches.length,1);await e.api.destroy();
  const failed=env({launch:async()=>{throw new Error('browser unavailable');}});await failed.api.inspectURL(URL_A);
  await assert.rejects(failed.api.inspectURL(title),/搜索页面未能打开/);assert.equal(failed.api.getSnapshot().state,'error');assert.equal(failed.api.getSnapshot().canImport,false);assert.equal(failed.api.getSnapshot().record,null);await failed.api.destroy();
});

test('reset cancels a pending title handoff before opening the website',async()=>{
  const gate=deferred(),e=env({copy:async()=>gate.promise});
  const pending=e.api.inspectURL('复杂中文题名的生物学机制与分子研究');await new Promise(done=>setImmediate(done));
  assert.equal(e.api.getSnapshot().checking,true);const reset=e.api.resetSession();gate.resolve();
  await assert.rejects(pending,{name:'AbortError'});await reset;assert.equal(e.launches.length,0);assert.equal(e.api.getSnapshot().state,'idle');assert.equal(e.saveCount,0);await e.api.destroy();
});

test('selected DOI-only items can be verified and enriched without a preexisting CNKI URL',async()=>{
  const e=env(),item=await e.add({DOI:data.doi,title:data.title});e.selected.push(item);
  assert.equal((await e.api.verify()).state,'metadata_ready');assert.equal(e.calls.at(-1).input,item);
  assert.equal((await e.api.enrichSelected()).updated,1);assert.equal(item.getField('url'),URL_A);assert.match(item.getField('extra'),/CNKI:/);assert.equal(e.launches.length,0);await e.api.destroy();
});

test('selected official resolver URL-only items are eligible without a separate DOI field',async()=>{
  for(const url of ['https://doi.org/10.1234/cnki.fixture','https://link.cnki.net/doi/10.1234/cnki.fixture','https://link.oversea.cnki.net/doi/10.1234/cnki.fixture','https://www.chndoi.org/Resolution/Handler?doi=10.1234%2Fcnki.fixture']){
    const e=env(),item=await e.add({url,title:data.title});e.selected.push(item);
    assert.equal((await e.api.verify()).state,'metadata_ready');assert.equal(e.calls.at(-1).input,item);
    assert.equal((await e.api.enrichSelected()).updated,1);assert.equal(item.getField('DOI'),data.doi);assert.equal(item.getField('url'),url);assert.match(item.getField('extra'),/CNKI:/);await e.api.destroy();
  }
});

test('thesis university is preserved in preview and fills only empty thesis fields',async()=>{
  const e=env({inspect:async()=>({status:'metadata_only',record,metadata:{...data,itemType:'thesis',university:'测试大学'}})});
  const preview=await e.api.inspectURL(URL_A);assert.equal(preview.metadata.university,'测试大学');
  const imported=await e.api.importPreview(),item=e.items.get(imported.itemID);assert.equal(item.itemType,'thesis');assert.equal(item.getField('university'),'测试大学');
  item.setField('university','用户已保存的学校');assert.equal((await e.api.enrichSelected([item])).updated,0);assert.equal(item.getField('university'),'用户已保存的学校');
  item.setField('university','');assert.equal((await e.api.enrichSelected([item])).updated,1);assert.equal(item.getField('university'),'测试大学');
  const journal=await e.add({url:URL_A,title:data.title});await e.api.enrichSelected([journal]);assert.equal(journal.getField('university'),'');await e.api.destroy();
});

test('download access checks do not imply a required purchase or successful PDF download',async()=>{
  const e=env({inspect:async()=>({status:'access_check_required',record,metadata:data})});const s=await e.api.inspectURL(URL_A);
  assert.equal(s.state,'access_check_required');assert.equal(s.canImport,true);assert.match(s.message,/核验下载权限/);assert.doesNotMatch(s.message,/购买|已下载|已获取/);assert.equal(e.saveCount,0);await e.api.destroy();
});

test('CNKI login grants exact reader resolver and access hosts while retaining scoped reset',async()=>{
  const e=env();await e.api.openLogin();
  for(const host of ['ix.cnki.net','x.cnki.net','link.cnki.net','link.oversea.cnki.net','bar.cnki.net'])assert(e.hosts.includes(host),host);
  assert.equal(e.hosts.some(host=>host.includes('*')||host.includes('chndoi.org')||host.includes('doi.org')),false);
  await e.api.resetSession();assert.deepEqual(e.calls.find(call=>call.reset).reset,['cnki.net','cnki.com.cn']);await e.api.destroy();
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
  const e=env({inspect:async()=>({status:'unknown_future_result',record,metadata:data})});const snapshot=await e.api.inspectURL(URL_A);assert.equal(snapshot.state,'error');assert.equal(snapshot.canImport,false);assert.throws(()=>e.api.importPreview(),/先解析/);await e.api.destroy();
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
