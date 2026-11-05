const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {parseHTML} = require('linkedom');

const source = fs.readFileSync(path.join(__dirname, '../src/edge-acquire.js'), 'utf8');
const DOI = '10.1234/article.1';
const TITLE = 'The original scientific article with a sufficiently distinctive title';
const URL = global.URL;
const ARTICLE = 'https://publisher.test/articles/one';
const FILE = 'https://cdn.publisher.test/one.pdf?temporary=redacted';
const pdf = () => new TextEncoder().encode('%PDF-1.7\n' + '0'.repeat(1400) + '\n%%EOF\n');
const documentHTML = ({doi=DOI,title=TITLE,file=FILE,body=''}={}) => '<!doctype html><html><head><title>' + title + '</title>'
  + (doi ? '<meta name="citation_doi" content="' + doi + '">' : '')
  + '<meta name="citation_title" content="' + title + '">' + (file ? '<meta name="citation_pdf_url" content="' + file + '">' : '')
  + '</head><body><h1>' + title + '</h1>' + body + '</body></html>';

function setup(options={}) {
  let now = 0, nextStream = 0;
  const env = {
    task: {id:'task1',doi:DOI,title:TITLE,officialURL:ARTICLE},
    calls:[],requests:[],evaluations:[],progress:[],opened:[],attached:[],focused:[],closed:[],streamCloses:[],polls:0,cancelled:false,
    pages: new Map([['root',{id:'root',url:ARTICLE,loaderId:'loader-root',documentTime:100,html:documentHTML()}]]),
    streams:new Map(), routes:new Map([[FILE,{bytes:pdf()}]]), listeners:new Set(),
    ...options.initial
  };
  Object.assign(env.task,options.task||{});
  if (options.root) Object.assign(env.pages.get('root'),options.root);
  if (options.routes) env.routes = new Map(Object.entries(options.routes));
  env.emit = event => {for (const callback of env.listeners) callback(event);};
  const pageFor = sessionId => env.pages.get(String(sessionId).replace(/^session-/,''));
  const host = {
    async open(url) {
      env.opened.push(url);
      if(env.opened.length===1){await options.onOpen?.(env);return{id:'root',sessionId:'session-root'};}
      const id='created-'+env.opened.length,route=env.routes.get(url);
      const page={id,url,loaderId:'loader-'+id,documentTime:env.opened.length*100,html:route?.html||'<html><head><title>PDF verification</title></head><body>Verify that you are human</body></html>'};
      env.pages.set(id,page);await options.onCandidateOpen?.(env,page);return{id,sessionId:'session-'+id};
    },
    async attach(id) {env.attached.push(id);return{id,sessionId:'session-'+id};},
    async pages() {
      env.polls++;
      const override = await options.onPages?.(env);
      if (override) return override;
      if(env.polls>(options.maxPolls??5))return [];
      return [...env.pages.values()].filter(value=>!value.closed).map(page=>({targetId:page.id,type:'page',url:page.url,openerId:page.openerId}));
    },
    async send(method,params={},sessionId,timeoutMs) {
      env.calls.push({method,params,sessionId,timeoutMs});
      const override = await options.onSend?.(env,{method,params,sessionId,timeoutMs});
      if(override!==undefined)return override;
      const page=pageFor(sessionId);
      if(method==='Page.enable')return{};
      if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'frame-'+page.id,url:page.url,loaderId:page.loaderId}}};
      if(method==='Runtime.evaluate') {
        const document=parseHTML(page.html).document;
        Object.defineProperty(document,'readyState',{value:page.readyState||'complete'});
        Object.defineProperty(document,'contentType',{value:page.contentType||'text/html'});
        const value=vm.runInNewContext(params.expression,{document,location:{href:page.url},performance:{timeOrigin:page.documentTime},URL});
        env.evaluations.push({id:page.id,value});
        return{result:{value}};
      }
      if(method==='Network.loadNetworkResource') {
        env.requests.push({url:params.url,sessionId,params,timeoutMs,poll:env.polls});
        let route=env.routes.get(params.url);
        if(typeof route==='function')route=await route(env,{method,params,sessionId,timeoutMs});
        if(!route)return{resource:{success:false,httpStatusCode:404}};
        if(route.resource)return{resource:route.resource};
        const handle='stream-'+(++nextStream);
        const bytes=route.bytes||new TextEncoder().encode(route.html||'');
        env.streams.set(handle,{bytes,offset:0,sessionId,route});
        return{resource:{success:route.success??true,httpStatusCode:route.status??200,stream:handle,headers:route.headers||{'Content-Length':String(bytes.length)}}};
      }
      if(method==='IO.read') {
        const stream=env.streams.get(params.handle);assert(stream,'known stream');
        assert.equal(sessionId,stream.sessionId,'IO.read uses the page session that owns the stream');
        const chunk=stream.bytes.subarray(stream.offset,stream.offset+params.size);stream.offset+=chunk.length;
        await stream.route.onRead?.(env,stream);
        return{data:Buffer.from(chunk).toString('base64'),base64Encoded:true,eof:stream.offset>=stream.bytes.length};
      }
      if(method==='IO.close') {
        const stream=env.streams.get(params.handle);
        if(stream)assert.equal(sessionId,stream.sessionId,'IO.close uses the owning session');
        env.streamCloses.push({handle:params.handle,sessionId});env.streams.delete(params.handle);return{};
      }
      throw new Error('Unexpected CDP command: '+method);
    },
    async focus(page){env.focused.push(page.id);},async closePage(page){env.closed.push(page.id);const current=env.pages.get(page.id);if(current)current.closed=true;},
    onEvent(callback){env.listeners.add(callback);return()=>env.listeners.delete(callback);}
  };
  class TestDate extends Date {static now(){return now;}}
  const Zotero={Promise:{delay(ms){if(ms===1000)now+=options.pollAdvance??1000;return new Promise(resolve=>setImmediate(resolve));}}};
  const scope={URL,Promise,Date:TestDate,JSON,Set,Map,Uint8Array,ArrayBuffer,TextDecoder,TextEncoder};
  vm.runInNewContext(source,scope);
  env.worker=scope.FulltextEdgeAcquire.create({host,parseHTML,validPDF:bytes=>bytes.length>=1024&&new TextDecoder().decode(bytes.subarray(0,9)).startsWith('%PDF-1.')&&new TextDecoder().decode(bytes.subarray(-20)).includes('%%EOF'),Zotero});
  env.acquire=extra=>env.worker.acquire(env.task,{isCancelled:()=>env.cancelled,onProgress:async info=>{env.progress.push(info);await options.onProgress?.(env,info);},...extra});
  return env;
}

test('reads a cross-origin citation PDF with Edge credentials and keeps signed URLs out of the result',async()=>{
  let progressSettled=false;
  const env=setup({onProgress:async(_env,info)=>{if(info.state==='browser_downloading'){await new Promise(resolve=>setImmediate(resolve));progressSettled=true;}},onSend:(_env,{method})=>{if(method==='Network.loadNetworkResource')assert(progressSettled);}});
  const result=await env.acquire();
  assert.equal(result.source,'edge_browser');assert.equal(Buffer.compare(Buffer.from(result.bytes),Buffer.from(pdf())),0);
  assert.deepEqual(Object.keys(result).sort(),['bytes','source']);
  assert.equal(env.requests[0].params.options.includeCredentials,true);assert.equal(env.requests[0].params.frameId,'frame-root');
  assert.equal(env.requests[0].timeoutMs,180000);assert.equal(env.streams.size,0);assert.equal(env.listeners.size,0);
  assert(env.progress.some(value=>value.state==='browser_scanning'));
});

test('an explicitly different DOI is rejected even when its title matches',async()=>{
  const env=setup({root:{html:documentHTML({doi:'10.1234/another'})}});
  await assert.rejects(env.acquire(),{name:'EdgeBrowserClosedError'});
  assert.equal(env.requests.length,0);assert(env.progress.some(value=>value.message.includes('DOI 与原条目不同')));
});

test('a strong exact title can identify an article with no DOI, while a short generic title cannot',async()=>{
  const good=setup({root:{html:documentHTML({doi:''})}});assert.equal((await good.acquire()).source,'edge_browser');
  const short=setup({task:{doi:'',title:'Introduction'},root:{html:documentHTML({doi:'',title:'Introduction'})}});
  await assert.rejects(short.acquire(),/补全有效 DOI/);assert.equal(short.opened.length,0);
  const wrong=setup({root:{html:documentHTML({doi:'',title:TITLE+' changed'})}});
  await assert.rejects(wrong.acquire(),{name:'EdgeBrowserClosedError'});assert.equal(wrong.requests.length,0);
});

test('only the root and its opener descendants are evaluated, including an SSO return popup',async()=>{
  const env=setup({root:{html:documentHTML({doi:'',title:'Sign in',file:'',body:'Sign in to access'})},onOpen(env){
    env.pages.set('unrelated',{id:'unrelated',url:'https://unrelated.test',loaderId:'u',documentTime:1,html:documentHTML()});
    env.pages.set('sso',{id:'sso',openerId:'root',url:'https://sso.test/login',loaderId:'sso',documentTime:2,html:documentHTML({doi:'',title:'Sign in',file:''})});
    env.pages.set('child',{id:'child',openerId:'sso',url:ARTICLE,loaderId:'child',documentTime:3,html:documentHTML()});
  }});
  assert.equal((await env.acquire()).source,'edge_browser');
  assert.deepEqual(env.attached,['sso','child']);assert(!env.evaluations.some(value=>value.id==='unrelated'));
  assert.equal(env.requests[0].sessionId,'session-child');
});

test('CAPTCHA is waited for without clicks or navigation, then the solved page is scanned',async()=>{
  const env=setup({root:{html:documentHTML({body:'Verify that you are human'})},onPages(env){if(env.polls===2)env.pages.get('root').html=documentHTML();}});
  assert.equal((await env.acquire()).source,'edge_browser');assert.equal(env.requests[0].poll,3);
  assert(env.progress.some(value=>value.message.includes('手动完成验证码')));
  assert(!env.calls.some(value=>/navigate|dispatchMouse|click/i.test(value.method)));
});

test('institutional login text does not block a verified article whose PDF is accessible',async()=>{
  const env=setup({root:{html:documentHTML({body:'Access through your institution. Sign in to download other content.'})}});
  assert.equal((await env.acquire()).source,'edge_browser');assert.equal(env.requests.length,1);
  assert(env.evaluations.some(value=>value.value.gate==='login'));
});

test('institutional login text with a real 403 still waits and does not retry unchanged candidates',async()=>{
  const env=setup({root:{html:documentHTML({body:'Access through your institution'})},routes:{[FILE]:{resource:{success:false,httpStatusCode:403}}}});
  await assert.rejects(env.acquire(),{name:'EdgeBrowserClosedError'});assert.equal(env.requests.length,1);
});

test('PDF-specific CAPTCHA opens only the verified candidate and resumes after the user solves it',async()=>{
  const challenge='<!doctype html><html><head><title>Verify</title></head><body>Verify that you are human<a href="https://unrelated.test/challenge">Continue</a></body></html>';
  let reads=0;
  const env=setup({routes:{[FILE]:()=>++reads===1?{html:challenge}:{bytes:pdf()}},onCandidateOpen(_env,page){page.html=challenge;},onPages(env){
    if(env.polls===3){const page=env.pages.get('created-2');page.html='<html><head><title>PDF</title></head><body></body></html>';page.contentType='application/pdf';page.loaderId='solved';}
  }});
  assert.equal((await env.acquire()).source,'edge_browser');
  assert.deepEqual(env.opened,[ARTICLE,FILE]);assert.deepEqual(env.focused,['created-2']);assert.deepEqual(env.closed,['created-2']);
  assert.equal(env.requests.length,2);assert(!env.requests.some(value=>value.poll===2));assert(!env.pages.get('root').closed);
  assert(!env.calls.some(value=>/navigate|click|dispatch/i.test(value.method)));
});

test('an unknown completion page after a verification redirect does not unlock PDF requests',async()=>{
  const challenge='<!doctype html><html><body>Verify that you are human</body></html>';
  let reads=0;
  const env=setup({routes:{[FILE]:()=>++reads===1?{html:challenge}:{bytes:pdf()}},onCandidateOpen(_env,page){page.html=challenge;},onPages(env){
    if(env.polls===3){const page=env.pages.get('created-2');page.url='https://sso.publisher.test/finished';page.html='<html><body>Done</body></html>';page.loaderId='finished';}
  }});
  await assert.rejects(env.acquire(),{name:'EdgeBrowserClosedError'});assert.deepEqual(env.requests.map(value=>value.url),[FILE]);
  assert.deepEqual(env.closed,['created-2']);
});

test('an unsolved PDF verification tab is opened once, focused by task, and cleaned on cancel',async()=>{
  const challenge='<!doctype html><html><body>Verify that you are human</body></html>';
  const env=setup({routes:{[FILE]:{html:challenge}},onPages:async env=>{if(env.polls===3){assert.equal(await env.worker.focus('task1'),true);env.cancelled=true;}}});
  await assert.rejects(env.acquire(),{name:'AbortError'});assert.deepEqual(env.opened,[ARTICLE,FILE]);assert.deepEqual(env.focused,['created-2','created-2']);
  assert.deepEqual(env.closed,['created-2']);assert.equal(env.requests.length,1);assert.equal(env.streams.size,0);
});

test('contradictory article identity in a PDF challenge cannot open a verification tab',async()=>{
  const env=setup({routes:{[FILE]:{html:documentHTML({doi:'10.1234/another',body:'Verify that you are human'})}}});
  await assert.rejects(env.acquire(),{name:'EdgeBrowserClosedError'});assert.deepEqual(env.opened,[ARTICLE]);
});

test('a small 403 verification body opens the known PDF candidate, while a 403 PDF body is never accepted',async()=>{
  const challenge='<!doctype html><html><body>Verify that you are human</body></html>';
  const env=setup({routes:{[FILE]:{status:403,success:false,html:challenge}}});
  await assert.rejects(env.acquire(),{name:'EdgeBrowserClosedError'});assert.deepEqual(env.opened,[ARTICLE,FILE]);assert.deepEqual(env.closed,['created-2']);assert.equal(env.streams.size,0);
  const denied=setup({routes:{[FILE]:{status:403,success:false,bytes:pdf()}}});
  await assert.rejects(denied.acquire(),{name:'EdgeBrowserClosedError'});assert.deepEqual(denied.opened,[ARTICLE,FILE]);assert.equal(denied.requests.length,1);
});

test('a 403 without a CDP stream opens the known candidate and resumes from its article-identified final PDF link',async()=>{
  const final='https://cdn.publisher.test/after-verification.pdf';
  const env=setup({routes:{[FILE]:{resource:{success:false,httpStatusCode:403}},[final]:{bytes:pdf()}},onCandidateOpen(_env,page){
    page.html=documentHTML({file:'',body:'Verify that you are human'});
  },onPages(env){if(env.polls===3){const page=env.pages.get('created-2');page.html=documentHTML({file:final});page.loaderId='released';}}});
  assert.equal((await env.acquire()).source,'edge_browser');assert.deepEqual(env.opened,[ARTICLE,FILE]);assert.deepEqual(env.closed,['created-2']);
  assert.deepEqual(env.requests.map(value=>value.url),[FILE,final]);assert.equal(env.requests[1].sessionId,'session-created-2');
});

test('a 401 without a stream opens just one known candidate page and stable waiting does not repeat progress or requests',async()=>{
  const env=setup({routes:{[FILE]:{resource:{success:false,httpStatusCode:401}}}});
  await assert.rejects(env.acquire(),{name:'EdgeBrowserClosedError'});assert.deepEqual(env.opened,[ARTICLE,FILE]);assert.equal(env.requests.length,1);
  assert.equal(env.progress.filter(value=>value.state==='browser_scanning').length,1);
  const messages=env.progress.filter(value=>value.message.includes('请在专用 Edge 窗口手动完成验证码'));
  assert.equal(messages.length,1);assert.deepEqual(env.closed,['created-2']);
});

test('a stable article with no PDF does not repeatedly publish scanning and waiting updates',async()=>{
  const env=setup({root:{html:documentHTML({file:''})}});await assert.rejects(env.acquire(),{name:'EdgeBrowserClosedError'});
  assert.equal(env.progress.filter(value=>value.state==='browser_scanning').length,1);
  assert.equal(env.progress.filter(value=>value.message.includes('正在等待页面出现')).length,1);assert.equal(env.requests.length,0);
});

test('a PDF popup is rejected if its source article changes identity during the read',async()=>{
  let count=0;
  const env=setup({routes:{[FILE]:()=>++count===1?{resource:{success:false,httpStatusCode:403}}:{bytes:pdf(),onRead(env){env.pages.get('root').html=documentHTML({doi:'10.1234/unrelated'});}}},onPages(env){
    if(env.polls===2)env.pages.set('pdf',{id:'pdf',openerId:'root',url:FILE,loaderId:'pdf',documentTime:2,contentType:'application/pdf',html:'<html><head><title>PDF</title></head><body></body></html>'});
  }});
  await assert.rejects(env.acquire(),{name:'EdgeBrowserClosedError'});assert.equal(env.requests.length,2);assert.equal(env.streams.size,0);
});

test('source article access text alone cannot unlock an independently challenged PDF',async()=>{
  let count=0;
  const env=setup({routes:{[FILE]:()=>++count===1?{resource:{success:false,httpStatusCode:403}}:{bytes:pdf()}},onPages(env){if(env.polls===3)env.pages.get('root').html=documentHTML({body:'You have full access'});}});
  await assert.rejects(env.acquire(),{name:'EdgeBrowserClosedError'});assert.equal(env.requests.length,1);
  const denied=setup({routes:{[FILE]:{resource:{success:false,httpStatusCode:403}}}});
  await assert.rejects(denied.acquire(),{name:'EdgeBrowserClosedError'});assert.equal(denied.requests.length,1);
});

test('source CAPTCHA text disappearing cannot unlock a still-challenged PDF candidate',async()=>{
  let count=0;
  const env=setup({routes:{[FILE]:()=>++count===1?{resource:{success:false,httpStatusCode:403}}:{bytes:pdf()}},onPages(env){
    if(env.polls===2)env.pages.get('root').html=documentHTML({body:'Verify that you are human'});
    if(env.polls===3)env.pages.get('root').html=documentHTML();
  }});
  await assert.rejects(env.acquire(),{name:'EdgeBrowserClosedError'});assert.deepEqual(env.requests.map(value=>value.poll),[1]);
});

test('adding another PDF candidate during verification does not bypass the task hold',async()=>{
  const extra='https://cdn.publisher.test/another-format.pdf';
  const env=setup({routes:{[FILE]:{resource:{success:false,httpStatusCode:403}}},onPages(env){if(env.polls===2)env.pages.get('root').html=documentHTML({body:'<a href="'+extra+'">PDF</a>'});}});
  await assert.rejects(env.acquire(),{name:'EdgeBrowserClosedError'});assert.deepEqual(env.requests.map(value=>value.url),[FILE]);
});

test('verification text oscillation and empty frames never resume root or candidate requests',async()=>{
  const env=setup({maxPolls:8,routes:{[FILE]:{resource:{success:false,httpStatusCode:403}}},onPages(env){
    const page=env.pages.get('created-2');if(page){page.html='<html><body>'+(['Verify that you are human','Please wait',''][env.polls%3])+'</body></html>';page.loaderId='challenge-'+env.polls;}
  }});
  await assert.rejects(env.acquire(),{name:'EdgeBrowserClosedError'});
  assert.deepEqual(env.requests.map(value=>({poll:value.poll,session:value.sessionId})),[{poll:1,session:'session-root'}]);
  assert.equal(env.progress.filter(value=>value.state==='browser_scanning').length,1);
  assert.equal(env.progress.filter(value=>value.message.includes('已暂停所有 PDF 请求')).length,1);
});

test('source reloads and extra candidates remain quiet while a PDF verification hold is active',async()=>{
  const extra='https://cdn.publisher.test/extra.pdf';
  const env=setup({maxPolls:7,root:{html:documentHTML({body:'<a href="'+extra+'">PDF</a>'})},routes:{[FILE]:{resource:{success:false,httpStatusCode:403}},[extra]:{bytes:pdf()}},onPages(env){
    const root=env.pages.get('root');root.loaderId='reload-'+env.polls;root.documentTime=env.polls*100;
  }});
  await assert.rejects(env.acquire(),{name:'EdgeBrowserClosedError'});assert.deepEqual(env.requests.map(value=>value.url),[FILE]);
  assert.equal(env.opened.length,2);assert.equal(env.progress.filter(value=>value.state==='browser_downloading').length,1);
});

test('a known PDF URL showing an HTML page named PDF is not successful verification evidence',async()=>{
  const env=setup({routes:{[FILE]:{resource:{success:false,httpStatusCode:403}}},onCandidateOpen(_env,page){page.html='<html><head><title>PDF</title></head><body></body></html>';}});
  await assert.rejects(env.acquire(),{name:'EdgeBrowserClosedError'});assert.equal(env.requests.length,1);
});

test('a matching article completion must be stable and fully loaded before requests resume',async()=>{
  const final='https://cdn.publisher.test/final-verified.pdf';
  const env=setup({maxPolls:8,routes:{[FILE]:{resource:{success:false,httpStatusCode:403}},[final]:{bytes:pdf()}},onPages(env){
    const page=env.pages.get('created-2');if(!page)return;
    if(env.polls===2){page.html=documentHTML({file:final});page.readyState='loading';}
    if(env.polls===3){page.html='<html><body>Verifying</body></html>';page.readyState='complete';}
    if(env.polls===4){page.html=documentHTML({file:final});page.loaderId='complete';}
  }});
  assert.equal((await env.acquire()).source,'edge_browser');assert.deepEqual(env.requests.map(value=>value.poll),[1,5]);
  assert.equal(env.requests[1].url,final);
});

test('a verified completion article may retain generic institutional login text',async()=>{
  const final='https://cdn.publisher.test/accessible-after-verification.pdf';
  const env=setup({routes:{[FILE]:{resource:{success:false,httpStatusCode:403}},[final]:{bytes:pdf()}},onPages(env){
    if(env.polls===3)env.pages.get('created-2').html=documentHTML({file:final,body:'Access through your institution'});
  }});
  assert.equal((await env.acquire()).source,'edge_browser');assert.deepEqual(env.requests.map(value=>value.url),[FILE,final]);
  assert.equal(env.requests[1].poll,4);
});

test('an unchanged positive article cannot repeatedly unlock a PDF that still returns 403',async()=>{
  const env=setup({maxPolls:9,routes:{[FILE]:{resource:{success:false,httpStatusCode:403}}},onPages(env){
    const page=env.pages.get('created-2');if(page&&env.polls>=3){page.html=documentHTML();if(env.polls>=6)page.loaderId='reload-'+env.polls;}
  }});
  await assert.rejects(env.acquire(),{name:'EdgeBrowserClosedError'});
  assert.deepEqual(env.requests.map(value=>value.poll),[1,4]);assert.equal(env.opened.length,2);
});

test('challenge DOM remains a hold even when its visible instruction text disappears',async()=>{
  const env=setup({root:{html:documentHTML({body:'<div id="challenge-stage"></div>'})}});
  await assert.rejects(env.acquire(),{name:'EdgeBrowserClosedError'});assert.equal(env.requests.length,0);
});

test('an unrelated DOI or unrelated PDF MIME cannot release a candidate hold',async()=>{
  const env=setup({routes:{[FILE]:{resource:{success:false,httpStatusCode:403}}},onPages(env){
    const page=env.pages.get('created-2');if(!page)return;
    if(env.polls===2)page.html=documentHTML({doi:'10.1234/other'});
    if(env.polls===4){page.url='https://cdn.publisher.test/unrelated.pdf';page.html='<html></html>';page.contentType='application/pdf';}
  }});
  await assert.rejects(env.acquire(),{name:'EdgeBrowserClosedError'});assert.equal(env.requests.length,1);
});

test('a stale CDP session fails explicitly instead of polling the invalid session forever',async()=>{
  const env=setup({onSend(_env,{method}){if(method==='Runtime.evaluate'){const error=new Error('Redacted protocol error');error.name='EdgeProtocolError';error.code=-32000;throw error;}}});
  await assert.rejects(env.acquire(),{name:'EdgeSessionError',message:/连接或协议调用已失效/});
  assert.equal(env.calls.filter(value=>value.method==='Runtime.evaluate').length,1);assert.equal(env.polls,1);assert.equal(env.requests.length,0);
  assert.equal(env.calls.filter(value=>value.method==='Page.getFrameTree').length,2);
});

test('a destroyed execution context during a proven navigation waits for the new document',async()=>{
  let failed=false;
  const env=setup({onSend(env,{method}){if(method==='Runtime.evaluate'&&!failed){
    failed=true;const page=env.pages.get('root');page.url='https://publisher.test/articles/redirected';page.loaderId='after-login';page.documentTime=200;
    const error=new Error('Redacted protocol error');error.name='EdgeProtocolError';error.code=-32000;throw error;
  }}});
  assert.equal((await env.acquire()).source,'edge_browser');assert.equal(env.requests.length,1);assert.equal(env.requests[0].poll,2);
  assert.equal(env.opened.length,1);assert(!env.calls.some(value=>value.method==='Page.navigate'));
});

test('a failed frame probe after a Runtime protocol error ends instead of retrying the session',async()=>{
  let runtimeFailed=false;
  const env=setup({onSend(_env,{method}){
    if(method==='Runtime.evaluate'){runtimeFailed=true;const error=new Error('Redacted');error.name='EdgeProtocolError';throw error;}
    if(method==='Page.getFrameTree'&&runtimeFailed){const error=new Error('Redacted');error.name='EdgeProtocolError';throw error;}
  }});
  await assert.rejects(env.acquire(),{name:'EdgeSessionError'});assert.equal(env.polls,1);assert.equal(env.requests.length,0);
  assert.equal(env.calls.filter(value=>value.method==='Runtime.evaluate').length,1);
});

test('a detached target session and a CDP timeout both end with a clear retry error',async()=>{
  const detached=setup({onPages(env){env.emit({method:'Target.detachedFromTarget',params:{sessionId:'session-root'}});}});
  await assert.rejects(detached.acquire(),{name:'EdgeSessionError'});assert.equal(detached.requests.length,0);
  const timeout=setup({onSend(_env,{method}){if(method==='Page.getFrameTree'){const error=new Error('timeout');error.name='EdgeTimeoutError';throw error;}}});
  await assert.rejects(timeout.acquire(),{name:'EdgeSessionError',message:/响应超时/});assert.equal(timeout.polls,1);
});

test('navigating to another article during a PDF read discards the bytes',async()=>{
  const env=setup({routes:{[FILE]:{bytes:pdf(),onRead(env){const root=env.pages.get('root');root.url='https://publisher.test/articles/other';root.loaderId='different';root.documentTime=200;root.html=documentHTML({doi:'10.1234/other'});}}}});
  await assert.rejects(env.acquire(),{name:'EdgeBrowserClosedError'});assert.equal(env.requests.length,1);assert.equal(env.streams.size,0);
});

test('a navigation event during a stream read discards it before the next page scan',async()=>{
  const env=setup({routes:{[FILE]:{bytes:pdf(),onRead(env){env.emit({method:'Page.frameNavigated',sessionId:'session-root',params:{frame:{id:'frame-root'}}});env.pages.get('root').html=documentHTML({doi:'10.1234/other'});}}}});
  await assert.rejects(env.acquire(),{name:'EdgeBrowserClosedError'});assert.equal(env.streams.size,0);
});

test('an exact previously verified PDF popup may be read without article metadata',async()=>{
  let count=0;
  const env=setup({routes:{[FILE]:()=>++count===1?{resource:{success:false,httpStatusCode:403}}:{bytes:pdf()}},onPages(env){if(env.polls===2)env.pages.set('pdf',{id:'pdf',openerId:'root',url:FILE,loaderId:'pdf',documentTime:2,contentType:'application/pdf',html:'<html><head><title>PDF</title></head><body></body></html>'});}});
  assert.equal((await env.acquire()).source,'edge_browser');assert.equal(env.requests.length,2);assert.equal(env.requests[1].sessionId,'session-pdf');
});

test('an unrelated PDF popup has no inherited permission merely because it has an opener',async()=>{
  const env=setup({root:{html:documentHTML({file:''})},onOpen(env){env.pages.set('pdf',{id:'pdf',openerId:'root',url:'https://cdn.test/other.pdf',loaderId:'pdf',documentTime:2,html:'<html><body>PDF</body></html>'});}});
  await assert.rejects(env.acquire(),{name:'EdgeBrowserClosedError'});assert.equal(env.requests.length,0);
});

test('body snapshots expose only gate flags and article metadata, not form values or account text',async()=>{
  const secret='private-user-value-12345';
  const env=setup({root:{html:documentHTML({body:'<div>'+secret+'</div><input type="password" value="'+secret+'"><script>window.secret="'+secret+'";</script>'})}});
  await env.acquire();assert(!JSON.stringify(env.evaluations).includes(secret));
  const expressions=env.calls.filter(value=>value.method==='Runtime.evaluate').map(value=>value.params.expression);
  assert(expressions.every(value=>!/(?:document\.cookie|localStorage|sessionStorage|\.value\b|\.click\(|fetch\()/i.test(value)));
});

test('supplements and reference PDFs are excluded while the main download remains usable',async()=>{
  const body='<section id="references"><a href="https://cdn.test/reference.pdf">PDF</a></section><a href="https://cdn.test/supplement.pdf">Supplementary PDF</a><a href="'+FILE+'">Download PDF</a>';
  const env=setup({root:{html:documentHTML({file:'',body})}});await env.acquire();
  assert.deepEqual(env.requests.map(value=>value.url),[FILE]);
});

test('HTML and truncated PDFs are never returned as a successful import',async()=>{
  const env=setup({routes:{[FILE]:{html:'<!doctype html><html><body>Sign in to download</body></html>'}}});
  await assert.rejects(env.acquire(),{name:'EdgeBrowserClosedError'});assert.equal(env.streams.size,0);
  const partial=setup({routes:{[FILE]:{bytes:new TextEncoder().encode('%PDF-1.7\n'+'x'.repeat(1300))}}});
  await assert.rejects(partial.acquire(),{name:'EdgeBrowserClosedError'});assert.equal(partial.streams.size,0);
});

test('a one-layer PDF intermediary needs its own matching identity',async()=>{
  const second='https://cdn.publisher.test/final.pdf';
  const env=setup({routes:{[FILE]:{html:documentHTML({file:second})},[second]:{bytes:pdf()}}});
  assert.equal((await env.acquire()).source,'edge_browser');assert.deepEqual(env.requests.map(value=>value.url),[FILE,second]);
  const wrong=setup({routes:{[FILE]:{html:documentHTML({doi:'10.1234/other',file:second})},[second]:{bytes:pdf()}}});
  await assert.rejects(wrong.acquire(),{name:'EdgeBrowserClosedError'});assert.deepEqual(wrong.requests.map(value=>value.url),[FILE]);
});

test('oversize content is rejected before reading and its stream is closed',async()=>{
  const env=setup({routes:{[FILE]:{bytes:pdf(),headers:{'Content-Length':String(100*1024*1024+1)}}}});
  await assert.rejects(env.acquire(),{name:'EdgePDFSizeError'});assert.equal(env.streams.size,0);assert(!env.calls.some(value=>value.method==='IO.read'));
});

test('cancelling during a pending stream read exits promptly and closes the stream',async()=>{
  const env=setup({onSend(env,{method}){if(method==='IO.read'){env.cancelled=true;return new Promise(()=>{});}}});
  await assert.rejects(env.acquire(),{name:'AbortError'});assert.equal(env.streams.size,0);assert.equal(env.listeners.size,0);
});

test('a stream received after cancellation is still closed and never returned',async()=>{
  let finish;
  const env=setup({onSend(env,{method}){if(method==='Network.loadNetworkResource'){env.cancelled=true;return new Promise(resolve=>{finish=resolve;});}}});
  await assert.rejects(env.acquire(),{name:'AbortError'});
  finish({resource:{success:true,stream:'late-stream'}});await new Promise(resolve=>setImmediate(resolve));
  assert(env.streamCloses.some(value=>value.handle==='late-stream'&&value.sessionId==='session-root'));
});

test('cancellation racing with a fulfilled network response still closes that response stream',async()=>{
  const env=setup({onSend(env,{method}){if(method==='Network.loadNetworkResource')return Promise.resolve().then(()=>{
    queueMicrotask(()=>{env.cancelled=true;});return{resource:{success:true,stream:'racing-stream'}};
  });}});
  await assert.rejects(env.acquire(),{name:'AbortError'});await new Promise(resolve=>setImmediate(resolve));
  assert(env.streamCloses.some(value=>value.handle==='racing-stream'&&value.sessionId==='session-root'));
});

test('browser closure and the 15-minute wait limit produce explicit errors',async()=>{
  const closed=setup({maxPolls:0});await assert.rejects(closed.acquire(),{name:'EdgeBrowserClosedError'});
  const timeout=setup({root:{html:documentHTML({body:'Verify that you are human'})},maxPolls:Infinity,pollAdvance:900001});
  await assert.rejects(timeout.acquire(),{name:'EdgeWaitTimeout'});assert.equal(timeout.requests.length,0);
});

test('task acquisition coalesces, focus targets its own page, and explicit cancellation is honored',async()=>{
  const env=setup();const one=env.acquire(),two=env.acquire();assert.equal(one,two);await one;
  assert.equal(env.opened.length,1);assert.equal(await env.worker.focus('task1'),true);assert.deepEqual(env.focused,['root']);assert.equal(await env.worker.focus('other'),false);
  const cancelled=setup({root:{html:documentHTML({body:'Verify that you are human'})},onProgress(env,info){if(info.message.includes('手动完成验证码'))env.worker.cancel('task1');}});
  await assert.rejects(cancelled.acquire(),{name:'AbortError'});assert.equal(cancelled.requests.length,0);
});

test('a public article cannot pivot into local services, while an explicit local article may fetch its same origin',async()=>{
  const blocked=setup({root:{html:documentHTML({file:'http://127.0.0.1:8765/private.pdf'})}});
  await assert.rejects(blocked.acquire(),{name:'EdgeBrowserClosedError'});assert.equal(blocked.requests.length,0);
  const localURL='http://127.0.0.1:8765/article',localPDF='http://127.0.0.1:8765/paper.pdf';
  const local=setup({task:{officialURL:localURL},root:{url:localURL,html:documentHTML({file:localPDF})},routes:{[localPDF]:{bytes:pdf()}}});
  assert.equal((await local.acquire()).source,'edge_browser');assert.equal(local.opened[0],localURL);
  const other=setup({task:{officialURL:localURL},root:{url:localURL,html:documentHTML({file:'http://127.0.0.1:9876/private.pdf'})}});
  await assert.rejects(other.acquire(),{name:'EdgeBrowserClosedError'});assert.equal(other.requests.length,0);
});

test('existing assistance requests cannot enter publisher Edge acquisition',async()=>{
  const env=setup({task:{requestID:'owned-existing'}});await assert.rejects(env.acquire(),/已有科研通求助/);assert.equal(env.opened.length,0);
});
