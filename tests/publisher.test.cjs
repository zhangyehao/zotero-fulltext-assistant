const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {parseHTML} = require('linkedom');
const source = fs.readFileSync(path.join(__dirname,'../src/publisher.js'),'utf8');
const pdf = () => new TextEncoder().encode('%PDF-1.7\n' + '0'.repeat(1200) + '\n%%EOF\n');
const html = body => '<!doctype html><html><head></head><body>' + body + '</body></html>';

function setup({url='https://publisher.test/article/one',doi='',pages={},rendered={},oa=[]}={}) {
  const files=new Map(),attachments=[],requests=[],imports=[],progress=[],hidden=[];
  let nextID=100,tempID=0,renderedOnce=false,active=0,maxActive=0;
  const item={id:1,libraryID:1,isRegularItem:()=>true,getField(name){return {url,DOI:doi}[name]||'';},getAttachments(){return attachments.map(value=>value.id);}};
  const IOUtils={async exists(file){return files.has(file);},async stat(file){if(!files.has(file))throw new Error('Missing fixture file');return {type:'regular',size:files.get(file).length,lastModified:1};},async read(file,{offset=0,maxBytes}={}){if(!files.has(file))throw new Error('Missing fixture file');return files.get(file).slice(offset,maxBytes===undefined?undefined:offset+maxBytes);},async write(file,bytes){files.set(file,bytes);},async remove(file){files.delete(file);}};
  const Zotero={Promise:{delay(ms){return new Promise(resolve=>setTimeout(resolve,Math.min(ms,5)));}},Items:{async getAsync(id){return attachments.find(value=>value.id===id);}},HTTP:{async request(method,address,options){
    requests.push({method,url:address,options});active++;maxActive=Math.max(maxActive,active);
    try {
      if(!(address in pages))throw new Error('fixture missing route');
      let value=pages[address];if(typeof value==='function')value=await value({renderedOnce,options});
      if(typeof value==='string')value={body:value};
      const bytes=value.bytes||new TextEncoder().encode(value.body||'');
      return {status:value.status??200,response:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),responseURL:value.url||address,getResponseHeader(name){return name==='Content-Type'?(value.type||'text/html; charset=utf-8'):(value.headers?.[name]||null);}};
    } finally {active--;}
  }},Attachments:{async createTemporaryStorageDirectory(){return {path:'/tmp/publisher-'+(++tempID)};},async importFromFile(options){imports.push(options);assert.equal(options.parentItemID,1);assert.equal(options.libraryID,1);assert.equal(options.contentType,'application/pdf');assert(files.has(options.file));const attachment={id:++nextID,attachmentContentType:'application/pdf',async getFilePathAsync(){return '/storage/'+this.id+'.pdf';},setField(){},async saveTx(){}};files.set('/storage/'+attachment.id+'.pdf',files.get(options.file));attachments.push(attachment);return attachment;},getFileResolvers(_item,methods){assert.deepEqual(Array.from(methods),['oa']);return [async()=>oa];}}};
  class HiddenBrowser {
    constructor(options){this.options=options;this.destroyed=false;hidden.push(this);}
    async load(address){renderedOnce=true;this.currentURI={spec:address};return true;}
    async getPageData(props){assert.deepEqual(Array.from(props),['documentHTML']);return {documentHTML:rendered[this.currentURI.spec]||html('No file')};}
    destroy(){this.destroyed=true;}
  }
  const scope={URL,Promise,Date,JSON,Set,Map,Uint8Array,ArrayBuffer,TextDecoder,TextEncoder};
  vm.runInNewContext(source,scope);
  const publisher=scope.FulltextPublisher.create({Zotero,Services:{},IOUtils,PathUtils:path.posix,parseHTML,HiddenBrowser});
  return {publisher,api:scope.FulltextPublisher,item,Zotero,IOUtils,files,attachments,requests,imports,hidden,progress,onProgress:info=>progress.push(info),maxActive:()=>maxActive};
}

test('HTTP citation_pdf_url yields a verified PDF attached to the original item',async()=>{
  const env=setup({pages:{'https://publisher.test/article/one':html('<meta name="citation_pdf_url" content="/files/one.pdf">'),'https://publisher.test/files/one.pdf':{bytes:pdf(),type:'application/pdf'}}});
  const result=await env.publisher.acquire(env.item,{onProgress:env.onProgress});
  assert.equal(result.source,'publisher');assert.equal(result.sourceURL,'https://publisher.test/files/one.pdf');assert.equal(env.imports.length,1);assert.equal(env.hidden.length,0);
  assert(env.requests.every(value=>!('userContextId' in value.options)));
  assert.equal(env.requests[1].options.headers.Referer,'https://publisher.test/article/one');
  assert.equal([...env.files.keys()].some(value=>value.startsWith('/tmp/')),false);
});

test('JS-rendered download anchor succeeds when the initial HTTP DOM has no PDF',async()=>{
  const env=setup({pages:{'https://publisher.test/article/one':html('<div id="app"></div>'),'https://publisher.test/secure-download?id=one':{bytes:pdf(),type:'application/octet-stream'}},rendered:{'https://publisher.test/article/one':html('<a href="/secure-download?id=one">Download PDF</a>')}});
  const result=await env.publisher.acquire(env.item,{onProgress:env.onProgress});
  assert.equal(result.source,'rendered_publisher');assert.equal(env.imports.length,1);
  assert.equal(env.hidden[0].options.allowJavaScript,true);assert.equal('userContextId' in env.hidden[0].options,false);assert.equal(env.hidden[0].destroyed,true);
  assert(env.progress.some(value=>value.stage==='rendering'));
});

test('a publisher URL rejected before JS cookie initialization is retried after rendering',async()=>{
  const markup=html('<a href="/download.pdf">Download PDF</a>');
  const env=setup({pages:{'https://publisher.test/article/one':markup,'https://publisher.test/download.pdf':({renderedOnce})=>renderedOnce?{bytes:pdf(),type:'application/pdf'}:{status:403,body:html('Access through your institution')}},rendered:{'https://publisher.test/article/one':markup}});
  const result=await env.publisher.acquire(env.item);
  assert.equal(result.source,'rendered_publisher');assert.equal(env.requests.filter(value=>value.url.endsWith('/download.pdf')).length,2);assert.equal(env.imports.length,1);
});

test('HTML pretending to be a PDF is rejected and OA resolver remains a later fallback',async()=>{
  const env=setup({doi:'10.1234/one',pages:{'https://publisher.test/article/one':html('<a href="/bad.pdf">PDF</a>'),'https://publisher.test/bad.pdf':{body:html('Sign in to download'),type:'application/pdf'},'https://doi.org/10.1234/one':html('Paywall'),'https://repository.test/one.pdf':{bytes:pdf(),type:'application/pdf'}},oa:[{url:'https://repository.test/one.pdf'}]});
  const result=await env.publisher.acquire(env.item);
  assert.equal(result.source,'open_access');assert.equal(env.imports.length,1);assert.equal(result.sourceURL,'https://repository.test/one.pdf');
  assert(env.requests.findIndex(value=>value.url==='https://repository.test/one.pdf')>env.requests.findIndex(value=>value.url==='https://publisher.test/bad.pdf'));
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
  }
  const ordinary=env.api.discover(parseHTML(scienceDirectPage('<button>Sign in</button><a href="/register">Create account</a>')).document,scienceDirectArticle,scienceDirectDOI);
  assert.equal(ordinary.needsLogin,false);assert.equal(ordinary.accessReason,null);
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
