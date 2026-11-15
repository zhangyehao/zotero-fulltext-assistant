const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {parseHTML} = require('linkedom');
const CNKI = require('../src/cnki.js');
const CNKIReferences = require('../src/cnki-references.js');
const source = fs.readFileSync(path.join(__dirname,'../src/publisher.js'),'utf8');
const pdf = () => new TextEncoder().encode('%PDF-1.7\n' + '0'.repeat(1200) + '\n%%EOF\n');
const html = body => '<!doctype html><html><head></head><body>' + body + '</body></html>';

function setup({url='https://publisher.test/article/one',doi='',title='',extra='',pages={},rendered={},oa=[],sources,pdfIdentity,sourceSettings={},cnki,cnkiReferences,cnkiSettings={enabled:true},blockingObserver=true}={}) {
  const files=new Map(),attachments=[],requests=[],imports=[],progress=[],hidden=[],blockers=[];
  let nextID=100,tempID=0,renderedOnce=false,active=0,maxActive=0;
  const item={id:1,libraryID:1,isRegularItem:()=>true,getField(name){return {url,DOI:doi,title,extra}[name]||'';},getAttachments(){return attachments.map(value=>value.id);}};
  const IOUtils={async exists(file){return files.has(file);},async stat(file){if(!files.has(file))throw new Error('Missing fixture file');return {type:'regular',size:files.get(file).length,lastModified:1};},async read(file,{offset=0,maxBytes}={}){if(!files.has(file))throw new Error('Missing fixture file');return files.get(file).slice(offset,maxBytes===undefined?undefined:offset+maxBytes);},async write(file,bytes){files.set(file,bytes);},async remove(file){files.delete(file);}};
  const Zotero={Promise:{delay(ms){return new Promise(resolve=>setTimeout(resolve,Math.min(ms,5)));}},Items:{async getAsync(id){return attachments.find(value=>value.id===id);}},HTTP:{async request(method,address,options){
    requests.push({method,url:address,options});active++;maxActive=Math.max(maxActive,active);
    try {
      if(!(address in pages))throw new Error('fixture missing route');
      let value=pages[address];if(typeof value==='function')value=await value({renderedOnce,options});
      if(typeof value==='string')value={body:value};
      const bytes=value.bytes||new TextEncoder().encode(value.body||'');
      return {status:value.status??200,response:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),responseURL:value.url||address,getResponseHeader(name){if(value.getResponseHeader)return value.getResponseHeader(name);return name==='Content-Type'?(value.type||'text/html; charset=utf-8'):(value.headers?.[name]||null);}};
    } finally {active--;}
  }},Attachments:{async createTemporaryStorageDirectory(){return {path:'/tmp/publisher-'+(++tempID)};},async importFromFile(options){imports.push(options);assert.equal(options.parentItemID,1);assert.equal(options.libraryID,1);assert.equal(options.contentType,'application/pdf');assert(files.has(options.file));const attachment={id:++nextID,attachmentContentType:'application/pdf',async getFilePathAsync(){return '/storage/'+this.id+'.pdf';},setField(){},async saveTx(){}};files.set('/storage/'+attachment.id+'.pdf',files.get(options.file));attachments.push(attachment);return attachment;},getFileResolvers(_item,methods){assert.deepEqual(Array.from(methods),['oa']);return [async()=>oa];}}};
  class HiddenBrowser {
    constructor(options){this.options=options;this.destroyed=false;this._createdPromise=Promise.resolve();hidden.push(this);}
    async load(address){if(CNKI.isCNKIURL(address))assert(blockers.some(value=>value.browser===this));renderedOnce=true;this.currentURI={spec:address};return true;}
    async getPageData(props){assert.deepEqual(Array.from(props),['documentHTML']);return {documentHTML:rendered[this.currentURI.spec]||html('No file')};}
    destroy(){this.destroyed=true;}
  }
  class BlockingObserver {
    constructor(options){this.options=options;this.disposed=false;blockers.push(this);}
    register(browser){this.browser=browser;}
    dispose(){this.disposed=true;}
  }
  const scope={URL,Promise,Date,JSON,Set,Map,Uint8Array,ArrayBuffer,TextDecoder,TextEncoder};
  vm.runInNewContext(source,scope);
  const publisher=scope.FulltextPublisher.create({Zotero,Services:{},IOUtils,PathUtils:path.posix,parseHTML,HiddenBrowser,BlockingObserver:blockingObserver?BlockingObserver:undefined,sources,pdfIdentity,cnki,cnkiReferences,getCNKISettings:()=>cnkiSettings,getSourceSettings:()=>sourceSettings});
  return {publisher,api:scope.FulltextPublisher,item,Zotero,IOUtils,files,attachments,requests,imports,hidden,blockers,progress,onProgress:info=>progress.push(info),maxActive:()=>maxActive};
}

const cnkiURL='https://kns.cnki.net/KCMS/detail/detail.aspx?dbcode=CJFD&filename=TEST202401001';
const cnkiTitle='合成知网文章的完整题名';
const cnkiPDF='https://download.cnki.net/current?opaque=transient-signed-value';
const cnkiMarkup=(body='')=>html('<h1>'+cnkiTitle+'</h1>'+body);
const cnkiAnchor='<a name="pdfDown" href="'+cnkiPDF+'">PDF下载</a>';
const cnkiSetup=options=>setup({url:cnkiURL,title:cnkiTitle,cnki:CNKI,...options});

test('CNKI DOI-less PDF retains its unique record, shared identity check, and only a stable source URL',async()=>{
 let identityTarget;
 const env=cnkiSetup({pages:{[cnkiURL]:cnkiMarkup(cnkiAnchor),[cnkiPDF]:{bytes:pdf(),type:'application/pdf'}},pdfIdentity:{async inspect(_file,target){identityTarget=target;return {status:'match'};}}});
 const result=await env.publisher.acquire(env.item,{onProgress:env.onProgress});
 assert.equal(result.source,'cnki');assert.equal(result.discoveryProvider,'cnki');assert.equal(result.pdfHost,'download.cnki.net');assert.equal(result.sourceURL,cnkiURL);
 assert.equal(result.cnkiRecord.id,'CNKI:CJFD:TEST202401001');assert.equal(result.metadata.title,cnkiTitle);assert.equal(result.fulltextVersion,'unknown');assert.equal(identityTarget.doi,'');assert.equal(identityTarget.cnkiRecord.id,result.cnkiRecord.id);
 assert.equal(env.imports.length,1);assert.equal(JSON.stringify(result).includes('transient-signed-value'),false);assert.equal(JSON.stringify(env.progress).includes('transient-signed-value'),false);
 assert(env.requests.every(row=>row.options.followRedirects===false&&!('userContextId' in row.options)&&!row.options.anon&&!row.options.headers.Cookie&&!row.options.headers.Authorization));
});
test('CNKI unknown PDF identity keeps one hash-bound review path instead of importing',async()=>{
 const env=cnkiSetup({pages:{[cnkiURL]:cnkiMarkup(cnkiAnchor),[cnkiPDF]:{bytes:pdf(),type:'application/pdf'}},pdfIdentity:{async inspect(){return {status:'unknown'};}}});
 const result=await env.publisher.acquire(env.item);
 assert.equal(result.needsReview,true);assert.equal(result.paper.cnkiRecord.id,'CNKI:CJFD:TEST202401001');assert.equal(result.sourceURL,cnkiURL);assert.equal(result.pdfHost,'download.cnki.net');assert.equal(env.imports.length,0);
});
test('CNKI opaque URL review binds the original item while retaining the discovered hidden record as provenance',async()=>{
 const opaque='https://kns.cnki.net/kcms2/article/abstract?v=temporary-article-token';
 const markup=cnkiMarkup('<input id="hiddbcode" value="CJFD"><input id="hidfilename" value="TEST202401001">'+cnkiAnchor);
 const env=cnkiSetup({url:opaque,pages:{[opaque]:markup,[cnkiPDF]:{bytes:pdf(),type:'application/pdf'}},pdfIdentity:{async inspect(){return {status:'unknown'};}}});
 const result=await env.publisher.acquire(env.item);assert.equal(result.needsReview,true);assert.equal(result.paper.doi,'');assert.equal(result.paper.cnkiRecord,null);assert.equal(result.cnkiRecord.id,'CNKI:CJFD:TEST202401001');assert.equal(result.sourceURL,cnkiURL);assert.equal(env.imports.length,0);assert.equal(JSON.stringify(result).includes('temporary-article-token'),false);
});
test('CNKI opaque URL changes during unknown PDF inspection cancel before returning a review candidate',async()=>{
 const opaque='https://kns.cnki.net/kcms2/article/abstract?v=temporary-article-token';
 const markup=cnkiMarkup('<input id="hiddbcode" value="CJFD"><input id="hidfilename" value="TEST202401001">'+cnkiAnchor);
 let env;
 env=cnkiSetup({url:opaque,pages:{[opaque]:markup,[cnkiPDF]:{bytes:pdf(),type:'application/pdf'}},pdfIdentity:{async inspect(){const previous=env.item.getField;env.item.getField=name=>name==='url'?opaque.replace('temporary-article-token','different-article-token'):previous(name);return {status:'unknown'};}}});
 await assert.rejects(env.publisher.acquire(env.item),{name:'AbortError'});assert.equal(env.imports.length,0);
});
test('CNKI cannot silently import when the PDF identity service is unavailable',async()=>{
 const env=cnkiSetup({pages:{[cnkiURL]:cnkiMarkup(cnkiAnchor),[cnkiPDF]:{bytes:pdf(),type:'application/pdf'}}});
 const result=await env.publisher.acquire(env.item);assert.equal(result.needsReview,true);assert.equal(env.imports.length,0);
});
test('CNKI wrong-paper PDF is rejected and another ordinary source can still succeed',async()=>{
 const oaURL='https://repository.test/verified.pdf';
 const env=cnkiSetup({doi:'10.1234/paper',pages:{[cnkiURL]:cnkiMarkup(cnkiAnchor),[cnkiPDF]:{bytes:pdf(),type:'application/pdf'},[oaURL]:{bytes:pdf(),type:'application/pdf'}},oa:[{url:oaURL}],pdfIdentity:{calls:0,async inspect(){return {status:++this.calls===1?'mismatch':'match'};}}});
 const result=await env.publisher.acquire(env.item);assert.equal(result.source,'open_access');assert.equal(env.imports.length,1);assert.equal(result.cnkiRecord.id,'CNKI:CJFD:TEST202401001');assert.equal(env.requests[0].url,cnkiURL);
});
test('CNKI CAJ and purchase-only pages stay separate and never invoke their endpoints',async()=>{
 for(const [body,status] of [['<a name="cajDown" href="https://download.cnki.net/full.caj">CAJ下载</a>','caj_only'],['<a id="ty_pdf" href="https://pay.cnki.net/zscsdoc/download?dtype=pdf">PDF下载</a>','purchase_required']]){
  const env=cnkiSetup({pages:{[cnkiURL]:cnkiMarkup(body)}});const result=await env.publisher.acquire(env.item);
  assert.equal(result.cnkiStatus,status);assert.equal(env.requests.length,1);assert.equal(env.hidden.length,0);assert.equal(env.imports.length,0);
 }
});
test('CNKI metadata probe is read-only, follows explicit same-site redirects, and stops before login',async()=>{
 const opaque='https://kns.cnki.net/kcms2/article/abstract?v=transient';
 const env=cnkiSetup({pages:{[cnkiURL]:{status:302,headers:{Location:opaque}},[opaque]:cnkiMarkup('<input id="hiddbcode" value="CJFD"><input id="hidfilename" value="TEST202401001">'+cnkiAnchor)}});
 const inspected=await env.publisher.inspectCNKI(env.item);assert.equal(inspected.status,'pdf_available');assert.equal(inspected.articleURL,cnkiURL);assert.equal(env.imports.length,0);assert.equal(env.requests.length,2);
 const login=cnkiSetup({pages:{[cnkiURL]:{status:302,headers:{Location:'https://login.cnki.net/login/?returnUrl=private'}}}});
 const result=await login.publisher.inspectCNKI(login.item);assert.equal(result.status,'login_required');assert.equal(login.requests.length,1);assert.equal(login.hidden.length,0);
});
test('CNKI native missing redirect headers do not throw and purchase/offsite redirects are never fetched',async()=>{
 for(const [destination,status] of [['https://pay.cnki.net/order?id=private','purchase_required'],['https://attacker.example/file.pdf','unsafe_redirect']]){
  const env=cnkiSetup({pages:{[cnkiURL]:cnkiMarkup(cnkiAnchor),[cnkiPDF]:{status:302,getResponseHeader(name){if(name==='Location')return destination;throw new Error('NS_ERROR_NOT_AVAILABLE');}}}});
  const result=await env.publisher.acquire(env.item);assert.equal(result.cnkiStatus,status);assert.equal(env.requests.length,2);assert.equal(env.imports.length,0);assert.equal(JSON.stringify(result).includes('private'),false);
 }
});
test('CNKI unexpected transparent redirect is rejected before accepting any PDF bytes',async()=>{
 const env=cnkiSetup({pages:{[cnkiURL]:cnkiMarkup(cnkiAnchor),[cnkiPDF]:{url:'https://attacker.example/other.pdf',bytes:pdf(),type:'application/pdf'}},pdfIdentity:{async inspect(){throw new Error('must not inspect');}}});
 const result=await env.publisher.acquire(env.item);assert.equal(result.cnkiStatus,'unsafe_redirect');assert.equal(env.imports.length,0);
});
test('CNKI download HTML login/captcha and genuine CAJ bytes are never imported as PDF',async()=>{
 for(const [response,status] of [[{body:html('<p>请先登录</p>'),type:'text/html'},'login_required'],[{body:html('<p>请输入验证码</p>'),type:'text/html'},'human_verification'],[{bytes:new TextEncoder().encode('CAJ\0binary'),type:'application/caj'},'caj_only']]){
  const env=cnkiSetup({pages:{[cnkiURL]:cnkiMarkup(cnkiAnchor),[cnkiPDF]:response}});const result=await env.publisher.acquire(env.item);assert.equal(result.cnkiStatus,status);assert.equal(env.imports.length,0);
 }
});
test('CNKI switch off suppresses direct pages without disabling other sources',async()=>{
 const oaURL='https://repository.test/paper.pdf';
 const env=cnkiSetup({doi:'10.1234/one',cnkiSettings:{enabled:false},pages:{[oaURL]:{bytes:pdf(),type:'application/pdf'}},oa:[{url:oaURL}]});
 assert.equal((await env.publisher.inspectCNKI(env.item)).status,'disabled');
 const result=await env.publisher.acquire(env.item);assert.equal(result.source,'open_access');assert.deepEqual(env.requests.map(row=>row.url),[oaURL]);
});
test('CNKI item identity edits and disabling the source during identity inspection prevent import',async()=>{
 for(const change of ['record','setting']){
  const config={enabled:true};let env;
  env=cnkiSetup({cnkiSettings:config,pages:{[cnkiURL]:cnkiMarkup(cnkiAnchor),[cnkiPDF]:{bytes:pdf(),type:'application/pdf'}},pdfIdentity:{async inspect(){if(change==='record'){const previous=env.item.getField;env.item.getField=name=>name==='url'?cnkiURL.replace('TEST202401001','OTHER'):previous(name);}else config.enabled=false;return {status:'match'};}}});
  await assert.rejects(env.publisher.acquire(env.item),{name:'AbortError'});assert.equal(env.imports.length,0);
 }
});
test('CNKI metadata probe can render an ungated detail page and always destroys the browser',async()=>{
 const env=cnkiSetup({pages:{[cnkiURL]:html('<div id="app"></div>')},rendered:{[cnkiURL]:cnkiMarkup(cnkiAnchor)}});
 const result=await env.publisher.inspectCNKI(env.item);assert.equal(result.status,'pdf_available');assert.equal(env.hidden.length,1);assert.equal(env.hidden[0].destroyed,true);assert.equal(env.imports.length,0);
 assert.equal(env.blockers[0].disposed,true);
 const block=url=>env.blockers[0].options.shouldBlock({spec:url});
 for(const address of ['https://pay.cnki.net/order','https://login.cnki.net/login','https://external.test/app.js','https://download.cnki.net/download/file','https://www.cnki.com.cn/cnkispace/cjfd/references/ref.html?fileName=0123456789ABCDEF'])assert.equal(block(address),true);
 assert.equal(block('https://kns.cnki.net/static/app.js'),false);assert.equal(block(cnkiURL),false);
});
test('CNKI rendering is skipped if its native request guard cannot be loaded',async()=>{
 const env=cnkiSetup({blockingObserver:false,pages:{[cnkiURL]:cnkiMarkup()},rendered:{[cnkiURL]:cnkiMarkup(cnkiAnchor)}});
 const result=await env.publisher.inspectCNKI(env.item);assert.equal(result.status,'metadata_only');assert.equal(env.hidden[0].currentURI,undefined);assert.equal(env.hidden[0].destroyed,true);
});
test('CNKI download redirects cannot switch an explicit document identifier',async()=>{
 const wrong='https://download.cnki.net/file?filename=OTHER';
 const env=cnkiSetup({pages:{[cnkiURL]:cnkiMarkup(cnkiAnchor),[cnkiPDF]:{status:302,headers:{Location:wrong}},[wrong]:{bytes:pdf(),type:'application/pdf'}}});
 const result=await env.publisher.acquire(env.item);assert.equal(result.cnkiStatus,'article_mismatch');assert.equal(env.imports.length,0);assert.equal(env.requests.length,2);
});
test('CNKI metadata refuses conflicting item bindings without a request and notices edits during a request',async()=>{
 const bad=cnkiSetup({extra:'CNKI: CNKI:CJFD:OTHER'});
 assert.equal((await bad.publisher.inspectCNKI(bad.item)).status,'article_mismatch');assert.equal(bad.requests.length,0);
 let env;
 env=cnkiSetup({pages:{[cnkiURL]:()=>{const prior=env.item.getField;env.item.getField=name=>name==='title'?'Changed title':prior(name);return cnkiMarkup(cnkiAnchor);}}});
 await assert.rejects(env.publisher.inspectCNKI(env.item),{name:'AbortError'});assert.equal(env.imports.length,0);
});
test('CNKI cancellation aborts its active HTTP request before any render or import',async()=>{
 let cancelled=false,cancelCalled=false,release;
 const env=cnkiSetup({pages:{[cnkiURL]:({options})=>new Promise(resolve=>{release=()=>resolve(cnkiMarkup(cnkiAnchor));options.cancellerReceiver(()=>{cancelCalled=true;release();});})}});
 const operation=env.publisher.inspectCNKI(env.item,{isCancelled:()=>cancelled});
 await new Promise(resolve=>setTimeout(resolve,10));cancelled=true;
 await assert.rejects(operation,{name:'AbortError'});assert.equal(cancelCalled,true);assert.equal(env.hidden.length,0);assert.equal(env.imports.length,0);
});
test('CNKI visible challenge is cached until explicit retry clears the site gate',async()=>{
 let challenge=true;
 const env=cnkiSetup({pages:{[cnkiURL]:()=>challenge?cnkiMarkup('<p>请输入验证码</p>'):cnkiMarkup(cnkiAnchor)}});
 assert.equal((await env.publisher.inspectCNKI(env.item)).status,'human_verification');challenge=false;
 assert.equal((await env.publisher.inspectCNKI(env.item)).status,'human_verification');assert.equal(env.requests.length,1);
 env.publisher.clearAccessGate(cnkiURL);assert.equal((await env.publisher.inspectCNKI(env.item)).status,'pdf_available');assert.equal(env.requests.length,2);
});
const cnkiPublicURL='https://www.cnki.com.cn/Article/CJFDTOTAL-TEST202401001.htm';
const cnkiRefsURL='https://www.cnki.com.cn/cnkispace/cjfd/references/ref.html?fileName=0123456789ABCDEF';
const cnkiRefDeclaration='<script>$.get("/cnkispace/cjfd/references/ref.html",{fileName:"0123456789ABCDEF"},function(data){data.refarticles.references;});</script>';
const cnkiReferenceList={error:200,refarticles:{references:{cjfdList:[{articleName:'另一篇明确的参考文献题名',author:'张三;李四',year:'2022',fileName:'REF202201001'}]}}};
test('CNKI ordinary metadata inspection parses page-declared references without requesting their endpoint',async()=>{
 const env=cnkiSetup({url:cnkiPublicURL,cnkiReferences:CNKIReferences,pages:{[cnkiPublicURL]:cnkiMarkup(cnkiAnchor+cnkiRefDeclaration)}});
 const result=await env.publisher.inspectCNKI(env.item);assert.equal(result.status,'pdf_available');assert.equal(result.references.status,'page_declared');assert.deepEqual(env.requests.map(row=>row.url),[cnkiPublicURL]);
});
test('CNKI requested references follow only one page-declared GET and retain partial provenance',async()=>{
 const env=cnkiSetup({url:cnkiPublicURL,cnkiReferences:CNKIReferences,pages:{[cnkiPublicURL]:cnkiMarkup(cnkiAnchor+cnkiRefDeclaration),[cnkiRefsURL]:{type:'application/json',body:JSON.stringify(cnkiReferenceList)}}});
 const result=await env.publisher.inspectCNKI(env.item,{includeReferences:true});
 assert.equal(result.status,'pdf_available');assert.equal(result.references.visibleCount,1);assert.equal(result.references.complete,false);assert.equal(result.references.totalCount,null);assert.equal(result.references.references[0].title,'另一篇明确的参考文献题名');assert.equal(result.references.references[0].record.id,'CNKI:CJFD:REF202201001');
 assert.deepEqual(env.requests.map(row=>row.url),[cnkiPublicURL,cnkiRefsURL]);assert.equal(env.imports.length,0);assert.equal(env.hidden.length,0);
});
test('CNKI degraded reference response does not claim an empty or complete bibliography or repeat its request',async()=>{
 const markup=cnkiMarkup(cnkiRefDeclaration);
 const env=cnkiSetup({url:cnkiPublicURL,cnkiReferences:CNKIReferences,pages:{[cnkiPublicURL]:markup,[cnkiRefsURL]:{type:'application/json',body:JSON.stringify({error:200,msg:'检索降级',refarticles:null})}},rendered:{[cnkiPublicURL]:markup}});
 const result=await env.publisher.inspectCNKI(env.item,{includeReferences:true});assert.equal(result.references.totalCount,null);assert.equal(result.references.complete,false);assert.notEqual(result.references.status,'empty');assert(result.references.diagnostics.some(row=>row.code==='service_degraded'));assert.equal(env.requests.filter(row=>row.url===cnkiRefsURL).length,1);
});
test('CNKI references reject offsite redirects and wrong article pages without importing or following',async()=>{
 const env=cnkiSetup({url:cnkiPublicURL,cnkiReferences:CNKIReferences,pages:{[cnkiPublicURL]:cnkiMarkup(cnkiAnchor+cnkiRefDeclaration),[cnkiRefsURL]:{status:302,headers:{Location:'https://external.test/references'}}}});
 const result=await env.publisher.inspectCNKI(env.item,{includeReferences:true});assert.equal(result.status,'pdf_available');assert(result.references.diagnostics.some(row=>row.code==='unsafe_redirect'));assert.equal(env.requests.length,2);
 const mismatch=cnkiSetup({url:cnkiPublicURL,title:'Different title',cnkiReferences:CNKIReferences,pages:{[cnkiPublicURL]:cnkiMarkup(cnkiAnchor+cnkiRefDeclaration)}});
 const wrong=await mismatch.publisher.inspectCNKI(mismatch.item,{includeReferences:true});assert.equal(wrong.status,'article_mismatch');assert.equal(wrong.references,undefined);assert.equal(mismatch.requests.length,1);
});
test('CNKI reference-only login gates retain public rows and do not turn the main article into a login page',async()=>{
 const refs='<section id="references"><ol><li><span class="reference-title">可公开读取的引用题名</span></li></ol><p>请先登录后查看其他参考文献</p></section>';
 const env=cnkiSetup({url:cnkiPublicURL,cnkiReferences:CNKIReferences,pages:{[cnkiPublicURL]:cnkiMarkup(cnkiAnchor+refs+cnkiRefDeclaration)}});
 const result=await env.publisher.inspectCNKI(env.item,{includeReferences:true});assert.equal(result.status,'pdf_available');assert.equal(result.references.status,'login_required');assert.equal(result.references.visibleCount,1);assert.equal(env.requests.length,1);
});
test('CNKI reference JSON endpoint returning HTML verification preserves the gate without a retry',async()=>{
 const env=cnkiSetup({url:cnkiPublicURL,cnkiReferences:CNKIReferences,pages:{[cnkiPublicURL]:cnkiMarkup(cnkiAnchor+cnkiRefDeclaration),[cnkiRefsURL]:html('<h1>安全验证</h1><p>请输入验证码</p>')}});
 const result=await env.publisher.inspectCNKI(env.item,{includeReferences:true});assert.equal(result.status,'pdf_available');assert.equal(result.references.status,'human_verification');assert.equal(result.references.totalCount,null);assert.equal(env.requests.length,2);assert.equal(env.hidden.length,0);
});
test('CNKI no-URL metadata probe supplies search handoff without network or guessed first result',async()=>{
 const env=cnkiSetup({url:''});const result=await env.publisher.inspectCNKI(env.item);assert.equal(result.status,'needs_url');assert.equal(result.searchURL,CNKI.searchURL(cnkiTitle));assert.equal(env.requests.length,0);assert.equal(result.record,null);
});
test('a DOI redirect to CNKI uses the CNKI parser instead of generic purchase discovery',async()=>{
 const start='https://doi.org/10.1234/one';
 const env=setup({url:'',doi:'10.1234/one',title:cnkiTitle,cnki:CNKI,pages:{[start]:{status:302,headers:{Location:cnkiURL}},[cnkiURL]:cnkiMarkup('<a id="ty_pdf" href="https://pay.cnki.net/order">PDF下载</a>')}});
 const result=await env.publisher.acquire(env.item);assert.equal(result.cnkiStatus,'purchase_required');assert.deepEqual(env.requests.map(row=>row.url),[start,cnkiURL]);assert.equal(env.imports.length,0);
});
test('an external API download redirect cannot fetch a CNKI payment endpoint',async()=>{
 const address='https://repository.test/fulltext',sources=sourceFixture([{url:address,source:'openalex',kind:'pdf'}]);
 const env=setup({doi:'10.1234/one',sources,cnki:CNKI,sourceSettings:{enabled:{publisher:false}},pages:{[address]:{status:302,headers:{Location:'https://pay.cnki.net/order'}}}});
 const result=await env.publisher.acquire(env.item);assert.equal(result.state,'not_found');assert.deepEqual(env.requests.map(row=>row.url),[address]);assert.equal(env.imports.length,0);
});

test('HTTP citation_pdf_url yields a verified PDF attached to the original item',async()=>{
  const env=setup({pages:{'https://publisher.test/article/one':html('<meta name="citation_pdf_url" content="/files/one.pdf">'),'https://publisher.test/files/one.pdf':{bytes:pdf(),type:'application/pdf'}}});
  const result=await env.publisher.acquire(env.item,{onProgress:env.onProgress});
  assert.equal(result.source,'publisher');assert.equal(result.sourceURL,'https://publisher.test/files/one.pdf');assert.equal(env.imports.length,1);assert.equal(env.hidden.length,0);
  assert.equal(result.discoveryProvider,'publisher');assert.equal(result.pdfHost,'publisher.test');
  assert(env.requests.every(value=>!('userContextId' in value.options)));
  assert.equal(env.requests[1].options.headers.Referer,'https://publisher.test/article/one');
  assert.equal([...env.files.keys()].some(value=>value.startsWith('/tmp/')),false);
});

test('JS-rendered download anchor succeeds when the initial HTTP DOM has no PDF',async()=>{
  const env=setup({pages:{'https://publisher.test/article/one':html('<div id="app"></div>'),'https://publisher.test/secure-download?id=one':{bytes:pdf(),type:'application/octet-stream'}},rendered:{'https://publisher.test/article/one':html('<a href="/secure-download?id=one">Download PDF</a>')}});
  const result=await env.publisher.acquire(env.item,{onProgress:env.onProgress});
  assert.equal(result.source,'rendered_publisher');assert.equal(env.imports.length,1);
  assert.equal(result.discoveryProvider,'publisher');assert.equal(result.pdfHost,'publisher.test');
  assert.equal(env.hidden[0].options.allowJavaScript,true);assert.equal('userContextId' in env.hidden[0].options,false);assert.equal(env.hidden[0].destroyed,true);
  assert(env.progress.some(value=>value.stage==='rendering'));
});

test('a publisher URL rejected before JS cookie initialization is retried after rendering',async()=>{
  const markup=html('<a href="/download.pdf">Download PDF</a>');
  const env=setup({pages:{'https://publisher.test/article/one':markup,'https://publisher.test/download.pdf':({renderedOnce})=>renderedOnce?{bytes:pdf(),type:'application/pdf'}:{status:403,body:html('Access through your institution')}},rendered:{'https://publisher.test/article/one':markup}});
  const result=await env.publisher.acquire(env.item);
  assert.equal(result.source,'rendered_publisher');assert.equal(env.requests.filter(value=>value.url.endsWith('/download.pdf')).length,2);assert.equal(env.imports.length,1);
});

test('OA resolver succeeds before any publisher webpage or challenge is requested',async()=>{
  const env=setup({doi:'10.1234/one',pages:{'https://publisher.test/article/one':html('<a href="/bad.pdf">PDF</a>'),'https://publisher.test/bad.pdf':{body:html('Sign in to download'),type:'application/pdf'},'https://doi.org/10.1234/one':html('Paywall'),'https://repository.test/one.pdf':{bytes:pdf(),type:'application/pdf'}},oa:[{url:'https://repository.test/one.pdf'}]});
  const result=await env.publisher.acquire(env.item);
  assert.equal(result.source,'open_access');assert.equal(env.imports.length,1);assert.equal(result.sourceURL,'https://repository.test/one.pdf');
  assert.equal(result.discoveryProvider,'open_access');assert.equal(result.pdfHost,'repository.test');
  assert.deepEqual(env.requests.map(value=>value.url),['https://repository.test/one.pdf']);assert.equal(env.hidden.length,0);
});

test('existing local PDF skips requests and concurrent acquisition calls coalesce',async()=>{
  const env=setup({pages:{'https://publisher.test/article/one':{bytes:pdf(),type:'application/pdf'}}});
  const one=env.publisher.acquire(env.item),two=env.publisher.acquire(env.item);assert.equal(one,two);
  await one;assert.equal(env.imports.length,1);
  assert(env.maxActive()<=2);
  const requests=env.requests.length;
  const existing=await env.publisher.acquire(env.item);assert.equal(existing.source,'existing');assert.equal(env.requests.length,requests);
});

test('a PDF attached while the download is in flight is not imported twice',async()=>{
  const env=setup({pages:{'https://publisher.test/article/one':{bytes:pdf(),type:'application/pdf'}}});
  const write=env.IOUtils.write;
  env.IOUtils.write=async(file,bytes)=>{await write(file,bytes);env.files.set('/storage/external.pdf',pdf());env.attachments.push({id:999,attachmentContentType:'application/pdf',async getFilePathAsync(){return '/storage/external.pdf';}});};
  const result=await env.publisher.acquire(env.item);assert.equal(result.attachmentID,999);assert.equal(result.source,'existing');assert.equal(env.imports.length,0);
});

test('the shared local PDF check includes linked files and scans past missing or malformed candidates',async()=>{
  const env=setup();
  env.attachments.push(
    {id:1,attachmentContentType:'application/pdf',async getFilePathAsync(){return '/missing.pdf';}},
    {id:2,attachmentContentType:'application/pdf',async getFilePathAsync(){return '/html.pdf';}},
    {id:3,attachmentContentType:'application/pdf',attachmentLinkMode:3,async getFilePathAsync(){throw new Error('linked URL must not be accessed');}},
    {id:4,attachmentContentType:'application/pdf',deleted:true,async getFilePathAsync(){return '/good.pdf';}},
    {id:5,attachmentContentType:'application/pdf',attachmentLinkMode:2,isFileAttachment:()=>true,async getFilePathAsync(){return '/good.pdf';}}
  );
  env.files.set('/html.pdf',new TextEncoder().encode(html('0'.repeat(1500))));env.files.set('/good.pdf',pdf());
  assert.equal(await env.api.findExistingPDF(env.item,env),5);
  const result=await env.publisher.acquire(env.item);assert.equal(result.attachmentID,5);assert.equal(env.requests.length,0);
});

test('existing local PDFs use bounded reads without the download size cap',async()=>{
  const env=setup(),size=120*1024*1024,reads=[];
  env.attachments.push({id:8,attachmentFilename:'large.PDF',async getFilePathAsync(){return '/large.pdf';}});
  env.IOUtils.stat=async()=>({type:'regular',size,lastModified:1});
  env.IOUtils.read=async(file,options)=>{reads.push(options);return new TextEncoder().encode(options.offset?'\n%%EOF\n':'%PDF-1.7\n');};
  assert.equal(await env.api.findExistingPDF(env.item,env),8);
  assert.deepEqual(reads.map(o=>({offset:o.offset||0,maxBytes:o.maxBytes})),[{offset:0,maxBytes:32},{offset:size-8192,maxBytes:8192}]);
});

test('local PDF detection rejects directories, wrong parents, absent EOF and files changing during inspection',async()=>{
  for(const mode of ['directory','wrong-parent','truncated','changed']){
    const env=setup();env.attachments.push({id:8,parentID:mode==='wrong-parent'?9:1,attachmentContentType:'application/pdf',async getFilePathAsync(){return '/existing.pdf';}});
    env.files.set('/existing.pdf',mode==='truncated'?pdf().slice(0,-10):pdf());
    let stats=0;const stat=env.IOUtils.stat;
    env.IOUtils.stat=async file=>({...await stat(file),type:mode==='directory'?'directory':'regular',lastModified:mode==='changed'?++stats:1});
    assert.equal(await env.api.findExistingPDF(env.item,env),null,mode);
  }
});

test('cancellation aborts a pending HTTP request and never imports its eventual response',async()=>{
  let cancelled=false,aborted=false,finish;
  const env=setup({pages:{'https://publisher.test/article/one':({options})=>new Promise(resolve=>{finish=resolve;options.cancellerReceiver(()=>{aborted=true;});})}});
  const operation=env.publisher.acquire(env.item,{isCancelled:()=>cancelled});
  await new Promise(resolve=>setTimeout(resolve,10));cancelled=true;
  await assert.rejects(operation,error=>error.name==='AbortError');assert.equal(aborted,true);assert.equal(env.imports.length,0);
  finish({bytes:pdf(),type:'application/pdf'});
});

test('unavailable pages report fallback status without inventing download URLs',async()=>{
  const env=setup({pages:{'https://publisher.test/article/one':html('Article without download')}});
  const result=await env.publisher.acquire(env.item);assert.equal(result.state,'not_found');assert.equal(env.imports.length,0);
  assert.deepEqual(env.requests.map(value=>value.url),['https://publisher.test/article/one']);
  assert.equal(result.accessReason,'automatic_not_found');assert.equal(result.accessEvidence.kind,'automatic_not_found');assert.equal(result.accessEvidence.confidence,'unknown');
  assert.match(result.message,/不能判断你是否拥有机构访问权限/);assert.match(result.message,/浏览器下载并自动入库/);
  const login=setup({pages:{'https://publisher.test/article/one':html('<form><input type="password"></form>')},rendered:{'https://publisher.test/article/one':html('<form><input type="password"></form>')}});
  assert.equal((await login.publisher.acquire(login.item)).state,'needs_login');
});

// Synthetic access markup based on Elsevier's documented article controls;
// it is not a captured authenticated page for the article below.
// https://www.elsevier.support/sciencedirect/answer/how-do-i-get-access-to-sciencedirect-from-anywhere
// https://www.elsevier.support/sciencedirect/answer/how-do-i-buy-an-article-or-chapter
const scienceDirectArticle='https://www.sciencedirect.com/science/article/pii/S002839081400478X';
const scienceDirectDOI='10.1016/j.neuropharm.2014.12.027';
const scienceDirectTitle='Social feeding in Caenorhabditis elegans is modulated by antipsychotic drugs and calmodulin and may serve as a protophenotype for asociality';
const scienceDirectPage=controls=>html('<meta name="citation_doi" content="'+scienceDirectDOI+'"><main><h1>'+scienceDirectTitle+'</h1>'+controls+'<h2>Abstract</h2><p>Article abstract.</p></main>');

test('ScienceDirect institutional access labels are recognized without treating personal sign-in as subscription access',()=>{
  const env=setup();
  for(const label of ['Access through your organization','Check access through your organisation','Sign in via your organization','Sign in to your organization','Access through your institution','Institutional login']){
    const found=env.api.discover(parseHTML(scienceDirectPage('<button>'+label+'</button>')).document,scienceDirectArticle,scienceDirectDOI);
    assert.equal(found.needsLogin,true,label);assert.equal(found.accessReason,'institutional_access',label);assert.equal(found.candidates.length,0);
    assert.equal(found.accessEvidence.kind,'institutional_entry');assert.equal(found.accessEvidence.confidence,'explicit');assert.equal(found.accessEvidence.institutionalConfirmed,undefined);
  }
  const ordinary=env.api.discover(parseHTML(scienceDirectPage('<button>Sign in</button><a href="/register">Create account</a>')).document,scienceDirectArticle,scienceDirectDOI);
  assert.equal(ordinary.needsLogin,false);assert.equal(ordinary.accessReason,null);
});

test('possible access controls and generic login are distinct from explicit institutional entries',()=>{
  const env=setup();
  for(const markup of ['<button>Check access</button>','<button>Get access</button>','<p>Access through your institution</p>']){
    const found=env.api.discover(parseHTML(scienceDirectPage(markup)).document,scienceDirectArticle,scienceDirectDOI);
    assert.equal(found.accessReason,'institutional_hint');assert.equal(found.accessEvidence.kind,'institutional_hint');assert.equal(found.accessEvidence.confidence,'possible');
  }
  const login=env.api.discover(parseHTML(scienceDirectPage('<form><input type="password"></form>')).document,scienceDirectArticle,scienceDirectDOI);
  assert.equal(login.accessReason,'login_possible');assert.equal(login.accessEvidence.kind,'login_hint');assert.equal(login.accessEvidence.confidence,'possible');
  const link=env.api.discover(parseHTML(scienceDirectPage('<a href="https://www.sciencedirect.com/user/institution/login">Check access</a>')).document,scienceDirectArticle,scienceDirectDOI);
  assert.equal(link.accessReason,'institutional_access');assert.equal(link.accessEvidence.kind,'institutional_entry');
});

test('HTTP request restrictions do not assert an institutional login or entitlement',async()=>{
  const env=setup({url:scienceDirectArticle,pages:{[scienceDirectArticle]:{status:403,body:html('Request denied')}}});
  const result=await env.publisher.acquire(env.item);
  assert.equal(result.state,'needs_login');assert.equal(result.accessReason,null);assert.equal(result.accessEvidence.kind,'request_restricted');
  assert.equal(result.accessEvidence.confidence,'possible');assert.equal(result.accessEvidence.source,'response');
});

test('access evidence excludes query and fragment secrets',()=>{
  const env=setup(),found=env.api.discover(parseHTML(scienceDirectPage('<button>Institutional login</button>')).document,scienceDirectArticle+'?token=secret#private',scienceDirectDOI);
  assert.equal(found.accessEvidence.url,scienceDirectArticle);assert(!JSON.stringify(found.accessEvidence).includes('secret'));
});

test('Linking Hub uses its supplied encoded same-PII ScienceDirect route',async()=>{
  const locator='https://linkinghub.elsevier.com/retrieve/pii/S002839081400478X',file='https://www.sciencedirect.com/fulltext.pdf';
  const markup=html('<input type="hidden" id="redirectURL" value="'+encodeURIComponent(scienceDirectArticle+'?via%3Dihub')+'"><input type="hidden" id="key" value="must-not-be-retained">');
  const env=setup({url:locator,doi:scienceDirectDOI,pages:{[locator]:markup,[scienceDirectArticle]:scienceDirectPage('<meta name="citation_pdf_url" content="/fulltext.pdf">'),[file]:{bytes:pdf(),type:'application/pdf'}}});
  const discovered=env.api.discover(parseHTML(markup).document,locator,scienceDirectDOI);
  assert.deepEqual(Array.from(discovered.articleRoutes),[scienceDirectArticle]);
  const result=await env.publisher.acquire(env.item);assert.equal(result.source,'publisher');assert.equal(result.publisherURL,scienceDirectArticle);assert.equal(env.imports.length,1);
  assert.deepEqual(env.requests.map(value=>value.url),[locator,scienceDirectArticle,file]);
  assert.equal(env.hidden.length,0);assert(!JSON.stringify(env.requests).includes('must-not-be-retained'));
});

test('Linking Hub refresh target can expose the canonical article but not an invented PDF URL',()=>{
  const locator='https://linkinghub.elsevier.com/retrieve/pii/S002839081400478X',env=setup();
  const markup=html('<meta http-equiv="refresh" content="2; url=\'/retrieve/articleSelectSinglePerm?Redirect='+encodeURIComponent(scienceDirectArticle+'?tracking=private')+'&amp;key=private\'">');
  const result=env.api.discover(parseHTML(markup).document,locator,scienceDirectDOI);
  assert.deepEqual(Array.from(result.articleRoutes),[scienceDirectArticle]);assert.equal(result.candidates.length,0);
});

test('article routing refuses other PIIs other hosts credentials PDF guesses and untrusted locator pages',()=>{
  const env=setup(),locator='https://linkinghub.elsevier.com/retrieve/pii/S002839081400478X';
  for(const target of [scienceDirectArticle.replace('478X','4791'),'https://sciencedirect.com.evil.test/science/article/pii/S002839081400478X','https://user:pass@www.sciencedirect.com/science/article/pii/S002839081400478X',scienceDirectArticle+'/pdfft','http://www.sciencedirect.com/science/article/pii/S002839081400478X']){
    const markup=html('<input id="redirectURL" value="'+encodeURIComponent(target)+'">');
    assert.equal(env.api.discover(parseHTML(markup).document,locator,scienceDirectDOI).articleRoutes.length,0,target);
  }
  const markup=html('<input id="redirectURL" value="'+encodeURIComponent(scienceDirectArticle)+'">');
  assert.equal(env.api.discover(parseHTML(markup).document,'https://publisher.test/article/one',scienceDirectDOI).articleRoutes.length,0);
});

test('a routed institution page remains the article destination when the locator itself has no download',async()=>{
  const locator='https://linkinghub.elsevier.com/retrieve/pii/S002839081400478X';
  const markup=html('<input id="redirectURL" value="'+encodeURIComponent(scienceDirectArticle)+'">'),article=scienceDirectPage('<button>Access through your organization</button>');
  const env=setup({url:locator,doi:scienceDirectDOI,pages:{[locator]:markup,[scienceDirectArticle]:article},rendered:{[scienceDirectArticle]:article,[locator]:markup}});
  const result=await env.publisher.acquire(env.item);assert.equal(result.state,'needs_login');assert.equal(result.accessReason,'institutional_access');
  assert.equal(result.publisherURL,scienceDirectArticle);assert.equal(result.url,scienceDirectArticle);
  assert.equal(env.requests.filter(value=>value.url===scienceDirectArticle).length,1);
});

test('ScienceDirect institution and purchase page returns needs_login with a default-browser instruction',async()=>{
  const markup=scienceDirectPage('<div><button>Access through your organization</button><a href="/purchase/article">Purchase PDF</a></div><h2>Article preview</h2>');
  const env=setup({url:scienceDirectArticle,doi:scienceDirectDOI,pages:{[scienceDirectArticle]:markup,['https://doi.org/'+scienceDirectDOI]:{url:scienceDirectArticle,body:markup}},rendered:{[scienceDirectArticle]:markup}});
  const result=await env.publisher.acquire(env.item);
  assert.equal(result.state,'needs_login');assert.equal(result.accessReason,'institutional_access');assert.equal(result.url,scienceDirectArticle);
  assert.match(result.message,/默认浏览器/);assert.match(result.message,/机构登录/);assert.match(result.message,/点击 PDF 下载/);assert.match(result.message,/匹配的新 PDF 会自动入库/);assert.equal(env.imports.length,0);
  assert(env.requests.every(request=>request.method==='GET'&&!request.url.includes('/purchase/')));
});

test('purchase and ScienceDirect preview controls are access restrictions, not an absent article',async()=>{
  for(const [controls,reason] of [['<button>Purchase PDF</button>','purchase'],['<h2>Article preview</h2>','preview']]){
    const markup=scienceDirectPage(controls),env=setup({url:scienceDirectArticle,pages:{[scienceDirectArticle]:markup},rendered:{[scienceDirectArticle]:markup}});
    const result=await env.publisher.acquire(env.item);assert.equal(result.state,'needs_login');assert.equal(result.accessReason,reason);assert.match(result.message,/默认浏览器/);assert.match(result.message,/机构登录/);assert.equal(env.imports.length,0);
  }
  const generic=setup(),found=generic.api.discover(parseHTML(html('<h2>Article preview</h2>')).document,'https://publisher.test/article/one','');
  assert.equal(found.needsLogin,false);
});

test('footer navigation hidden widgets and scripts do not turn ordinary content into an access gate',async()=>{
  const noise='<footer><a href="/access">Access through your organization</a><button>Purchase PDF</button><input type="password"></footer><nav><a href="/login">Institutional login</a></nav><div hidden><button>Access through your institution</button></div><div aria-hidden="true"><input type="password"><h2>Article preview</h2></div><script>const text="Sign in to download";</script>';
  const markup=html('<main><h1>Public article</h1><p>Abstract available</p></main>'+noise),env=setup({pages:{'https://publisher.test/article/one':markup},rendered:{'https://publisher.test/article/one':markup}});
  const found=env.api.discover(parseHTML(markup).document,scienceDirectArticle,'');assert.equal(found.needsLogin,false);assert.equal(found.accessReason,null);
  const result=await env.publisher.acquire(env.item);assert.equal(result.state,'not_found');assert.equal(env.imports.length,0);
});

test('a public PDF still imports despite footer sign-in or a visible institutional access option',async()=>{
  for(const login of ['<footer><a href="/login">Institutional login</a></footer>','<button>Access through your organization</button><button>Purchase PDF</button>']){
    const markup=scienceDirectPage(login+'<meta name="citation_pdf_url" content="/article.pdf">'),file='https://www.sciencedirect.com/article.pdf';
    const env=setup({url:scienceDirectArticle,doi:scienceDirectDOI,pages:{[scienceDirectArticle]:markup,[file]:{bytes:pdf(),type:'application/pdf'}}});
    const result=await env.publisher.acquire(env.item);assert.equal(result.source,'publisher');assert.equal(env.imports.length,1);assert.equal(env.hidden.length,0);assert.equal(result.state,undefined);
  }
});

test('an institutional access page still allows an independent open-access PDF',async()=>{
  const markup=scienceDirectPage('<button>Access through your organization</button>'),file='https://repository.test/paper.pdf';
  const env=setup({url:scienceDirectArticle,doi:scienceDirectDOI,pages:{[scienceDirectArticle]:markup,['https://doi.org/'+scienceDirectDOI]:{url:scienceDirectArticle,body:markup},[file]:{bytes:pdf(),type:'application/pdf'}},rendered:{[scienceDirectArticle]:markup},oa:[{url:file}]});
  const result=await env.publisher.acquire(env.item);assert.equal(result.source,'open_access');assert.equal(env.imports.length,1);
});

test('discovery excludes supplemental/reference files and refuses conflicting article DOI',()=>{
  const env=setup();
  const document=parseHTML(html('<meta name="citation_doi" content="10.1234/right"><div id="references"><a href="/cited.pdf">PDF</a></div><a href="/supplement.pdf">Supplementary PDF</a><a href="/article.pdf">Download PDF</a>')).document;
  const found=env.api.discover(document,'https://publisher.test/article/one','10.1234/right');assert.equal(found.candidates.length,1);assert.equal(found.candidates[0].url,'https://publisher.test/article.pdf');
  assert.equal(env.api.discover(document,'https://publisher.test/article/one','10.1234/wrong').mismatch,true);
});

test('PDF validation rejects tiny, truncated and HTML payloads',()=>{
  const env=setup();assert.equal(env.api.validPDF(pdf()),true);
  assert.equal(env.api.validPDF(new TextEncoder().encode('%PDF-1.7\n%%EOF')),false);
  assert.equal(env.api.validPDF(new TextEncoder().encode('%PDF-1.7\n'+'0'.repeat(1400))),false);
  assert.equal(env.api.validPDF(new TextEncoder().encode(html('0'.repeat(1500)+'%PDF-1.7 %%EOF'))),false);
});

test('Cloudflare response header stops repeated rendering and same-domain attempts until manual retry',async()=>{
  const address='https://publisher.test/article/one';
  const env=setup({pages:{[address]:{status:403,headers:{'cf-mitigated':'challenge'},body:html('Just a moment')}}});
  const result=await env.publisher.acquire(env.item);assert.equal(result.state,'needs_login');assert.equal(result.challenge,'cloudflare');assert.match(result.message,/默认浏览器/);assert.match(result.message,/点击 PDF 下载/);assert.match(result.message,/匹配的新 PDF 会自动入库/);assert.equal(env.hidden.length,0);
  await env.publisher.acquire({...env.item,id:2});assert.equal(env.requests.length,1);
  env.publisher.clearAccessGate(address);await env.publisher.acquire({...env.item,id:3});assert.equal(env.requests.length,2);
});

test('visible challenge detection ignores script-only CAPTCHA strings and gives a manual fallback',async()=>{
  const env=setup({doi:'10.1234/one',pages:{'https://publisher.test/article/one':{status:403,body:html('<div id="challenge-stage">Verify you are human. Cloudflare Ray ID</div>')}}});
  const result=await env.publisher.acquire(env.item);assert.equal(result.challenge,'cloudflare');assert.equal(env.requests.length,1);assert.equal(env.hidden.length,0);
  const ordinary=parseHTML(html('<script>const label="Verify you are human Cloudflare";</script><p>Article</p>')).document;
  assert.equal(env.api.discover(ordinary,'https://publisher.test/article/one','').challenge,null);
});

test('a challenge pauses its publisher but still allows an independent open-access PDF',async()=>{
  const env=setup({doi:'10.1234/one',pages:{'https://publisher.test/article/one':{status:403,headers:{'cf-mitigated':'challenge'}},'https://repository.test/one.pdf':{bytes:pdf(),type:'application/pdf'}},oa:[{url:'https://repository.test/one.pdf'}]});
  const result=await env.publisher.acquire(env.item);assert.equal(result.source,'open_access');assert.equal(env.imports.length,1);assert.equal(env.hidden.length,0);
});

test('different items on the same site do not run publisher requests concurrently',async()=>{
  const address='https://publisher.test/article/one';let release;
  const env=setup({pages:{[address]:()=>new Promise(resolve=>{release=()=>resolve({status:403,headers:{'cf-mitigated':'challenge'}});})}});
  const one=env.publisher.acquire(env.item);const two=env.publisher.acquire({...env.item,id:2});
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(env.requests.length,1);release();
  const results=await Promise.all([one,two]);assert(results.every(value=>value.state==='needs_login'));assert.equal(env.maxActive(),1);assert.equal(env.requests.length,1);
});

test('cancelling a queued same-site item returns promptly and never sends its later request',async()=>{
  const address='https://publisher.test/article/one';let release,cancelled=false;
  const env=setup({pages:{[address]:()=>new Promise(resolve=>{release=()=>resolve({status:403,headers:{'cf-mitigated':'challenge'}});})}});
  const one=env.publisher.acquire(env.item);const two=env.publisher.acquire({...env.item,id:2},{isCancelled:()=>cancelled});
  await new Promise(resolve=>setTimeout(resolve,10));cancelled=true;
  await assert.rejects(two,error=>error.name==='AbortError');assert.equal(env.requests.length,1);release();await one;
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(env.requests.length,1);
});


function sourceFixture(candidates,extra={}){
  const validated=[],prepared=[];
  return{validated,prepared,async discover(input){this.input=input;return{candidates,diagnostics:[{source:'pmc',code:'fixture',message:'Public dataset fixture'}]};},async validateURL(value){validated.push(value);const url=new URL(value);if(url.protocol!=='https:'||['127.0.0.1','localhost'].includes(url.hostname))throw Error('not public');return url.href;},async prepareRequest(candidate){prepared.push(candidate);return{url:candidate.url,headers:{Accept:'application/pdf',...(candidate.credentialScope?{Authorization:'Bearer fixture-secret'}:{})},timeout:1000};},parsePage(){return{candidates:[]};},...extra};
}
test('API PDF identity is checked before import and publisher fallback is not contacted',async()=>{
  const url='https://dataset.test/file.pdf',sources=sourceFixture([{url,source:'pmc',version:'published',kind:'pdf'}]),checks=[];
  const env=setup({doi:'10.1234/one',sources,pages:{[url]:{bytes:pdf(),type:'application/pdf'}},pdfIdentity:{async inspect(file,paper,{bytes}){checks.push({file,paper,bytes});return{status:'match'};}}});
  const result=await env.publisher.acquire(env.item);assert.equal(result.source,'pmc');assert.equal(result.fulltextVersion,'published');assert.equal(checks.length,1);assert.deepEqual(env.requests.map(value=>value.url),[url]);assert.equal(env.hidden.length,0);assert(env.requests[0].options.anon);assert.equal(env.requests[0].options.followRedirects,false);
});
test('API redirects are validated and credentials never cross download origins or change endpoints',async()=>{
  for(const target of ['https://files.test/article.pdf','https://api.test/other.pdf']){
    const url='https://api.test/download.pdf',sources=sourceFixture([{url,source:'openalex',credentialScope:'openalex',kind:'pdf'}]);
    const env=setup({doi:'10.1234/one',sources,pages:{[url]:{status:302,headers:{Location:target}},[target]:{bytes:pdf(),type:'application/pdf'}},pdfIdentity:{async inspect(){return{status:'match'};}}});
    const result=await env.publisher.acquire(env.item);assert(result.attachmentID);assert.equal(env.requests[0].options.headers.Authorization,'Bearer fixture-secret');assert.equal(env.requests[1].options.headers.Authorization,undefined);assert(sources.validated.includes(target));assert.equal(sources.prepared.length,1,'One allowance reservation for a redirected download');
    assert.equal(result.discoveryProvider,'openalex');assert.equal(result.pdfHost,new URL(target).hostname);
  }
});
test('unsafe API redirects and wrong article PDFs never enter Zotero',async()=>{
  for(const mode of ['redirect','mismatch']){
    const url='https://dataset.test/file.pdf',sources=sourceFixture([{url,source:'pmc',kind:'pdf'}]);
    const env=setup({doi:'10.1234/one',sources,sourceSettings:{enabled:{publisher:false}},pages:{[url]:mode==='redirect'?{status:302,headers:{Location:'https://127.0.0.1/private.pdf'}}:{bytes:pdf(),type:'application/pdf'}},pdfIdentity:{async inspect(){return{status:'mismatch'};}}});
    const result=await env.publisher.acquire(env.item);assert.equal(result.state,'not_found');assert.equal(env.imports.length,0);assert.equal(env.hidden.length,0);assert.equal(env.requests.length,1);assert(result.sourceDiagnostics.some(value=>value.code===(mode==='redirect'?'download_failed':'pdf_mismatch')));
  }
});

test('native redirect headers may throw for absent Retry-After without losing a valid PDF',async()=>{
  const first='https://api.core.ac.uk/v3/outputs/123/download',final='https://files.test/paper.pdf',responses=[];
  const sources=sourceFixture([{url:first,source:'core',credentialScope:'core',kind:'pdf'}],{recordResponse(url,options){responses.push(options);}});
  const env=setup({doi:'10.1234/one',sources,sourceSettings:{enabled:{publisher:false}},pages:{
    [first]:{status:302,getResponseHeader(name){if(name.toLowerCase()==='location')return final;throw Error('NS_ERROR_NOT_AVAILABLE');}},
    [final]:{bytes:pdf(),type:'application/pdf'}
  },pdfIdentity:{async inspect(){return{status:'match'};}}});
  const result=await env.publisher.acquire(env.item);
  assert.equal(result.attachmentID,101);assert.equal(result.discoveryProvider,'core');assert.equal(result.pdfHost,'files.test');
  assert.equal(env.requests.length,2);assert.equal(env.requests[1].options.headers.Authorization,undefined);
  assert.deepEqual(responses.map(x=>[x.status,x.retryAfter]),[[302,''],[200,'']]);
});
test('unknown API identity becomes a single review candidate and does not import silently',async()=>{
  const url='https://dataset.test/file.pdf',sources=sourceFixture([{url,source:'pmc',version:'accepted',kind:'pdf'}]);
  const env=setup({doi:'10.1234/one',sources,sourceSettings:{enabled:{publisher:false}},pages:{[url]:{bytes:pdf(),type:'application/pdf'}},pdfIdentity:{async inspect(){return{status:'unknown'};}}});
  const result=await env.publisher.acquire(env.item);assert.equal(result.needsReview,true);assert.equal(result.fulltextVersion,'accepted');assert.equal(result.paper.doi,'10.1234/one');assert.equal(result.reviewBytes.length,pdf().length);assert.equal(env.imports.length,0);assert.equal([...env.files.keys()].some(value=>value.startsWith('/tmp/')),false);
  assert.equal(result.discoveryProvider,'pmc');assert.equal(result.pdfHost,'dataset.test');
});
test('Extra DOI and PMCID are passed to sources and existing files skip all APIs',async()=>{
  const sources=sourceFixture([]),env=setup({sources,sourceSettings:{enabled:{publisher:false}}});env.item.getExtraField=name=>({DOI:'10.1234/from-extra',PMCID:'PMC12345'})[name]||'';
  await env.publisher.acquire(env.item);assert.equal(sources.input.doi,'10.1234/from-extra');assert.equal(sources.input.pmcid,'PMC12345');
  env.files.set('/existing.pdf',pdf());env.attachments.push({id:9,attachmentContentType:'application/pdf',async getFilePathAsync(){return '/existing.pdf';}});sources.discover=async()=>{throw Error('must not discover');};assert.equal((await env.publisher.acquire(env.item)).source,'existing');
});
test('pause during anonymous transfer aborts it and does not import or visit another source',async()=>{
  const url='https://dataset.test/file.pdf';let cancelled=false,aborted=false;
  const sources=sourceFixture([{url,source:'pmc',kind:'pdf'}]),env=setup({doi:'10.1234/one',sources,pages:{[url]:({options})=>{options.cancellerReceiver(()=>{aborted=true;});cancelled=true;return new Promise(()=>{});}}});
  await assert.rejects(env.publisher.acquire(env.item,{isCancelled:()=>cancelled}),{name:'AbortError'});assert(aborted);assert.equal(env.requests.length,1);assert.equal(env.imports.length,0);
});
test('publisher PDFs also require identity verification before automatic import',async()=>{
  const url='https://publisher.test/article/one',env=setup({pages:{[url]:{bytes:pdf(),type:'application/pdf'}},pdfIdentity:{async inspect(){return{status:'mismatch'};}}});
  const result=await env.publisher.acquire(env.item);assert.equal(result.state,'not_found');assert.equal(env.imports.length,0);assert(result.sourceDiagnostics.some(value=>value.code==='pdf_mismatch'));
});

test('streamed API candidates are downloaded and verified before discovery returns',async()=>{
  const url='https://repository.test/stream.pdf';let verified=false,accepted;
  const sources=sourceFixture([],{async discover(input,options){
    accepted=await options.onCandidates({candidates:[{url,source:'semanticScholar',kind:'pdf'}],diagnostics:[]});
    assert(verified);assert.equal(accepted.attachmentID,101);return {candidates:[],diagnostics:[],accepted};
  }});
  const env=setup({doi:'10.1234/one',sources,pages:{[url]:{bytes:pdf(),type:'application/pdf'}},pdfIdentity:{async inspect(){verified=true;return {status:'match'};}}});
  const result=await env.publisher.acquire(env.item);assert.equal(result,accepted);assert.equal(result.discoveryProvider,'semanticScholar');assert.equal(result.pdfHost,'repository.test');
  assert.equal(env.imports.length,1);assert.equal(env.requests.length,1);
});

test('streamed mismatches continue to later sources and HTML landing pages never become a reported PDF host',async()=>{
  const first='https://landing.test/article',wrong='https://wrong.test/paper.pdf',good='https://storage.test/right.pdf';let attempts=0;
  const sources=sourceFixture([],{async discover(input,options){
    for(const candidate of [{url:first,source:'openalex',kind:'page'},{url:wrong,source:'core',kind:'pdf'},{url:good,source:'pmc',kind:'pdf'}]){
      const accepted=await options.onCandidates({candidates:[candidate],diagnostics:[]});
      if(accepted)return {accepted,candidates:[],diagnostics:[]};
    }
    throw Error('Expected final fixture to import');
  }});
  const env=setup({doi:'10.1234/one',sources,pages:{[first]:html('No PDF'),[wrong]:{bytes:pdf(),type:'application/pdf'},[good]:{bytes:pdf(),type:'application/pdf'}},pdfIdentity:{async inspect(){return {status:++attempts===1?'mismatch':'match'};}}});
  const result=await env.publisher.acquire(env.item);assert.equal(result.discoveryProvider,'pmc');assert.equal(result.pdfHost,'storage.test');assert.equal(env.imports.length,1);assert.equal(attempts,2);
});

test('API download responses feed endpoint backoff and every redirect hop checks its own scope',async()=>{
  const first='https://api.test/paper.pdf',final='https://cdn.test/paper.pdf?Expires=123';const before=[],responses=[];
  const sources=sourceFixture([{url:first,source:'openalex',kind:'pdf',credentialScope:'openalex'}],{
    async beforeRequest(url,options){before.push({url,headers:{...options.headers},source:options.source});},
    recordResponse(url,options){responses.push({url,status:options.status,source:options.source});},
  });
  const env=setup({doi:'10.1234/one',sources,pages:{[first]:{status:302,headers:{Location:final}},[final]:{bytes:pdf(),type:'application/pdf'}},pdfIdentity:{async inspect(){return {status:'match'};}}});
  const result=await env.publisher.acquire(env.item);assert.equal(result.pdfHost,'cdn.test');assert.equal(result.discoveryProvider,'openalex');
  assert.deepEqual(before.map(row=>row.url),[first,final]);assert.equal(before[1].headers.Authorization,undefined);assert.deepEqual(responses.map(row=>row.status),[302,200]);
  assert(!result.pdfHost.includes('Expires'));
});

test('an unverified transparent redirect is rejected before following a new Location or recording endpoint status',async()=>{
  const first='https://api.test/paper.pdf',target='https://cdn.test/paper.pdf',responses=[];
  const sources=sourceFixture([{url:first,source:'openalex',kind:'pdf',credentialScope:'openalex'}],{recordResponse(url,options){responses.push({url,status:options.status});}});
  const env=setup({doi:'10.1234/one',sources,sourceSettings:{enabled:{publisher:false}},pages:{[first]:{status:302,url:'https://unexpected.test/redirect',headers:{Location:target}},[target]:{bytes:pdf(),type:'application/pdf'}},pdfIdentity:{async inspect(){throw Error('Unexpected identity check');}}});
  const result=await env.publisher.acquire(env.item);assert.equal(result.state,'not_found');assert.equal(env.requests.length,1);assert.equal(responses.length,0);assert.equal(env.imports.length,0);
});

test('unsuccessful landing pages and identity conflicts cannot claim a final PDF host',async()=>{
  for(const kind of ['html','mismatch']){
    const url='https://repository.test/article',sources=sourceFixture([{url,source:'openalex',kind:'page'}]);
    const env=setup({doi:'10.1234/one',sources,sourceSettings:{enabled:{publisher:false}},pages:{[url]:kind==='html'?html('No downloadable PDF'):{bytes:pdf(),type:'application/pdf'}},pdfIdentity:{async inspect(){return {status:'mismatch'};}}});
    const result=await env.publisher.acquire(env.item);assert.equal(result.pdfHost,undefined);assert.equal(result.discoveryProvider,undefined);assert.equal(env.imports.length,0);
  }
});

test('a blocked normal CORE address can fall back to its official API but still needs the PDF identity check',async()=>{
  for(const identity of ['match','unknown','mismatch']){
    const normal='https://core.ac.uk/download/pdf/123.pdf',hosted='https://api.core.ac.uk/v3/outputs/123/download';let normalFinished=false,hostedPrepared=0,checked=0;
    const candidates=[{url:normal,source:'core',kind:'pdf'},{url:hosted,source:'core',kind:'pdf',credentialScope:'core',fallbackOnly:true}];
    const sources=sourceFixture(candidates,{async discover(input,options){
      const first=await options.onCandidates({candidates:[candidates[0]],diagnostics:[]});assert.equal(first,null);normalFinished=true;
      const accepted=await options.onCandidates({candidates:[candidates[1]],diagnostics:[]});return {candidates,diagnostics:[],...(accepted?{accepted}:{})};
    },async prepareRequest(candidate){
      if(candidate.fallbackOnly){assert(normalFinished);hostedPrepared++;}
      return {url:candidate.url,headers:candidate.fallbackOnly?{Authorization:'Bearer core-private-fixture'}:{},fulltextVersion:candidate.fallbackOnly?'accepted':'unknown'};
    }});
    const env=setup({doi:'10.1234/one',sources,sourceSettings:{enabled:{publisher:false}},pages:{[normal]:{status:403},[hosted]:{bytes:pdf(),type:'application/pdf'}},pdfIdentity:{async inspect(){checked++;return {status:identity};}}});
    const result=await env.publisher.acquire(env.item);assert.equal(hostedPrepared,1);assert.equal(checked,1);assert.deepEqual(env.requests.map(row=>row.url),[normal,hosted]);
    assert.equal(env.imports.length,identity==='match'?1:0);
    if(identity!=='mismatch'){assert.equal(result.discoveryProvider,'core');assert.equal(result.pdfHost,'api.core.ac.uk');assert.equal(result.fulltextVersion,'accepted');}
    else {assert.equal(result.state,'not_found');assert.equal(result.pdfHost,undefined);}
    assert(!JSON.stringify(result).includes('core-private-fixture'));
  }
});
