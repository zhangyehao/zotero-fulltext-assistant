const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {parseHTML} = require('linkedom');
const source = fs.readFileSync(path.join(__dirname, '../src/fulltext-sources.js'), 'utf8');
const DOI = '10.5555/source.test';
const OA = 'https://api.openalex.org/works/https://doi.org/' + encodeURIComponent(DOI) + '?select=id,doi,primary_location,best_oa_location,locations,has_content,content_urls';
const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=' + encodeURIComponent('DOI:"' + DOI + '"') + '&format=json&resultType=core&pageSize=3';
const CONVERTER = 'https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids=' + encodeURIComponent(DOI) + '&format=json&tool=zotero_fulltext_assistant';
const PMC = 'https://pmc-oa-opendata.s3.amazonaws.com';
const LIST = PMC + '/?list-type=2&prefix=metadata%2FPMC12345.&max-keys=10';
const CORE = 'https://api.core.ac.uk/v3/search/works/?q=' + encodeURIComponent('doi:"' + DOI + '"') + '&limit=5';
const S2 = 'https://api.semanticscholar.org/graph/v1/paper/' + encodeURIComponent('DOI:' + DOI) + '?fields=title,externalIds,openAccessPdf,isOpenAccess';
const CACHED = 'https://content.openalex.org/works/W123456789.pdf';
const plain = value => JSON.parse(JSON.stringify(value));
const body = value => ({body: JSON.stringify(value), headers: {'content-type': 'application/json'}});

function setup({providers = [], routes = {}, config = {}, keys = {}, resolveHost, reserveDownloadSlot, request, limits} = {}) {
  const scope = {URL, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer, setTimeout, clearTimeout};
  vm.runInNewContext(source, scope);
  const api = scope.FulltextSources, calls = [], reservations = [], waits = [], dns = [];
  const enabled = Object.fromEntries(['openalex','pmc','core','semanticScholar','custom'].map(name => [name, providers.includes(name)]));
  let settings = {...config, enabled: {...enabled, ...config.enabled}};
  const client = api.create({parseHTML, getSettings: () => settings, getAPIKey: async name => keys[name] || '', limits,
    delay: milliseconds => { waits.push(milliseconds); return new Promise(resolve => setTimeout(resolve, Math.min(milliseconds, 2))); },
    resolveHost: async host => { dns.push(host); return resolveHost ? resolveHost(host) : ['8.8.8.8']; },
    reserveDownloadSlot: async spec => { reservations.push(spec); return reserveDownloadSlot ? reserveDownloadSlot(spec) : true; },
    request: async spec => {
      calls.push(spec);
      let result;
      if (request) result = await request(spec);
      else {
        let fixture = routes[spec.url];
        if (Array.isArray(fixture)) fixture = fixture.shift();
        if (fixture === undefined) throw new Error('Missing fixture for ' + spec.url);
        result = typeof fixture === 'function' ? await fixture(spec) : fixture;
      }
      return {status: 200, responseURL: spec.url, ...result};
    }});
  return {api, client, calls, reservations, waits, dns, setSettings(value) {settings = value;}};
}

test('settings normalize bounded defaults without enabling custom or cached downloads', () => {
  const {api} = setup();
  const value = plain(api.normalizeSettings({enabled:{core:false,custom:'yes'},versionPreference:'bad',openalexDailyLimit:-1}));
  assert.equal(value.enabled.core, false); assert.equal(value.enabled.custom, false);
  assert.equal(value.enabled.openalex, true); assert.equal(value.enabled.publisher, true);
  assert.equal(value.versionPreference,'accepted'); assert.equal(value.openalexContentEnabled,false); assert.equal(value.openalexDailyLimit,100);
  assert.equal(api.normalizeSettings({openalexDailyLimit:0}).openalexDailyLimit,100);
  assert.equal(api.normalizeSettings({openalexDailyLimit:1000000}).openalexDailyLimit,100);
  assert.equal(api.normalizeSettings({openalexDailyLimit:1000}).openalexDailyLimit,1000);
  assert.equal(api.normalizeSettings(null).versionPreference,'accepted');
});

test('public URL guard rejects local/private, URL credentials, schemes and secret query parameters', () => {
  const {api} = setup();
  for (const url of ['http://example.org/a','file:///tmp/a','data:text/html,a','https://localhost/a','https://x.local/a','https://intranet/a',
    'https://127.0.0.1/a','https://127.1/a','https://2130706433/a','https://0x7f000001/a','https://10.1.1.1/a','https://172.16.0.1/a',
    'https://192.168.0.1/a','https://169.254.169.254/a','https://100.64.0.1/a','https://[::1]/a','https://[::ffff:7f00:1]/a',
    'https://[fc00::1]/a','https://user:pass@example.org/a','https://example.org:8443/a','https://example.org/a?api_key=secret']) assert.equal(api.safePublicURL(url),null,url);
  assert.equal(api.safePublicURL('https://EXAMPLE.org./a#page=2'),'https://example.org/a');
  assert.equal(api.safePublicURL('/file.pdf','https://example.org/article'),'https://example.org/file.pdf');
  assert.equal(api.safePublicURL('https://8.8.8.8/file.pdf'),'https://8.8.8.8/file.pdf');
  assert.equal(api.publicIP('2606:4700:4700::1111'),true);
});

test('templates split semicolons, deduplicate, cap and encode DOI without injecting query parameters', () => {
  const {api} = setup();
  const parsed = api.parseTemplates('https://one.example/find/{doi}; https://two.example/?doi={doi}; https://one.example/find/{doi};http://bad.example/{doi};https://{doi}.example/;https://bad.example/{title}');
  assert.equal(parsed.templates.length,2); assert.equal(parsed.diagnostics.length,3);
  const expanded = api.expandTemplate('https://two.example/?doi={doi}', '10.5555/a?x=y&z=q');
  assert.equal(new URL(expanded).searchParams.get('doi'),'10.5555/a?x=y&z=q'); assert.equal([...new URL(expanded).searchParams].length,1);
  assert.equal(api.expandTemplate('https://one.example/{doi}','invalid'),null);
  const capped=api.parseTemplates(Array.from({length:12},(_,i)=>'https://one.example/'+i+'/{doi}'));
  assert.equal(capped.templates.length,8); assert(capped.diagnostics.some(row=>row.code==='template_limit'));
});

test('templates require the DOI in a transmitted path or query rather than only in a fragment', () => {
  const {api}=setup(), doi='10.5555/article';
  for(const template of ['https://example.org/article#{doi}','https://example.org/article#?doi={doi}','https://example.org/article?view=full#doi={doi}']) {
    const parsed=api.parseTemplates(template);
    assert.equal(parsed.templates.length,0,template);
    assert.equal(parsed.diagnostics[0].code,'invalid_template',template);
    assert.equal(api.expandTemplate(template,doi),null,template);
  }
  for(const template of ['https://example.org/article/{doi}#view=full','https://example.org/article?doi={doi}#view=full','https://example.org/article/{doi}#{doi}']) {
    assert.equal(api.parseTemplates(template).templates.length,1,template);
    const expanded=new URL(api.expandTemplate(template,doi));
    assert.equal(expanded.hash,'',template);
    assert((expanded.pathname+expanded.search).includes(encodeURIComponent(doi)),template);
  }
});

test('generic credential query parameters are rejected while official signed storage URLs remain usable', () => {
  const {api}=setup();
  for(const name of ['key','secret','session','sessionid','sid','KEY','api_key','access_token']) {
    const url='https://custom.example/{doi}?'+name+'=sensitive';
    assert.equal(api.parseTemplates(url).templates.length,0,name);
    assert.equal(api.safePublicURL(url.replace('{doi}','paper.pdf')),null,name);
  }
  const signed='https://storage.example/paper.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=resource-signer&X-Amz-Signature=0123456789';
  assert.equal(api.safePublicURL(signed),signed);
});

test('manuscript filtering removes known lower versions and retains unknown as unknown', () => {
  const {api} = setup();
  assert.equal(api.version('acceptedVersion'),'accepted'); assert.equal(api.version('preprint'),'submitted');
  assert.equal(api.acceptsVersion('accepted','published'),false); assert.equal(api.acceptsVersion('submitted','accepted'),false);
  assert.equal(api.acceptsVersion('published','accepted'),true); assert.equal(api.acceptsVersion('unknown','published'),true);
  assert.equal(api.acceptsVersion('submitted','any'),true);
});

test('OpenAlex singleton metadata works without a key and filters preprint locations', async () => {
  const env=setup({providers:['openalex'],routes:{[OA]:body({doi:DOI,id:'https://openalex.org/W123456789',has_content:{pdf:true},content_urls:{pdf:CACHED},locations:[
    {is_oa:true,pdf_url:'https://repo.example/accepted.pdf',version:'acceptedVersion'},
    {is_oa:true,pdf_url:'https://repo.example/submitted.pdf',version:'submittedVersion'},
    {is_oa:false,pdf_url:'https://repo.example/closed.pdf',version:'publishedVersion'},
    {is_oa:true,pdf_url:'https://repo.example/unknown.pdf'}]})}});
  const result=await env.client.discover({doi:DOI});
  assert.deepEqual(Array.from(result.candidates,c=>c.url),['https://repo.example/accepted.pdf','https://repo.example/unknown.pdf']);
  assert(result.diagnostics.some(x=>x.code==='version_filtered')); assert(result.diagnostics.some(x=>x.code==='content_disabled'));
  assert.equal(env.calls[0].headers.Authorization,undefined); assert.equal(env.reservations.length,0);
});

test('OpenAlex cache candidate has no key and reserves quota only immediately before download', async () => {
  const env=setup({providers:['openalex'],config:{openalexContentEnabled:true},keys:{openalex:'oa-secret-key'},routes:{[OA]:body({doi:DOI,id:'https://openalex.org/W123456789',has_content:{pdf:true},content_urls:{pdf:CACHED}})}});
  const result=await env.client.discover(DOI),candidate=result.candidates[0];
  assert.equal(candidate.evidence,'openalex_cached_pdf'); assert.equal(candidate.version,'unknown');
  assert.equal(JSON.stringify(result).includes('oa-secret-key'),false); assert.equal(env.reservations.length,0);
  const spec=await env.client.prepareRequest(candidate);
  assert.equal(spec.url,CACHED); assert.equal(spec.headers.Authorization,'Bearer oa-secret-key'); assert.equal(spec.followRedirects,false); assert.equal(spec.anon,true);
  assert.equal(env.reservations.length,1); assert.equal(env.reservations[0].limit,100); assert.equal(env.reservations[0].key,'oa-secret-key');
});

test('OpenAlex cache requires has_content.pdf, matching work ID, enabled content and a key', async () => {
  for (const fixture of [
    {has_content:{pdf:false},content_urls:{pdf:CACHED}},
    {has_fulltext:true,content_urls:{pdf:CACHED}},
    {has_content:{pdf:true},content_urls:{pdf:'https://evil.example/works/W123456789.pdf'}},
    {has_content:{pdf:true},content_urls:{pdf:'https://content.openalex.org/works/W999999.pdf'}},
  ]) {
    const env=setup({providers:['openalex'],config:{openalexContentEnabled:true},keys:{openalex:'oa-secret-key'},routes:{[OA]:body({doi:DOI,id:'https://openalex.org/W123456789',...fixture})}});
    assert.equal((await env.client.discover(DOI)).candidates.length,0);
  }
  const noKey=setup({providers:['openalex'],config:{openalexContentEnabled:true},routes:{[OA]:body({doi:DOI,id:'https://openalex.org/W123456789',has_content:{pdf:true},content_urls:{pdf:CACHED}})}});
  assert((await noKey.client.discover(DOI)).diagnostics.some(x=>x.code==='key_required'));
});

test('cache quota exhaustion stops before returning a credential-bearing request', async () => {
  const env=setup({providers:['openalex'],config:{openalexContentEnabled:true},keys:{openalex:'oa-secret-key'},reserveDownloadSlot:()=>false});
  await assert.rejects(env.client.prepareRequest({url:CACHED,source:'openalex',evidence:'openalex_cached_pdf',version:'unknown',credentialScope:'openalex'}),e=>e.code==='daily_limit');
  assert.equal(env.calls.length,0); assert.equal(env.reservations.length,1);
});

test('quota store failures cannot expose a key in thrown error messages', async () => {
  const env=setup({providers:['openalex'],config:{openalexContentEnabled:true},keys:{openalex:'oa-secret-key'},reserveDownloadSlot:()=>{throw new Error('storage oa-secret-key');}});
  await assert.rejects(env.client.prepareRequest({url:CACHED,source:'openalex',evidence:'openalex_cached_pdf',version:'unknown',credentialScope:'openalex'}),e=>e.code==='daily_limit'&&!e.message.includes('oa-secret-key'));
});

test('native DNS adapter uses the current asyncResolve signature and address-record interface', async () => {
  const calls=[],iface={};
  const scope={URL,TextDecoder,TextEncoder,Uint8Array,ArrayBuffer,setTimeout,clearTimeout,Components:{interfaces:{nsIDNSAddrRecord:iface}},ChromeUtils:{generateQI:()=>()=>{}}};
  vm.runInNewContext(source,scope);
  const Services={tm:{currentThread:{}},dns:{asyncResolve(...args){
    calls.push(args);let used=false;
    args[4].onLookupComplete(null,{QueryInterface(value){assert.equal(value,iface);return{hasMore:()=>!used,getNextAddrAsString(){used=true;return '8.8.8.8';}};}},0);
  }}};
  const client=scope.FulltextSources.create({Services});
  assert.equal(await client.validateURL('https://repo.example/file.pdf'),'https://repo.example/file.pdf');
  assert.equal(calls[0].length,7);assert.equal(calls[0][0],'repo.example');assert.equal(calls[0][5],Services.tm.currentThread);
});

test('credential scopes cannot be forged onto external URLs or custom templates', async () => {
  const env=setup({providers:['openalex','core','custom'],config:{openalexContentEnabled:true},keys:{openalex:'oa-secret-key',core:'core-secret-key'}});
  for(const candidate of [
    {url:'https://evil.example/a.pdf',source:'openalex',credentialScope:'openalex',evidence:'openalex_cached_pdf'},
    {url:CACHED,source:'custom',credentialScope:'openalex',evidence:'openalex_cached_pdf'},
    {url:'https://evil.example/a.pdf',source:'core',credentialScope:'core'},
    {url:'https://api.core.ac.uk/v3/search/works',source:'core',credentialScope:'core'},
    {url:'https://example.org/a.pdf',source:'custom',credentialScope:'semanticScholar'},
  ]) await assert.rejects(env.client.prepareRequest(candidate),e=>e.code==='unsafe_url');
  assert.equal(env.reservations.length,0); assert.equal(env.calls.length,0);
});

test('API DOI mismatch never emits an unrelated PDF candidate', async () => {
  const env=setup({providers:['openalex','semanticScholar','core'],routes:{
    [OA]:body({doi:'10.5555/wrong',locations:[{is_oa:true,pdf_url:'https://example.org/wrong.pdf'}]}),
    [S2]:body({externalIds:{DOI:'10.5555/wrong'},openAccessPdf:{url:'https://example.org/wrong.pdf'}}),
    [CORE]:body({results:[{doi:'10.5555/wrong',downloadUrl:'https://example.org/wrong.pdf'}]})}});
  const result=await env.client.discover(DOI); assert.equal(result.candidates.length,0);
  assert.equal(result.diagnostics.filter(x=>x.code==='doi_mismatch').length,3);
});

test('PMC uses current official datasets and actual metadata PDF URL, excluding supplementary PDFs', async () => {
  const env=setup({providers:['pmc'],routes:{
    [EPMC]:body({resultList:{result:[{doi:DOI,pmcid:'PMC12345',fullTextUrlList:{fullTextUrl:[
      {availabilityCode:'OA',documentStyle:'pdf',url:'https://europepmc.org/articles/PMC12345?pdf=render'},
      {availabilityCode:'S',documentStyle:'pdf',url:'https://publisher.example/closed.pdf'}]}}]}}),
    [LIST]:{body:'<ListBucketResult><Contents><Key>metadata/PMC12345.2.json</Key></Contents></ListBucketResult>'},
    [PMC+'/metadata/PMC12345.2.json']:body({pmcid:'PMC12345',doi:DOI,version:2,is_manuscript:false,license_code:'CC BY',pdf_url:'s3://pmc-oa-opendata/PMC12345.2/article.pdf?md5=abc',media_urls:['s3://pmc-oa-opendata/PMC12345.2/supplement.pdf']})}});
  const result=await env.client.discover(DOI);
  assert.equal(result.candidates.length,2); const direct=result.candidates.find(c=>c.evidence==='pmc_article_dataset_pdf');
  assert.equal(direct.url,PMC+'/PMC12345.2/article.pdf?md5=abc'); assert.equal(direct.version,'published'); assert.equal(direct.license,'CC BY');
  assert.equal(env.calls.some(c=>c.url.includes('oa.fcgi')),false); assert.equal(result.candidates.some(c=>c.url.includes('supplement')),false);
});

test('PMC can map a DOI using official ID converter when Europe PMC finds no record', async () => {
  const env=setup({providers:['pmc'],routes:{
    [EPMC]:body({resultList:{result:[]}}),[CONVERTER]:body({records:[{doi:DOI,pmcid:'PMC12345'}]}),
    [LIST]:{body:'<Key>metadata/PMC12345.1.json</Key>'},
    [PMC+'/metadata/PMC12345.1.json']:body({pmcid:'PMC12345',doi:DOI,is_manuscript:true,pdf_url:'s3://pmc-oa-opendata/PMC12345.1/ms.pdf'})}});
  const result=await env.client.discover(DOI); assert.equal(result.candidates.length,1); assert.equal(result.candidates[0].version,'accepted');
});

test('PMCID input without DOI uses current metadata while avoiding other providers', async () => {
  const epmc='https://www.ebi.ac.uk/europepmc/webservices/rest/search?query='+encodeURIComponent('EXT_ID:"PMC12345" AND SRC:PMC')+'&format=json&resultType=core&pageSize=3';
  const env=setup({providers:['pmc','openalex','core','semanticScholar'],routes:{[epmc]:body({resultList:{result:[]}}),[LIST]:{body:'<Key>metadata/PMC12345.1.json</Key>'},
    [PMC+'/metadata/PMC12345.1.json']:body({pmcid:'PMC12345',is_manuscript:true,pdf_url:'s3://pmc-oa-opendata/PMC12345.1/ms.pdf'})}});
  const result=await env.client.discover({pmcid:'pmc12345'}); assert.equal(result.candidates.length,1); assert.equal(env.calls.length,3);
});

test('PMC retractions, DOI mismatch, XML-only and lower manuscript versions do not become PDFs', async () => {
  for(const variant of [
    {is_retracted:true,pdf_url:'s3://pmc-oa-opendata/PMC12345.1/article.pdf'},
    {doi:'10.5555/wrong',pdf_url:'s3://pmc-oa-opendata/PMC12345.1/article.pdf'},
    {xml_url:'s3://pmc-oa-opendata/PMC12345.1/article.xml'},
    {is_manuscript:true,pdf_url:'s3://pmc-oa-opendata/PMC12345.1/article.pdf'},
    {pdf_url:'https://evil.example/PMC12345.pdf'},
  ]) {
    const env=setup({providers:['pmc'],config:{versionPreference:'published'},routes:{[EPMC]:body({resultList:{result:[{doi:DOI,pmcid:'PMC12345'}]}}),[LIST]:{body:'<Key>metadata/PMC12345.1.json</Key>'},
      [PMC+'/metadata/PMC12345.1.json']:body({pmcid:'PMC12345',doi:DOI,is_manuscript:false,...variant})}});
    assert.equal((await env.client.discover(DOI)).candidates.length,0);
  }
});

test('Semantic Scholar is an external openAccessPdf link, never a hosted-cache claim', async () => {
  const env=setup({providers:['semanticScholar'],keys:{semanticScholar:'s2-private-key'},routes:{[S2]:body({externalIds:{DOI},openAccessPdf:{url:'https://publisher.example/paper.pdf',status:'HYBRID',license:'CCBY'}})}});
  const result=await env.client.discover(DOI),candidate=result.candidates[0];
  assert.equal(candidate.evidence,'semantic_scholar_open_access_link'); assert.equal(candidate.version,'unknown');
  assert(result.diagnostics.some(c=>c.code==='metadata_only')); assert.equal(env.calls[0].headers['x-api-key'],'s2-private-key');
  const spec=await env.client.prepareRequest(candidate); assert.equal(spec.headers['x-api-key'],undefined); assert.equal(spec.headers.Authorization,undefined);
  assert.equal(JSON.stringify(result).includes('s2-private-key'),false);
});

test('CORE permits anonymous metadata attempt and only uses matching downloadUrl, never fullText text', async () => {
  const env=setup({providers:['core'],routes:{[CORE]:body({results:[{doi:DOI,fullText:'Not PDF',downloadUrl:'https://repository.example/a.pdf'},{doi:DOI,fullText:'Other text'}]})}});
  const result=await env.client.discover(DOI); assert.equal(result.candidates.length,1); assert.equal(result.candidates[0].version,'unknown');
  assert.equal(env.calls[0].headers.Authorization,undefined); assert(result.diagnostics.some(c=>c.code==='metadata_only'));
});

test('CORE key is confined to its API, never an external repository download', async () => {
  const env=setup({providers:['core'],keys:{core:'core-private-key'},routes:{[CORE]:body({results:[
    {doi:DOI,downloadUrl:'https://api.core.ac.uk/v3/outputs/123/download'},
    {doi:DOI,downloadUrl:'https://repository.example/a.pdf'}]})}});
  const result=await env.client.discover(DOI); assert.equal(env.calls[0].headers.Authorization,'Bearer core-private-key');
  for(const candidate of result.candidates){const spec=await env.client.prepareRequest(candidate);assert.equal(spec.headers.Authorization,candidate.url.includes('api.core.ac.uk')?'Bearer core-private-key':undefined);assert.equal(spec.followRedirects,false);}
});

test('custom HTML supports PDF metadata, iframe, embed, object and anchor without JavaScript', async () => {
  const url='https://custom.example/find/'+encodeURIComponent(DOI);
  const markup='<meta name="citation_doi" content="'+DOI+'"><meta name="citation_pdf_url" content="/article.pdf"><iframe src="/viewer"></iframe><embed src="/embedded.pdf"><object data="/object.pdf"></object><a href="/download">Download PDF</a><iframe src="http://127.0.0.1/admin"></iframe><script>throw new Error("must never execute")</script>';
  const env=setup({providers:['custom'],config:{customTemplates:['https://custom.example/find/{doi}']},routes:{[url]:{body:markup}}});
  const result=await env.client.discover(DOI); assert.equal(result.candidates.length,5);
  assert(result.candidates.every(c=>c.source==='custom'&&c.version==='unknown')); assert(result.candidates.some(c=>c.kind==='page'));
  assert.equal(env.calls[0].anon,true); assert.equal(env.calls[0].followRedirects,false);
  assert.equal(env.calls[0].headers.Authorization,undefined); assert.equal(env.calls[0].headers.Cookie,undefined);
});

test('custom direct PDF is a candidate only; this module never imports or validates document identity', async () => {
  const url='https://custom.example/'+encodeURIComponent(DOI);
  const env=setup({providers:['custom'],config:{customTemplates:['https://custom.example/{doi}']},routes:{[url]:{body:'%PDF-1.7\nsynthetic'}}});
  const result=await env.client.discover(DOI); assert.equal(result.candidates[0].evidence,'custom_http_pdf'); assert.equal(result.candidates[0].url,url);
});

test('custom PDF Content-Type aborts discovery transfer after headers and preserves a candidate', async () => {
  const url='https://custom.example/'+encodeURIComponent(DOI);
  const env=setup({providers:['custom'],config:{customTemplates:['https://custom.example/{doi}']},request:async spec=>{
    let handler; const xhr={readyState:2,status:200,getResponseHeader:()=> 'application/pdf',addEventListener(name,fn){if(name==='readystatechange')handler=fn;},abort(){}};
    spec.requestObserver(xhr); handler(); throw new Error('Aborted after PDF headers');
  }});
  const result=await env.client.discover(DOI); assert.equal(result.candidates.length,1); assert.equal(result.candidates[0].url,url);
});

test('custom verification pages, login and explicit DOI conflict stop with precise diagnostics', async () => {
  const url='https://custom.example/'+encodeURIComponent(DOI);
  for(const [fixture,code] of [
    [{body:'<div class="g-recaptcha"></div><a href="/bad.pdf">PDF</a>'},'human_verification'],
    [{status:403,headers:{'cf-mitigated':'challenge'},body:'challenge'},'human_verification'],
    [{body:'<input type="password"><a href="/bad.pdf">PDF</a>'},'login_required'],
    [{body:'<meta name="citation_doi" content="10.5555/wrong"><a href="/bad.pdf">PDF</a>'},'doi_mismatch'],
  ]) {
    const env=setup({providers:['custom'],config:{customTemplates:['https://custom.example/{doi}']},routes:{[url]:fixture}});
    const result=await env.client.discover(DOI); assert.equal(result.candidates.length,0); assert(result.diagnostics.some(row=>row.code===code),code); assert.equal(env.calls.length,1);
  }
});

test('custom redirects are explicit, anonymous and revalidate destination DNS', async () => {
  const first='https://custom.example/'+encodeURIComponent(DOI),second='https://cdn.example/paper';
  const env=setup({providers:['custom'],config:{customTemplates:['https://custom.example/{doi}']},routes:{[first]:{status:302,headers:{location:second}},[second]:{body:'%PDF-1.7\n'}}});
  const result=await env.client.discover(DOI); assert.equal(result.candidates[0].url,second); assert.deepEqual(env.dns,['custom.example','cdn.example']);
  assert(env.calls.every(c=>c.anon&&c.followRedirects===false&&!c.headers.Authorization&&!c.headers.Cookie));
});

test('private redirect DNS stops before the second HTTP request', async () => {
  const first='https://custom.example/'+encodeURIComponent(DOI);
  const env=setup({providers:['custom'],config:{customTemplates:['https://custom.example/{doi}']},resolveHost:host=>host==='private.example'?['10.0.0.1']:['8.8.8.8'],routes:{[first]:{status:302,headers:{location:'https://private.example/private'}}}});
  const result=await env.client.discover(DOI); assert.equal(env.calls.length,1); assert.equal(result.candidates.length,0); assert(result.diagnostics.some(row=>row.code==='private_address'));
});

test('every API request refuses redirect rather than forwarding a source key', async () => {
  const env=setup({providers:['openalex'],keys:{openalex:'oa-private-key'},routes:{[OA]:{status:302,headers:{location:'https://evil.example/steal'}}}});
  const result=await env.client.discover(DOI); assert.equal(env.calls.length,1); assert.equal(result.candidates.length,0); assert(result.diagnostics.some(row=>row.code==='unexpected_redirect'));
});

test('unexpected transparent redirect in an injected transport is rejected', async () => {
  const env=setup({providers:['openalex'],routes:{[OA]:{...body({doi:DOI}),responseURL:'https://unexpected.example/result'}}});
  const result=await env.client.discover(DOI); assert(result.diagnostics.some(row=>row.code==='unexpected_redirect'));
});

test('DNS checks reject mixed public/private records and are repeated before actual download', async () => {
  let phase='public';
  const env=setup({providers:['semanticScholar'],resolveHost:host=>phase==='private'&&host==='repo.example'?['8.8.8.8','192.168.1.1']:['8.8.8.8'],routes:{[S2]:body({externalIds:{DOI},openAccessPdf:{url:'https://repo.example/paper.pdf'}})}});
  const result=await env.client.discover(DOI); phase='private';
  await assert.rejects(env.client.prepareRequest(result.candidates[0]),e=>e.code==='private_address');
});

test('429 retries once after bounded Retry-After and respects provider request pacing', async () => {
  const env=setup({providers:['semanticScholar'],routes:{[S2]:[{status:429,headers:{'retry-after':'1'}},body({externalIds:{DOI},openAccessPdf:{url:'https://repo.example/paper.pdf'}})]}});
  const result=await env.client.discover(DOI); assert.equal(result.candidates.length,1); assert.equal(env.calls.length,2); assert(env.waits.includes(1000));
  assert(env.calls.every(c=>c.noRetryOnThrottle===true&&c.errorDelayMax===0));
});

test('long Retry-After and repeated 429 do not spin or retry early', async () => {
  const long=setup({providers:['core'],routes:{[CORE]:{status:429,headers:{'retry-after':'120'}}}});
  assert((await long.client.discover(DOI)).diagnostics.some(row=>row.code==='rate_limited')); assert.equal(long.calls.length,1);
  const repeat=setup({providers:['core'],routes:{[CORE]:{status:429,headers:{'retry-after':'0'}}}});
  assert((await repeat.client.discover(DOI)).diagnostics.some(row=>row.code==='rate_limited')); assert.equal(repeat.calls.length,2);
});

test('response byte limits and progress guard abort before parsing oversized metadata', async () => {
  const env=setup({providers:['core'],limits:{maxMetadataBytes:32},routes:{[CORE]:{body:'x'.repeat(100)}}});
  assert((await env.client.discover(DOI)).diagnostics.some(row=>row.code==='response_too_large'));
  let aborted=false;
  const streaming=setup({providers:['core'],limits:{maxMetadataBytes:32},request:async spec=>{
    let progress;spec.requestObserver({addEventListener(name,fn){if(name==='progress')progress=fn;},abort(){aborted=true;}});progress({loaded:100});throw new Error('aborted');
  }});
  assert((await streaming.client.discover(DOI)).diagnostics.some(row=>row.code==='response_too_large')); assert.equal(aborted,true);
});

test('cancellation aborts pending HTTP and never accepts its late response', async () => {
  let cancelled=false,aborted=false,release;
  const env=setup({providers:['semanticScholar'],request:spec=>new Promise(resolve=>{release=resolve;spec.cancellerReceiver(()=>{aborted=true;});})});
  const pending=env.client.discover(DOI,{isCancelled:()=>cancelled});
  while(!release) await new Promise(resolve=>setTimeout(resolve,2)); cancelled=true;
  await assert.rejects(pending,e=>e.name==='AbortError'); assert.equal(aborted,true);
  release(body({externalIds:{DOI},openAccessPdf:{url:'https://repo.example/late.pdf'}}));
});

test('request timeout is bounded even when an injected transport ignores timeout options', async () => {
  let aborted=false;
  const env=setup({providers:['semanticScholar'],limits:{timeoutMs:20,providerTimeoutMs:40},request:spec=>{spec.cancellerReceiver(()=>{aborted=true;});return new Promise(()=>{});}});
  const started=Date.now(),result=await env.client.discover(DOI);
  assert(Date.now()-started<300); assert(result.diagnostics.some(row=>row.code==='timeout')); assert.equal(aborted,true);
});

test('pre-cancelled and invalid queries send no network requests', async () => {
  const env=setup({providers:['openalex']});
  await assert.rejects(env.client.discover(DOI,{isCancelled:()=>true}),e=>e.name==='AbortError');
  assert.equal((await env.client.discover({doi:'bad'})).diagnostics[0].code,'invalid_doi'); assert.equal(env.calls.length,0);
});

test('source failures and server-reflected key URLs never expose API secrets in diagnostics', async () => {
  const env=setup({providers:['openalex','semanticScholar'],keys:{openalex:'oa-private-key',semanticScholar:'s2-private-key'},routes:{
    [OA]:()=>{throw new Error('network https://x.example/?api_key=oa-private-key');},
    [S2]:body({externalIds:{DOI},openAccessPdf:{url:'https://evil.example/s2-private-key.pdf'}})}});
  const result=await env.client.discover(DOI),text=JSON.stringify(result);
  assert.equal(text.includes('private-key'),false); assert.equal(result.candidates.length,0); assert(result.diagnostics.some(row=>row.code==='unsafe_url'));
});

test('normal candidates are anonymous and recheck changed source and version settings', async () => {
  const env=setup({providers:['semanticScholar']});
  const candidate={source:'semanticScholar',url:'https://repo.example/paper.pdf',version:'accepted'};
  const spec=await env.client.prepareRequest(candidate); assert.equal(spec.anon,true); assert.equal(spec.followRedirects,false); assert.equal(spec.headers.Cookie,undefined);
  env.setSettings({enabled:{semanticScholar:false}}); await assert.rejects(env.client.prepareRequest(candidate),e=>e.code==='source_not_enabled');
  env.setSettings({enabled:{semanticScholar:true},versionPreference:'published'}); await assert.rejects(env.client.prepareRequest(candidate),e=>e.code==='version_filtered');
});

test('candidate count and duplicate URLs remain bounded across independent providers', async () => {
  const env=setup({providers:['openalex','core','semanticScholar'],limits:{maxCandidates:5},routes:{
    [OA]:body({doi:DOI,locations:Array.from({length:20},(_,i)=>({is_oa:true,pdf_url:'https://repo.example/'+i+'.pdf',version:'published'}))}),
    [CORE]:body({results:[{doi:DOI,downloadUrl:'https://repo.example/0.pdf'}]}),
    [S2]:body({externalIds:{DOI},openAccessPdf:{url:'https://repo.example/0.pdf'}})}});
  const result=await env.client.discover(DOI); assert.equal(result.candidates.length,5); assert.equal(new Set(result.candidates.map(row=>row.url)).size,5);
});
