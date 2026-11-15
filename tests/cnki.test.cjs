const test=require('node:test');
const assert=require('node:assert/strict');
const {parseHTML}=require('linkedom');
const cnki=require('../src/cnki.js');
const url='https://kns.cnki.net/KCMS/detail/detail.aspx?dbcode=CJFD&dbname=CJFDLAST2024&filename=TEST202401001';
const id='CNKI:CJFD:TEST202401001';
const title='合成文献的完整中文题名';
function doc(body='',head=''){return parseHTML('<html><head>'+head+'</head><body><h1>'+title+'</h1>'+body+'</body></html>').document;}
const parsed=(body='',options={})=>cnki.parsePage(doc(body),url,options);
const link='<a name="pdfDown" href="https://kns.cnki.net/download?filename=TEST202401001&amp;dbcode=CJFD&amp;opaque=temporary">PDF下载</a>';

test('legacy identifiers normalize without DOI and drop tracking or temporary keys',()=>{
 const value=cnki.normalizeRecord('http://kns.cnki.net/KCMS/detail/detail.aspx?DbCode=cjfd&FileName=test202401001&v=transient#fragment');
 assert.equal(value.id,id);assert.equal(value.filename,'TEST202401001');assert.equal(value.url,'https://kns.cnki.net/KCMS/detail/detail.aspx?dbcode=CJFD&filename=TEST202401001');
 assert.equal(cnki.pageURL('http://kns.cnki.net/KCMS/detail/detail.aspx?dbcode=CJFD&filename=TEST202401001').startsWith('https://'),true);
});
test('the official translator legacy CJFQ URL normalizes to one CJFD identity',()=>{
 // URL identity fields from Zotero translators/CNKI.js testCases[0].
 const legacy='https://kns.cnki.net/KCMS/detail/detail.aspx?dbcode=CJFQ&dbname=CJFDLAST2015&filename=SPZZ201412003';
 const normalized=cnki.normalizeRecord(legacy);
 assert.equal(normalized.id,'CNKI:CJFD:SPZZ201412003');assert.equal(normalized.dbcode,'CJFD');assert.equal(normalized.dbname,'CJFDLAST2015');
 assert.equal(normalized.url,legacy.replace('dbcode=CJFQ','dbcode=CJFD'));
 assert.equal(cnki.normalizeRecord('CNKI:CJFQ:SPZZ201412003').id,normalized.id);
 assert.equal(cnki.normalizeRecord('https://www.cnki.com.cn/Article/CJFDTOTAL-SPZZ201412003.htm').id,normalized.id);
 assert.equal(cnki.fromItem({getField:name=>({url:legacy,extra:'CNKI: CNKI:CJFD:SPZZ201412003'}[name]||'')}).id,normalized.id);
 const article=doc('<input id="hiddbcode" value="CJFD"><input id="hiddbname" value="CJFDLAST2015"><input id="hidfilename" value="SPZZ201412003"><a name="pdfDown" data-dbcode="CJFQ" data-fn="SPZZ201412003" href="https://download.cnki.net/file?dbcode=CJFQ&amp;filename=SPZZ201412003">PDF下载</a>');
 const parsed=cnki.parsePage(article,legacy,{expectedRecord:normalized});
 assert.equal(parsed.status,'pdf_available');assert.equal(parsed.record.id,normalized.id);assert.equal(parsed.candidates.length,1);
 assert.equal(cnki.classifyResponse({url:parsed.candidates[0].url,bytes:new TextEncoder().encode('%PDF-1.7\n')},{expectedRecord:normalized}).status,'pdf');
});
test('CJFQ alias equivalence does not relax any other database or filename conflicts',()=>{
 const legacy='https://kns.cnki.net/KCMS/detail/detail.aspx?dbcode=CJFQ&dbname=CJFDLAST2015&filename=SPZZ201412003';
 assert.equal(cnki.normalizeRecord(legacy+'&dbcode=CJFD').id,'CNKI:CJFD:SPZZ201412003');
 for(const address of [legacy.replace('CJFDLAST2015','CMFDLAST2015'),legacy.replace('dbcode=CJFQ','dbcode=CAPJ'),legacy+'&dbcode=CMFD',legacy+'&filename=OTHER'])assert.equal(cnki.normalizeRecord(address),null);
 const target=cnki.normalizeRecord(legacy);
 for(const code of ['CMFD','CDFD','CAPJ','CCJD'])assert.equal(cnki.classifyResponse({url:'https://download.cnki.net/file?dbcode='+code+'&filename=SPZZ201412003'},{expectedRecord:target}).status,'article_mismatch');
 assert.equal(cnki.parsePage(doc('<input id="hiddbcode" value="CMFD"><input id="hidfilename" value="SPZZ201412003">'),legacy).status,'article_mismatch');
});
test('numeric thesis names retain their .nh suffix',()=>{
 const value=cnki.normalizeRecord('https://kns.cnki.net/kcms/detail/detail.aspx?dbcode=CMFD&dbname=CMFDLAST2024&filename=1024123456.nh');
 assert.equal(value.id,'CNKI:CMFD:1024123456.NH');assert.equal(value.filename,'1024123456.NH');
});
test('public CDMD institution-thesis URLs never fabricate a standard download record',()=>{
 const address='https://cdmd.cnki.com.cn/Article/CDMD-10255-1024123456.htm';
 assert.equal(cnki.normalizeRecord(address),null);assert.equal(cnki.pageURL(address),address);
 const result=cnki.parsePage(doc(link),address);assert.equal(result.status,'record_unavailable');assert.equal(result.record,null);assert.equal(result.metadata.itemType,'thesis');assert.equal(result.candidates.length,0);
});
test('official public Article URLs contain stable database and filename identifiers',()=>{
 const value=cnki.normalizeRecord('https://www.cnki.com.cn/Article/CJFDTOTAL-TEST202401001.htm?utm_source=test');
 assert.equal(value.id,id);assert.equal(value.dbname,'CJFDTOTAL');assert.equal(value.url,'https://www.cnki.com.cn/Article/CJFDTOTAL-TEST202401001.htm');
});
test('opaque abstract URL is transient until document IDs are available',()=>{
 const address='https://oversea.cnki.net/kcms2/article/abstract?v=temporary-token&uniplatform=OVERSEA';
 assert.equal(cnki.normalizeRecord(address),null);assert.equal(cnki.safeArticleURL(address),null);assert.equal(cnki.pageURL(address),address);
 const result=cnki.parsePage(doc('<input id="hiddbcode" value="CJFD"><input id="hiddbname" value="CJFDLAST2024"><input id="hidfilename" value="TEST202401001">'+link),address);
 assert.equal(result.record.id,id);assert.equal(result.articleURL.includes('temporary-token'),false);assert.equal(result.status,'pdf_available');
});
test('standalone opaque page without a record is not silently bound to expected record',()=>{
 const result=cnki.parsePage(doc(link),'https://kns.cnki.net/kcms2/article/abstract?v=opaque',{expectedRecord:cnki.normalizeRecord(url),expectedTitle:title});
 assert.equal(result.status,'record_unavailable');assert.equal(result.candidates.length,0);assert.equal(result.record,null);
});
test('unsupported hosts, credentials, ports and non-article routes are rejected',()=>{
 for(const value of ['https://cnki.net.evil.example/KCMS/detail/detail.aspx?dbcode=CJFD&filename=A','https://user:secret@kns.cnki.net/KCMS/detail/detail.aspx?dbcode=CJFD&filename=A','https://kns.cnki.net:444/KCMS/detail/detail.aspx?dbcode=CJFD&filename=A','javascript:alert(1)','file:///tmp/cnki.html'])assert.equal(cnki.normalizeRecord(value),null);
 assert.equal(cnki.pageURL('https://kns.cnki.net/kns8s/defaultresult/index'),null);
 assert.equal(cnki.isCNKIURL('https://kns.cnki.net.evil.example'),false);
});
test('duplicate conflicting URL identity and inconsistent dbname fail closed',()=>{
 assert.equal(cnki.normalizeRecord(url+'&filename=OTHER'),null);
 assert.equal(cnki.normalizeRecord('https://kns.cnki.net/kcms/detail/detail.aspx?dbcode=CMFD&dbname=CJFD2024&filename=A'),null);
 assert.equal(cnki.normalizeRecord({dbcode:'CJFD',filename:'../other'}),null);
 assert.equal(cnki.normalizeRecord({dbcode:'CJFD',filename:'A',url}),null);
});
test('item url and explicit CNKI extra support DOI-less records and reject disagreement',()=>{
 const item=(url,extra)=>({getField:name=>({url,extra}[name]||'')});
 assert.equal(cnki.fromItem(item('','CNKI: '+id)).id,id);
 assert.equal(cnki.fromItem(item('','CNKI URL: '+url)).id,id);
 assert.equal(cnki.fromItem(item(url,'CNKI: CNKI:CJFD:OTHER')),null);
 assert.equal(cnki.fromItem(item('','CNKI URL: '+url+'\nCNKI: CNKI:CJFD:OTHER')),null);
 assert.equal(cnki.fromItem({...item(url,''),getExtraField:()=> 'CNKI:CJFD:OTHER'}),null);
 assert.equal(cnki.fromItem(item('https://example.org','Unrelated: '+id)),null);
});
test('response URLs with conflicting or wrong filenames are rejected before their bytes',()=>{
 for(const address of ['https://download.cnki.net/file?filename=OTHER','https://download.cnki.net/file?filename=TEST202401001&dbtype=CMFD','https://download.cnki.net/file?filename=TEST202401001&filename=OTHER']){
  assert.equal(cnki.classifyResponse({url:address,bytes:new TextEncoder().encode('%PDF-1.7\n')},{expectedRecord:id}).status,'article_mismatch');
 }
});
test('page hidden record cannot contradict the requested or expected record',()=>{
 assert.equal(parsed('<input id="hiddbcode" value="CJFD"><input id="hidfilename" value="OTHER">'+link).status,'article_mismatch');
 assert.equal(parsed(link,{expectedRecord:'CNKI:CJFD:OTHER'}).status,'article_mismatch');
 assert.equal(parsed('<input id="hiddbcode" value="CJFD"><input id="hidfilename" value="A"><input id="hidfilename" value="B">').status,'article_mismatch');
});
test('metadata reads article fields without h1 controls or script text',()=>{
 const d=parseHTML('<html><head><meta name="citation_doi" content="10.1234/test"><meta name="citation_author" content="张三"><meta name="citation_author" content="李四"><meta name="citation_journal_title" content="合成期刊"><meta name="citation_publication_date" content="2024-01-02"><meta name="citation_volume" content="4"><meta name="citation_issue" content="1"><meta name="citation_firstpage" content="11"><meta name="citation_lastpage" content="20"></head><body><div class="wx-tit"><h1><p class="title-one">'+title+'</p><span class="full-text">Chinese Full Text</span></h1></div><span id="ChDivSummary">合成摘要<script>not metadata</script></span>'+link+'</body></html>').document;
 const result=cnki.parsePage(d,url,{expectedTitle:title,expectedDOI:'10.1234/test'});
 assert.equal(result.status,'pdf_available');assert.equal(result.metadata.title,title);assert.equal(result.metadata.abstract,'合成摘要');assert.equal(result.metadata.doi,'10.1234/test');assert.deepEqual(result.metadata.authors,['张三','李四']);assert.equal(result.metadata.pages,'11-20');assert.equal(result.metadata.itemType,'journalArticle');
});
test('reliable title or DOI conflict suppresses all download candidates',()=>{
 assert.equal(parsed(link,{expectedTitle:'另一篇完全不同的文献'}).status,'article_mismatch');
 const r=cnki.parsePage(doc(link,'<meta name="citation_doi" content="10.1234/wrong">'),url,{expectedDOI:'10.1234/right'});
 assert.equal(r.status,'article_mismatch');assert.equal(r.candidates.length,0);
});
test('CNKI PDF anchors and thesis parts are candidates without rewriting URLs',()=>{
 const result=parsed(link+'<div id="DownLoadParts"><a href="https://download.cnki.net/current?opaque=other">全文 PDF</a></div>');
 assert.equal(result.status,'pdf_available');assert.equal(result.candidates.length,2);assert.equal(result.candidates[0].recordID,id);assert.equal(result.candidates[0].format,'pdf');assert.equal(result.candidates[0].url.includes('opaque=temporary'),true);assert.equal(result.record.url.includes('opaque'),false);
});
test('pay.cnki.net PDF buttons are purchase handoff, never candidates',()=>{
 const r=parsed('<a id="ty_pdf" data-fn="TEST202401001" data-dbcode="CJFD" href="https://pay.cnki.net/zscsdoc/download?filename=TEST202401001&amp;dbtype=CJFD&amp;dtype=pdf">PDF下载</a>');
 assert.equal(r.status,'purchase_required');assert.equal(r.candidates.length,0);
});
test('CAJ is distinct and never becomes PDF by label, query substitution, or extension',()=>{
 for(const markup of ['<a name="cajDown" href="https://kns.cnki.net/download?dtype=caj">CAJ下载</a>','<a name="pdfDown" href="https://kns.cnki.net/download?dtype=caj">PDF下载</a>','<a name="pdfDown" href="https://kns.cnki.net/a.caj">PDF下载</a>']){
  const r=parsed(markup);assert.equal(r.status,'caj_only');assert.equal(r.candidates.length,0);assert.equal(r.cajAvailable,true);
 }
});
test('off-site, plaintext, executable, referenced and wrong-record candidate URLs are rejected',()=>{
 const r=parsed('<a name="pdfDown" href="http://kns.cnki.net/file.pdf">PDF下载</a><a name="pdfDown" href="https://attacker.example/file.pdf">PDF下载</a><a name="pdfDown" href="javascript:download()">PDF下载</a><div class="references">'+link+'</div><a name="pdfDown" href="https://kns.cnki.net/download?filename=OTHER">PDF下载</a><a name="pdfDown" data-fn="OTHER" href="https://kns.cnki.net/download">PDF下载</a>');
 assert.equal(r.candidates.length,0);assert.equal(r.status,'metadata_only');assert.equal(r.diagnostics.length,2);
});
test('candidate collection is bounded and duplicates collapse',()=>{
 const r=parsed(link.repeat(5)+Array.from({length:20},(_,i)=>'<a name="pdfDown" href="https://kns.cnki.net/download?id='+i+'">PDF下载</a>').join(''));
 assert.equal(r.candidates.length,8);
});
test('login, verification and explicit access gates have separate states',()=>{
 assert.equal(parsed('<p>请先登录后下载</p>'+link).status,'login_required');
 assert.equal(parsed('<p>请输入验证码</p>'+link).status,'human_verification');
 assert.equal(parsed('<p>机构未订购</p>'+link).status,'access_denied');
 assert.equal(cnki.parsePage(doc(''),'https://login.cnki.net/login/').status,'login_required');
 assert.equal(parsed('<nav>请先登录</nav>'+link).status,'pdf_available');
});
test('missing or corrupted title does not become a verified article',()=>{
 assert.equal(cnki.parsePage(parseHTML('<html><body>'+link+'</body></html>').document,url).status,'metadata_unavailable');
 assert.equal(cnki.parsePage(parseHTML('<html><body><h1>�损坏题名</h1>'+link+'</body></html>').document,url).status,'metadata_unavailable');
});
test('ordinary papers about verification are not confused with challenge pages',()=>{
 const d=parseHTML('<html><body><h1>验证码识别与网络安全验证算法研究</h1><span id="ChDivSummary">系统会提示请输入验证码，本文讨论该提示。</span>'+link+'</body></html>').document;
 assert.equal(cnki.parsePage(d,url).status,'pdf_available');
});
test('response classification uses bytes and distinguishes denied, HTML, CAJ and unsafe redirects',()=>{
 const check=(value)=>cnki.classifyResponse({url:'https://kns.cnki.net/download',...value}).status;
 assert.equal(check({bytes:new TextEncoder().encode('%PDF-1.7\n'),contentType:'application/octet-stream'}),'pdf');
 assert.equal(check({bytes:new TextEncoder().encode('<html>login</html>'),contentType:'application/pdf'}),'html_response');
 assert.equal(check({bytes:new TextEncoder().encode('CAJ\0data'),contentType:'application/caj'}),'caj_only');
 assert.equal(check({status:401}),'login_required');assert.equal(check({status:403}),'access_denied');assert.equal(check({status:429}),'rate_limited');
 assert.equal(check({url:'https://pay.cnki.net/order'}),'purchase_required');assert.equal(check({url:'https://attacker.example/file.pdf'}),'unsafe_redirect');
 assert.equal(check({bytes:new TextEncoder().encode('binary')}),'invalid_pdf');
});
test('legacy GB bytes can be decoded despite an incorrect UTF-8 header',()=>{
 const bytes=Uint8Array.from([0x3c,0x68,0x31,0x3e,0xd6,0xd0,0xce,0xc4,0x3c,0x2f,0x68,0x31,0x3e]);
 assert.equal(cnki.decodeHTML(bytes,'text/html;charset=utf-8'),'<h1>中文</h1>');
 assert.equal(cnki.decodeHTML(new TextEncoder().encode('<h1>中文📄</h1>'),'text/html;charset=utf-8'),'<h1>中文📄</h1>');
});
test('search handoff provides the official page and no guessed result binding',()=>{
 assert.equal(cnki.searchURL(title),'https://kns.cnki.net/kns8s/defaultresult/index');
 assert.equal(cnki.fromItem({title,getField:()=>''}),null);
});

const readerIX='https://ix.cnki.net/read/article/readonline?appid=CRSP_BASIC_PSMC&dbcode=CAPJ&tablename=CAPJLAST&filename=SYNTH20260810001&fileSourceType=1';
const readerX='https://x.cnki.net/web/xmlRead/pdf.html?pageType=pdfweb&fileName=SYNTH20260810001&tableName=CAPJTOTAL&dbCode=CAPJ&fileSourceType=1&appId=CRSP_BASIC_PSMC';
test('official reader routes preserve their own stable URLs and reconcile table names',()=>{
 for(const address of [readerIX,readerX]){
  const value=cnki.normalizeRecord(address+'&topic=&taskId=&v=synthetic-transient&token=synthetic-transient#page=2');
  assert.equal(value.id,'CNKI:CAPJ:SYNTH20260810001');
  assert.equal(new URL(value.url).origin,new URL(address).origin);
  assert.equal(new URL(value.url).pathname,new URL(address).pathname);
  assert.equal(value.url.includes('synthetic-transient'),false);
  assert.equal(value.url.includes('taskId'),false);
  assert.equal(cnki.pageURL(address+'&token=synthetic-transient'),value.url);
  assert.deepEqual(cnki.normalizeRecord(value),value);
  assert.equal(cnki.normalizeInput(address).kind,'url');
  assert.equal(cnki.parsePage(doc(),address).record.id,value.id);
 }
 assert.equal(cnki.normalizeRecord(readerIX).dbname,'CAPJLAST');
 assert.equal(cnki.normalizeRecord(readerX).dbname,'CAPJTOTAL');
 assert.equal(cnki.normalizeRecord(readerIX+'&dbname=CAPJLAST').id,'CNKI:CAPJ:SYNTH20260810001');
});
test('reader input rejects unverified routes, routing values and conflicting table aliases',()=>{
 const invalid=[readerIX.replace('ix.cnki.net','kns.cnki.net'),readerIX.replace('/readonline','/readonline/'),readerX.replace('/xmlRead/','/xmlread/'),readerIX+'&dbname=CJFDTOTAL',readerIX+'&dbname=CAPJTOTAL',readerIX+'&dbcode=CJFD',readerIX+'&filename=OTHER',readerIX.replace('CAPJLAST','../CAPJLAST'),readerIX.replace('CRSP_BASIC_PSMC','OTHER_APP'),readerIX+'&appId=OTHER_APP',readerIX.replace('fileSourceType=1','fileSourceType=2'),readerX.replace('pdfweb','other'),readerX.replace('pageType=pdfweb&',''),readerIX.replace('&tablename=CAPJLAST','')];
 for(const address of invalid){assert.equal(cnki.normalizeRecord(address),null,address);assert.equal(cnki.pageURL(address),null,address);assert.equal(cnki.normalizeInput(address),null,address);}
});
test('a reader shell is never presented as verified article metadata',()=>{
 for(const html of ['<html><head><title>研学阅读</title></head><body><div id="app"></div></body></html>','<html><body><h1>研学阅读</h1></body></html>']){
  const result=cnki.parsePage(parseHTML(html).document,readerX);
  assert.equal(result.status,'metadata_unavailable');assert.equal(result.candidates.length,0);
 }
});
test('modern thesis fields retain the file suffix and keep the institution out of authors',()=>{
 const html='<html><body><div class="wx-tit"><h1>'+title+'</h1><h3 class="author" id="authorpart"><span><a href="https://kns.cnki.net/kcms2/author/detail?v=synthetic">合成作者</a></span></h3><h3 class="author"><span><a href="https://kns.cnki.net/kcms2/organ/detail?v=synthetic">合成研究大学</a></span></h3></div><input type="hidden" id="param-filename" value="1026123456.nh"><input type="hidden" id="paramdbcode" value="CDFD"><input type="hidden" id="paramresource" value="DISSERTATION"><a id="cajDown" name="cajDown" href="https://bar.cnki.net/bar/download/order?id=synthetic-pdf">PDF下载</a><a id="cajDown" name="cajDown" href="https://bar.cnki.net/bar/download/order?id=synthetic-caj">CAJ下载</a></body></html>';
 const result=cnki.parsePage(parseHTML(html).document,'https://kns.cnki.net/kcms2/article/abstract?v=synthetic-detail');
 assert.equal(result.record.id,'CNKI:CDFD:1026123456.NH');assert.equal(result.metadata.itemType,'thesis');assert.equal(result.metadata.university,'合成研究大学');assert.deepEqual(result.metadata.authors,['合成作者']);assert.equal(result.status,'pdf_available');assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].url,'https://bar.cnki.net/bar/download/order?id=synthetic-pdf');assert.equal(result.cajAvailable,true);assert.equal(result.articleURL.includes('synthetic-detail'),false);
});
test('author fallback excludes organization links and university is restricted to thesis metadata',()=>{
 const body='<div class="wx-tit"><h3 class="author"><a href="/kcms2/author/detail?v=synthetic">合成作者</a><a href="/kcms2/organ/detail?v=synthetic">合成研究大学</a></h3></div>';
 const journal=parsed(body);assert.deepEqual(journal.metadata.authors,['合成作者']);assert.equal(journal.metadata.university,'');
 const thesis=cnki.parsePage(doc(body),'https://kns.cnki.net/KCMS/detail/detail.aspx?dbcode=CMFD&filename=1026123456.nh');
 assert.equal(thesis.metadata.itemType,'thesis');assert.equal(thesis.metadata.university,'合成研究大学');assert.deepEqual(thesis.metadata.authors,['合成作者']);
});
test('modern and legacy hidden field aliases must agree, including id and name aliases',()=>{
 const opaque='https://kns.cnki.net/kcms2/article/abstract?v=synthetic';
 const base='<input id="param-filename" value="TEST202401001"><input id="paramdbcode" value="CJFD">';
 assert.equal(cnki.parsePage(doc(base+'<input id="hidfilename" value="test202401001"><input id="hiddbcode" value="CJFQ">'),opaque).record.id,id);
 assert.equal(cnki.parsePage(doc('<input id="unrelated" name="param-filename" value="TEST202401001"><input id="paramdbcode" value="CJFD">'),opaque).record.id,id);
 for(const extra of ['<input id="hidfilename" value="OTHER">','<input id="hiddbcode" value="CDFD">','<input id="unrelated" name="param-filename" value="OTHER">'])assert.equal(cnki.parsePage(doc(base+extra),opaque).status,'article_mismatch');
 assert.equal(parsed('<input id="paramdbcode" value="CDFD">').status,'article_mismatch');
 assert.equal(parsed('<input id="param-filename" value="OTHER">').status,'article_mismatch');
 assert.equal(parsed('<input id="param-filename" value="TEST202401001">').record.id,id);
});
test('an explicit PDF label wins over a shared cajDown marker but never a CAJ file or dtype',()=>{
 const address='https://bar.cnki.net/bar/download/order?id=synthetic';
 const pdf=parsed('<a id="cajDown" name="cajDown" href="'+address+'">PDF下载</a>');
 assert.equal(pdf.status,'pdf_available');assert.equal(pdf.candidates[0].url,address);assert.equal(pdf.cajAvailable,false);
 for(const href of [address+'&dtype=caj','https://bar.cnki.net/file.caj']){
  const result=parsed('<a id="cajDown" name="cajDown" href="'+href+'">PDF下载</a>');
  assert.equal(result.status,'caj_only');assert.equal(result.candidates.length,0);
 }
});
test('input normalization separates article URLs, whole DOIs and titles',()=>{
 const paperDOI='10.1234/d.cnki.synthetic.2026.000001';
 for(const value of [paperDOI.toUpperCase(),'DOI: '+paperDOI])assert.deepEqual(cnki.normalizeInput(value),{kind:'doi',value:paperDOI,doi:paperDOI,url:'https://doi.org/'+paperDOI});
 for(const value of ['https://doi.org/'+paperDOI,'https://www.chndoi.org/Resolution/Handler?doi='+paperDOI,'https://link.cnki.net/doi/'+paperDOI,'https://link.oversea.cnki.net/doi/'+paperDOI]){
  const result=cnki.normalizeInput(value);assert.equal(result.kind,'doi');assert.equal(result.doi,paperDOI);assert.equal(cnki.resolverURL(result.url).doi,paperDOI);
 }
 assert.deepEqual(cnki.normalizeInput('  '+title+'  '),{kind:'title',value:title,title});
 assert.equal(cnki.normalizeInput(url).kind,'url');
 assert.deepEqual(cnki.normalizeInput('Effects: a synthetic study'),{kind:'title',value:'Effects: a synthetic study',title:'Effects: a synthetic study'});
});
test('DOI resolvers reject spoofing, user info, unapproved routes and query injection',()=>{
 const d='10.1234/synthetic';
 const invalid=['http://doi.org/'+d,'https://dx.doi.org/'+d,'https://doi.org.evil.example/'+d,'https://user:secret@doi.org/'+d,'https://doi.org:444/'+d,'https://doi.org/'+d+'?redirect=https://evil.example','https://doi.org/'+d+'%0A','https://www.chndoi.org/Resolution/Other?doi='+d,'https://www.chndoi.org/Resolution/Handler?doi='+d+'&doi=10.1234/other','https://www.chndoi.org/Resolution/Handler?doi='+d+'&url=https://evil.example','https://link.cnki.net/DOI/'+d,'https://link.cnki.net/doi/'+d+'?v=opaque','https://link.cnki.net.evil.example/doi/'+d,'https://bar.cnki.net/bar/download/order?id=synthetic','https://kns.cnki.net/search','javascript:alert(1)','10.1234/invalid doi','10.1234/'];
 for(const value of invalid){assert.equal(cnki.resolverURL(value),null,value);assert.equal(cnki.normalizeInput(value),null,value);}
 assert.equal(cnki.normalizeInput(''),null);assert.equal(cnki.normalizeInput(title+'\n'+title),null);
});
function resolverDoc({paperDOI='10.1234/synthetic',links=['https://link.cnki.net/doi/10.1234/synthetic','https://link.oversea.cnki.net/doi/10.1234/synthetic'],extra=''}={}){
 return parseHTML('<html><body><div class="feedbackresult"><div class="fbHd">多重解析地址选择页面</div><div class="fbBd"><table><tr><td><label>题名：</label>'+title+'</td></tr><tr><td><label>作者：</label>合成作者甲；合成作者乙</td></tr><tr><td><label>出版机构：</label>合成研究大学</td></tr><tr><td><label>DOI码：</label>'+paperDOI+'</td></tr><tr><td><label>注册时间：</label>2026-11-02 10:57:11</td></tr>'+extra+'<tr><td>'+links.map(href=>'<a href="'+href+'">解析地址</a>').join('')+'</td></tr></table></div></div></body></html>').document;
}
test('official DOI selection page yields only explicit exactly matching CNKI links',()=>{
 const result=cnki.parseDOIResolver(resolverDoc({links:['https://link.cnki.net/doi/10.1234/synthetic','https://link.oversea.cnki.net/doi/10.1234/synthetic','https://link.cnki.net/doi/10.1234/other','https://evil.example/doi/10.1234/synthetic','https://link.cnki.net/doi/10.1234/synthetic']}),'https://www.chndoi.org/Resolution/Handler?doi=10.1234/synthetic','10.1234/synthetic');
 assert.deepEqual(result,{doi:'10.1234/synthetic',title,authors:['合成作者甲','合成作者乙'],links:['https://link.cnki.net/doi/10.1234/synthetic','https://link.oversea.cnki.net/doi/10.1234/synthetic']});
});
test('DOI selection requires request, page and link identities to agree',()=>{
 const address='https://www.chndoi.org/Resolution/Handler?doi=10.1234/synthetic';
 assert.equal(cnki.parseDOIResolver(resolverDoc(),address,''),null);
 assert.equal(cnki.parseDOIResolver(resolverDoc(),address,'10.1234/other'),null);
 assert.equal(cnki.parseDOIResolver(resolverDoc({paperDOI:'10.1234/other'}),address,'10.1234/synthetic'),null);
 assert.equal(cnki.parseDOIResolver(resolverDoc({extra:'<tr><td><label>DOI码：</label>10.1234/other</td></tr>'}),address,'10.1234/synthetic'),null);
 assert.equal(cnki.parseDOIResolver(resolverDoc({links:['https://link.cnki.net/doi/10.1234/other']}),address,'10.1234/synthetic'),null);
 assert.equal(cnki.parseDOIResolver(resolverDoc(),'https://doi.org/10.1234/synthetic','10.1234/synthetic'),null);
 assert.equal(cnki.parseDOIResolver(doc('<a href="https://link.cnki.net/doi/10.1234/synthetic">link</a>'),address,'10.1234/synthetic'),null);
});
