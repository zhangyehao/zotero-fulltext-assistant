const test = require('node:test');
const assert = require('node:assert/strict');
const { create, MAX_PDF_BYTES } = require('../src/pdf-identity.js');

const DOI = '10.1093/scan/nsu132';
const TITLE = 'Neural representations of social values during human decision making';
const target = { doi: DOI, title: TITLE };
const inspect = (text, item = target) => create({ extractText: async () => ({ text, extractedPages: 2, totalPages: 8 }) }).inspect('fixture.pdf', item);

test('an explicit first-page article DOI matches without disclosing text or path', async () => {
  const r = await inspect('RESEARCH ARTICLE\n' + TITLE + '\nJane Smith\nDOI: ' + DOI + '\nAbstract\nBody text.');
  assert.equal(r.status, 'match'); assert.equal(r.matchedBy, 'doi');
  assert.deepEqual(r.detectedDOIs, [DOI]); assert.equal(r.detectedTitle, TITLE);
  assert.equal('text' in r, false); assert.equal('path' in r, false);
});
test('a different authoritative DOI rejects even an identical title', async () => {
  const r = await inspect(TITLE + '\nDOI: 10.1093/scan/wrong\nAbstract\nResearch.');
  assert.equal(r.status, 'mismatch'); assert.equal(r.reason, 'doi_mismatch');
});
test('a target DOI in references cannot override another article DOI', async () => {
  const r = await inspect('Another scientific article about brain structures and behavior\nDOI: 10.1234/other\nAbstract\nResearch.\nReferences\n1. ' + TITLE + '\nDOI: ' + DOI);
  assert.equal(r.status, 'mismatch'); assert.deepEqual(r.detectedDOIs, ['10.1234/other']);
});
test('a DOI and target title appearing only in references are unknown', async () => {
  const r = await inspect('Another scientific article about brain structures and behavior\nAbstract\nResearch.\nReferences\n' + TITLE + '\nDOI: ' + DOI);
  assert.equal(r.status, 'unknown'); assert.deepEqual(r.detectedDOIs, []);
});
test('numbered references without a heading do not provide article identity', async () => {
  const r = await inspect('Another scientific article about brain structures and behavior\n1. Smith et al. (2015). A cited paper\nhttps://doi.org/' + DOI);
  assert.equal(r.status, 'unknown'); assert.deepEqual(r.detectedDOIs, []);
});
test('a DOI embedded in a prose citation is not authoritative', async () => {
  const r = await inspect('Another scientific article about brain structures and behavior\nAbstract\nPrevious evidence is reported in doi: ' + DOI + '.');
  assert.equal(r.status, 'unknown');
});
test('a target title on the next line of an unheaded reference is not a match', async () => {
  const r = await inspect('Another scientific article about brain structures and behavior\n1. Smith et al. (2015)\n' + TITLE + '\nhttps://doi.org/' + DOI);
  assert.equal(r.status, 'unknown'); assert.deepEqual(r.detectedDOIs, []);
});
test('a standalone cited DOI inside the abstract is not front-matter identity', async () => {
  const r = await inspect('Another scientific article about brain structures and behavior\nAbstract\nPrior work:\nhttps://doi.org/' + DOI + '\nWe extend those findings.');
  assert.equal(r.status, 'unknown'); assert.deepEqual(r.detectedDOIs, []);
});
test('publisher copyright metadata can identify the article DOI in a first-page footer', async () => {
  const r = await inspect('Another scientific article about brain structures and behavior\nAbstract\nLong research text.\nCopyright 2015 Oxford University Press. All rights reserved.\nhttps://doi.org/' + DOI);
  assert.equal(r.status, 'match'); assert.equal(r.matchedBy, 'doi');
});
test('the second page never establishes a match', async () => {
  const r = await inspect('Another scientific article about brain structures and behavior\nAbstract\nResearch.\f' + TITLE + '\nDOI: ' + DOI);
  assert.equal(r.status, 'unknown'); assert.deepEqual(r.detectedDOIs, []);
});
test('an empty first page is not replaced by a reference on page two', async () => {
  const r = await inspect('\f' + TITLE + '\nDOI: ' + DOI);
  assert.equal(r.status, 'unknown');
});
test('a no-text scan is unknown, not a mismatch', async () => {
  const r = await inspect('\n\f  '); assert.equal(r.status, 'unknown'); assert.equal(r.reason, 'no_text');
});
test('a long exact standalone title can establish identity when DOI is absent', async () => {
  const r = await inspect('RESEARCH ARTICLE\n' + TITLE + '\nJane Smith\nAbstract\nResearch.');
  assert.equal(r.status, 'match'); assert.equal(r.matchedBy, 'title');
});
test('a similar but different title is never a fuzzy match', async () => {
  const r = await inspect(TITLE.replace('social', 'economic') + '\nAbstract\nResearch.');
  assert.equal(r.status, 'unknown');
});
test('a matching title mentioned inside the abstract is not a title match', async () => {
  const r = await inspect('Another scientific article about brain structures and behavior\nAbstract\n' + TITLE + '\nThis study extends that work.');
  assert.equal(r.status, 'unknown');
});
test('a target title embedded in a prose paragraph cannot establish identity', async () => {
  const r = await inspect('We discuss ' + TITLE + ' and describe limitations.');
  assert.equal(r.status, 'unknown');
});
test('short generic titles are not sufficient identity', async () => {
  const r = await inspect('Brain activity\nAbstract\nResearch.', { title: 'Brain activity' });
  assert.equal(r.status, 'unknown'); assert.equal(r.reason, 'target_missing');
});
test('title punctuation, ligatures and line-break hyphenation normalize safely', async () => {
  const title = 'Neurofunctional profiles of social decision making in healthy adults';
  const r = await inspect('Neurofunc-\ntional proﬁles of social decision making in healthy adults\nAbstract\nResearch.', { title });
  assert.equal(r.status, 'match'); assert.equal(r.matchedBy, 'title');
});
test('soft hyphens and a wrapped doi.org address are supported', async () => {
  const r = await inspect('Different title for a scientific article under evaluation\nhttps://doi.org/10.1093/\nscan/nsu\u00ad132\nAbstract\nResearch.');
  assert.equal(r.status, 'match'); assert.equal(r.matchedBy, 'doi');
});
test('a real DOI hyphen survives a line wrap', async () => {
  const r = await inspect('DOI: 10.1038/s41593-\n024-00001-2\nAbstract\nResearch.', { doi: '10.1038/s41593-024-00001-2' });
  assert.equal(r.status, 'match'); assert.deepEqual(r.detectedDOIs, ['10.1038/s41593-024-00001-2']);
});
test('different hyphenated DOIs are not silently treated as identical', async () => {
  const r = await inspect('DOI: 10.1234/neuro-science\nAbstract\nResearch.', { doi: '10.1234/neuroscience' });
  assert.equal(r.status, 'mismatch');
});
test('a DOI wrapped after a dot is reconstructed', async () => {
  const r = await inspect('DOI: 10.1534/g3.114.\n016519\nAbstract\nResearch.', { doi: '10.1534/g3.114.016519' });
  assert.equal(r.status, 'match');
});
test('mixed case, DOI URL and enclosing sentence punctuation normalize', async () => {
  const r = await inspect('DOI: 10.1093/SCAN/NSU132.\nAbstract\nResearch.', { doi: 'https://doi.org/10.1093/SCAN/NSU132' });
  assert.equal(r.status, 'match');
});
test('balanced parentheses belonging to a DOI are preserved', async () => {
  const r = await inspect('https://doi.org/10.1002/(sici)1234\nAbstract\nResearch.', { doi: '10.1002/(sici)1234' });
  assert.equal(r.status, 'match');
});
test('conflicting first-page DOI labels remain unknown even if one matches', async () => {
  const r = await inspect(TITLE + '\nDOI: ' + DOI + '\nDOI: 10.1234/other\nAbstract\nResearch.');
  assert.equal(r.status, 'unknown'); assert.equal(r.reason, 'conflicting_dois');
});
test('a sufficiently long Chinese title can establish identity', async () => {
  const title = '社会价值表征在人类复杂决策过程中所发挥的神经机制研究';
  const r = await inspect(title + '\n摘要：研究正文', { title });
  assert.equal(r.status, 'match');
});
test('Zotero item fields are supported without any Item writes', async () => {
  const item = { getField: field => ({ DOI, title: TITLE }[field] || '') };
  const r = await inspect('DOI: ' + DOI + '\nAbstract\nResearch.', item);
  assert.equal(r.status, 'match');
});
test('unknown preview is bounded and contains no raw extraction error or path', async () => {
  const r = await create({ extractText: async () => { throw new Error('C:\\secret\\document.pdf token=secret'); } }).inspect('C:\\secret\\document.pdf', target);
  assert.equal(r.status, 'unknown'); assert.equal(r.reason, 'extraction_failed');
  assert.doesNotMatch(JSON.stringify(r), /secret|document\.pdf|token/); assert(r.summary.length < 300);
});
test('an unavailable private worker reports unknown without a fake import', async () => {
  const r = await create({ Zotero: {}, IOUtils: {} }).inspect('fixture.pdf', target);
  assert.equal(r.status, 'unknown'); assert.equal(r.reason, 'extraction_unavailable');
});
test('default runtime reads a bounded local file and queues the built-in worker', async () => {
  const calls = [], bytes = new Uint8Array([37, 80, 68, 70, 45]);
  const api = create({
    IOUtils: { async stat(path) { calls.push(['stat', path]); return { type: 'regular', size: bytes.length }; }, async read(path) { calls.push(['read', path]); return bytes; } },
    Zotero: { PDFWorker: { async _enqueue(fn, priority) { calls.push(['queue', priority]); return fn(); }, async _query(action, data, transfer) { calls.push(['query', action]); assert.equal(data.maxPages, 2); assert.equal(transfer[0], data.buf); assert.notEqual(data.buf, bytes.buffer); return { text: 'DOI: ' + DOI }; } } }
  });
  const r = await api.inspect('fixture.pdf', target);
  assert.equal(r.status, 'match'); assert.deepEqual(calls, [['stat', 'fixture.pdf'], ['read', 'fixture.pdf'], ['queue', false], ['query', 'pdf.getFulltext']]);
});
test('provided bytes skip the filesystem and remain intact after worker transfer', async () => {
  const original = new Uint8Array([37, 80, 68, 70, 45]);
  const api = create({ IOUtils: { async stat() { throw new Error('Must not read'); }, async read() { throw new Error('Must not read'); } },
    Zotero: { PDFWorker: { async _enqueue(fn) { return fn(); }, async _query(action, data, transfer) { structuredClone(data.buf, { transfer }); assert.equal(data.buf.byteLength, 0); return { text: 'DOI: ' + DOI }; } } }
  });
  const r = await api.inspect('ignored.pdf', target, { bytes: original });
  assert.equal(r.status, 'match'); assert.deepEqual(Array.from(original), [37, 80, 68, 70, 45]);
});
test('an injected extractor receives the exact byte snapshot and bounded page count', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const api = create({ extractText: async (path, options) => { assert.equal(path, 'fixture.pdf'); assert.equal(options.bytes, bytes); assert.equal(options.maxPages, 2); return 'DOI: ' + DOI; } });
  assert.equal((await api.inspect('fixture.pdf', target, { bytes })).status, 'match');
});
test('oversized files are stopped before reading or invoking the worker', async () => {
  let reads = 0, queries = 0;
  const api = create({ IOUtils: { async stat() { return { type: 'regular', size: MAX_PDF_BYTES + 1 }; }, async read() { reads++; } }, Zotero: { PDFWorker: { _enqueue() { queries++; }, _query() {} } } });
  const r = await api.inspect('fixture.pdf', target);
  assert.equal(r.status, 'unknown'); assert.equal(r.reason, 'file_too_large'); assert.equal(reads, 0); assert.equal(queries, 0);
});
test('a file growing beyond the limit after stat is rejected before extraction', async () => {
  let queries = 0;
  const oversized = new Uint8Array([1]);
  Object.defineProperty(oversized, 'byteLength', { value: MAX_PDF_BYTES + 1 });
  const api = create({ IOUtils: { async stat() { return { type: 'regular', size: 5 }; }, async read() { return oversized; } }, Zotero: { PDFWorker: { _enqueue() { queries++; }, _query() {} } } });
  const r = await api.inspect('fixture.pdf', target);
  assert.equal(r.status, 'unknown'); assert.equal(r.reason, 'file_too_large'); assert.equal(queries, 0);
});
test('directories and invalid snapshots are not passed to the worker', async () => {
  const api = create({ IOUtils: { async stat() { return { type: 'directory', size: 0 }; }, async read() { throw new Error('Must not read'); } }, Zotero: { PDFWorker: { _enqueue() {}, _query() {} } } });
  assert.equal((await api.inspect('directory', target)).reason, 'invalid_file');
  assert.equal((await api.inspect('fixture.pdf', target, { bytes: new Uint8Array() })).reason, 'invalid_file');
});
