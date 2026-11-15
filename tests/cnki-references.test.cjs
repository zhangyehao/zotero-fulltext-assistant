const test = require('node:test');
const assert = require('node:assert/strict');
const {parseHTML} = require('linkedom');
const references = require('../src/cnki-references.js');
const base = 'https://www.cnki.com.cn/Article/CJFDTOTAL-SYNTH202401001.htm';
const jsonURL = 'https://www.cnki.com.cn/cnkispace/cjfd/references/ref.html?fileName=0123456789ABCDEF';
const page = body => parseHTML('<html><head><title>合成文章页</title></head><body>' + body + '</body></html>').document;
const parse = body => references.parse(page(body), base);
const paper = 'https://www.cnki.com.cn/Article/CJFDTOTAL-REF202201001.htm';
function legacy(code = 'CJFD', rows = '<tr><td>1</td><td>张三;李四;<a href="' + paper + '">可靠的参考文献题名</a>[J];合成期刊;2022年01期</td></tr>', count = '前1条') {
  return '<table id="tbReferences' + code + '"><tr><td><span id="tbReferences' + code + 'Num">' + count + '</span><table><tbody id="tbReferences' + code + 'Body">' + rows + '</tbody></table></td></tr></table>';
}
function declaration(token = '0123456789ABCDEF', path = '/cnkispace/cjfd/references/ref.html') {
  return '<script>function fetchReferences(){ $.get("' + path + '",{fileName:"' + token + '"},function(data){if(data.refarticles.references){}}); }</script>';
}

test('official rendered references preserve explicit title, author text, year and stable URL', () => {
  const result = parse(legacy());
  assert.equal(result.status, 'partial'); assert.equal(result.complete, false); assert.equal(result.partial, true);
  assert.equal(result.totalCount, null); assert.equal(result.visibleCount, 1); assert.equal(result.groups[0].id, 'CJFD');
  const ref = result.references[0];
  assert.equal(ref.title, '可靠的参考文献题名'); assert.equal(ref.authorText, '张三;李四'); assert.deepEqual(ref.authors, []);
  assert.equal(ref.year, '2022'); assert.equal(ref.url, paper); assert.equal(ref.record.id, 'CNKI:CJFD:REF202201001');
  assert.equal(ref.canImport, true); assert.match(ref.raw, /合成期刊/);
});

test('citing, secondary references, unrelated tables and hidden rows are not direct references', () => {
  const normal = legacy();
  const body = normal + normal.replaceAll('tbReferences', 'tbQuote') + normal.replaceAll('tbReferences', 'tbSecReferences')
    + '<table id="unrelated"><tr><td><a href="' + paper + '">无关推荐</a></td></tr></table>';
  assert.equal(parse(body).references.length, 1);
  assert.equal(parse(normal.replace('<table id=', '<table style="display:none" id=')).references.length, 0);
  assert.equal(parse(legacy('CJFD','<tr hidden><td><a href="' + paper + '">隐藏条目</a></td></tr>')).references.length, 0);
});

test('unstructured citations stay raw and are never converted into fabricated metadata', () => {
  const result = parse('<section id="references"><h2>参考文献</h2><ol><li>[1] Smith, A. One. A confusing title. 1999, 12:34.</li></ol></section>');
  assert.equal(result.references.length, 1);
  const ref = result.references[0];
  assert.equal(ref.title, ''); assert.deepEqual(ref.authors, []); assert.equal(ref.year, ''); assert.equal(ref.canImport, false);
  assert.match(ref.raw, /Smith/);
});

test('semantic fields preserve names without splitting guessed citation text', () => {
  const result = parse('<section class="reference-list"><h2>参考文献 共1条</h2><ol><li><span class="reference-title">明确字段标题</span><span itemprop="author">Smith A.</span><span itemprop="author">Li B.</span><time datetime="2020">2020</time><a href="https://doi.org/10.1234/example">DOI</a></li></ol></section>');
  const ref = result.references[0];
  assert.equal(ref.title, '明确字段标题'); assert.deepEqual(ref.authors, ['Smith A.', 'Li B.']); assert.equal(ref.year, '2020');
  assert.equal(ref.doi, '10.1234/example'); assert.equal(ref.canImport, true); assert.equal(result.totalCount, 1);
  assert.equal(result.complete, false);
});

test('conflicting DOI links disable import and link labels are not titles', () => {
  const result = parse('<section id="references"><ol><li><a href="'+paper+'">全文</a> DOI: 10.1234/a <a href="https://doi.org/10.1234/b">DOI</a></li></ol></section>');
  assert.equal(result.references[0].doi, ''); assert.equal(result.references[0].title, ''); assert.equal(result.references[0].canImport, false);
});

test('only declared same-origin literal reference request becomes a transient candidate', () => {
  const result = parse(declaration());
  assert.equal(result.status, 'page_declared'); assert.deepEqual(result.candidates, [{url:jsonURL,method:'GET',format:'cnki-references-json',transient:true}]);
  assert.equal(result.references.length, 0);
  for (const body of [declaration('secret<script>'), declaration('0123456789ABCDEF','/cnkispace/cjfd/quote/ref.html'),
    '<script>$.get("/cnkispace/cjfd/references/ref.html",{fileName:makeToken()},function(data){data.refarticles.references;});</script>']) assert.equal(parse(body).candidates.length, 0);
  assert.equal(references.parse(page(declaration()), 'https://kns.cnki.net/KCMS/detail/detail.aspx?filename=SYNTH&dbcode=CJFD').candidates.length, 0);
});

test('explicit reference pagination is bounded and rejects cross-origin and state-changing targets', () => {
  const links = ['https://attacker.example/references','https://kns.cnki.net/references','javascript:run()',
    'https://www.cnki.com.cn/delete/references','/references?action=delete','/references?token=private','/references?page=2'];
  const result = parse('<section id="references">'+links.map(href=>'<a href="'+href+'">更多参考文献</a>').join('')+'</section>');
  assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].url, 'https://www.cnki.com.cn/references?page=2');
  assert.equal(references.candidateURL(jsonURL+'&fileName=SECOND',base,'cnki-references-json'),null);
});

test('degraded official response does not claim zero references', () => {
  const result = references.parseResponse({error:200,msg:'检索降级',refarticles:null}, jsonURL);
  assert.equal(result.status,'unavailable'); assert.equal(result.totalCount,null); assert.equal(result.complete,false);
  assert.deepEqual(result.diagnostics,[{code:'service_degraded'}]);
});

test('official JSON grouping preserves verified fields and excludes other relation lists', () => {
  const result = references.parseResponse({error:200,refarticles:{references:{
    cjfdList:[{articleName:'正式题名',author:'张三;李四',year:'2022',fileName:'REF202201001',doi:'10.1234/ref'}],
    cmfdList:[{cnTitle:'学位论文题名',author:'王五',disYear:'2021',conferUintCode:'10255',fileName:'1021000001.nh'}]
  },quote:{cjfdList:[{articleName:'不能混入的引证文章'}]}}},jsonURL);
  assert.equal(result.references.length,2); assert.equal(result.groups.length,2); assert.equal(result.status,'partial');
  const journal=result.references[0], thesis=result.references[1];
  assert.equal(journal.authorText,'张三;李四'); assert.deepEqual(journal.authors,[]); assert.equal(journal.doi,'10.1234/ref');
  assert.equal(thesis.itemType,'thesis'); assert.equal(thesis.year,'2021'); assert.equal(thesis.record.id,'CNKI:CMFD:1021000001.NH');
  assert.equal(thesis.url,'https://cdmd.cnki.com.cn/Article/CDMD-10255-1021000001.htm');
  assert.equal(result.complete,false); assert.equal(result.totalCount,null);
});

test('malformed JSON metadata does not create executable links or pretend to be a title', () => {
  const result = references.parseResponse({error:200,refarticles:{references:{cjfdList:[{articleName:'<script>bad</script>',author:'某作者',year:'2024-01-01',fileName:'../private'}]}}},jsonURL);
  const ref=result.references[0];
  assert.equal(ref.title,''); assert.equal(ref.canImport,false); assert.equal(ref.year,''); assert.equal(ref.url,''); assert.equal(ref.record,null);
  assert.equal(references.parseResponse({},'https://attacker.example/references').status,'unsupported_url');
});

test('response and standalone page gates are distinguished', () => {
  assert.equal(parse('<h1>安全验证</h1><p>请完成安全验证</p>').status,'human_verification');
  assert.equal(parse('<p>请先登录后查看</p>').status,'login_required');
  assert.equal(parse('<p>机构未订购</p>').status,'access_denied');
  assert.equal(references.parseResponse({error:403,msg:'请登录'},jsonURL).status,'login_required');
  assert.equal(references.parseResponse({error:403,msg:'请输入验证码'},jsonURL).status,'human_verification');
  assert.equal(references.parseResponse({error:403,msg:'没有访问权限'},jsonURL).status,'access_denied');
});

test('article discussions of verification and reference text do not trigger a gate', () => {
  const result = parse('<h1>验证码识别技术研究</h1><div id="ChDivSummary">系统会显示请完成安全验证。</div>'+legacy());
  assert.equal(result.status,'partial');
});

test('a partial reference list retains readable rows and its own login gate', () => {
  const result=parse('<section id="references"><h2>参考文献（12）</h2><p>请登录后查看全部参考文献</p><ol><li><span class="reference-title">当前可见的可靠题名</span></li></ol></section>');
  assert.equal(result.status,'login_required'); assert.equal(result.gate,'login_required'); assert.equal(result.references.length,1);
  assert.equal(result.totalCount,12); assert.equal(result.partial,true); assert.equal(result.complete,false);
});

test('generic headings cannot sweep an entire page or related lists into references', () => {
  const result=parse('<h2>参考文献</h2><ul class="related"><li><a href="'+paper+'">推荐文章</a></li></ul>');
  assert.equal(result.references.length,0);
  const scoped=parse('<section id="references"><h2>参考文献</h2><ul class="related"><li><a href="'+paper+'">推荐文章</a></li></ul><ol><li>[1] 原始引文</li></ol></section>');
  assert.equal(scoped.references.length,1); assert.equal(scoped.references[0].title,'');
});

test('deduplication retains direct groups and merge does not mutate previous results', () => {
  const a=parse(legacy()), before=JSON.stringify(a);
  const b=parse(legacy());
  const merged=references.merge(a,b);
  assert.equal(merged.references.length,1); assert.equal(JSON.stringify(a),before); assert.equal(merged.complete,false);
  assert.equal(JSON.stringify(merged).includes('"_key"'),false);
});

test('size limits bound both reference records and candidate URLs', () => {
  const rows=Array.from({length:700},(_,i)=>'<li><span class="reference-title">独立明确题名 '+i+'</span></li>').join('');
  assert.equal(parse('<section id="references"><ol>'+rows+'</ol></section>').references.length,500);
  assert.equal(references.candidateURL('https://www.cnki.com.cn/references?a='+'x'.repeat(9000),base),null);
});

test('unknown or explicit zero counts are separate and neither claims universal coverage', () => {
  assert.equal(parse('<section id="references"><h2>参考文献</h2></section>').totalCount,null);
  const zero=parse('<section id="references"><h2>参考文献 共0条</h2></section>');
  assert.equal(zero.status,'empty'); assert.equal(zero.totalCount,0); assert.equal(zero.complete,false);
});

test('unsafe base URL and embedded foreign article URL cannot supply metadata links', () => {
  assert.equal(references.parse(page(legacy()),'http://www.cnki.com.cn/Article/A.htm').status,'unsupported_url');
  assert.equal(references.parse(page(legacy()),'https://user:pass@www.cnki.com.cn/Article/A.htm').status,'unsupported_url');
  const result=parse('<section id="references"><ol><li><a href="https://evil.example/Article/CJFDTOTAL-X.htm">伪造题名</a> 原始引文</li></ol></section>');
  assert.equal(result.references[0].url,''); assert.equal(result.references[0].title,''); assert.equal(result.references[0].canImport,false);
});
