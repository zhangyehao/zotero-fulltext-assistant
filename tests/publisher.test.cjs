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
  const IOUtils={async exists(file){return files.has(file);},async write(file,bytes){files.set(file,bytes);},async remove(file){files.delete(file);}};
  const Zotero={Promise:{delay(ms){return new Promise(resolve=>setTimeout(resolve,Math.min(ms,5)));}},Items:{async getAsync(id){return attachments.find(value=>value.id===id);}},HTTP:{async request(method,address,options){
    requests.push({method,url:address,options});active++;maxActive=Math.max(maxActive,active);
    try {
      if(!(address in pages))throw new Error('fixture missing route');
      let value=pages[address];if(typeof value==='function')value=await value({renderedOnce,options});
      if(typeof value==='string')value={body:value};
      const bytes=value.bytes||new TextEncoder().encode(value.body||'');
      return {status:value.status??200,response:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),responseURL:value.url||address,getResponseHeader(){return value.type||'text/html; charset=utf-8';}};
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
