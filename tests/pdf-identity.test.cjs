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
test('a different authoritative DOI conflicts with an identical title and cannot auto-import', async () => {
  const r = await inspect(TITLE + '\nDOI: 10.1093/scan/wrong\nAbstract\nResearch.');
  assert.equal(r.status, 'unknown'); assert.equal(r.reason, 'conflicting_identity');
  assert.equal(r.evidence.identityConflict, true);assert.equal(r.related, true);assert.equal(r.matchedBy, '');
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
  const r = await inspect(TITLE + '\nAbstract\nLong research text.\nCopyright 2015 Oxford University Press. All rights reserved.\nhttps://doi.org/' + DOI);
  assert.equal(r.status, 'match'); assert.equal(r.matchedBy, 'doi');
});

test('a journal citation footer immediately below publisher copyright identifies the article DOI', async () => {
  const text='Social chromosome variants differentially affect queen\ndetermination and the survival of workers in the ﬁre ant\nSolenopsis invicta\nAbstract\nResearch text.\n© 2014 John Wiley & Sons Ltd\nMolecular Ecology (2014) 23, 5117–5127 doi: 10.1111/mec.12915';
  const r=await inspect(text,{doi:'10.1111/mec.12915',title:'Social chromosome variants differentially affect queen determination and the survival of workers in the fire ant <i><span>S</span> olenopsis invicta</i>'});
  assert.equal(r.status,'match');assert.equal(r.matchedBy,'doi');assert.deepEqual(r.detectedDOIs,['10.1111/mec.12915']);
  const wrong=await inspect(text,{doi:'10.1111/mec.00000'});assert.equal(wrong.status,'mismatch');
});

test('a journal-style citation needs publisher footer context and is never taken from references', async () => {
  const citation='Molecular Ecology (2014) 23, 5117–5127 doi: 10.1111/mec.12915';
  for(const text of ['Another paper title\nAbstract\n'+citation,'Another paper title\nAbstract\n© 2014 Publisher\nReferences\n'+citation]){
    const r=await inspect(text,{doi:'10.1111/mec.12915'});assert.equal(r.status,'unknown');assert.deepEqual(r.detectedDOIs,[]);
  }
});

test('submission dates plus online publication and copyright can establish an uncolonized footer DOI',async()=>{
  const footer='Correspondence to: Annaliese K. Beery. Received 20 June 2007; Revised 18 October 2007; Accepted 18 December 2007 DOI 10.1002/cne.21638 Published online in Wiley InterScience (www.interscience.wiley.com).\nTHE JOURNAL OF COMPARATIVE NEUROLOGY 507:1847–1859 (2008)\n© 2008 WILEY-LISS, INC.';
  const text='Oxytocin and Vasopressin Receptor Distributions in a Solitary and a Social Species of Tuco-Tuco\nABSTRACT\nResearch text.\n'+footer;
  const r=await inspect(text,{doi:'10.1111/j.1601-183x.2005.00118.x'});assert.equal(r.status,'mismatch');assert.deepEqual(r.detectedDOIs,['10.1002/cne.21638']);
  assert.equal((await inspect(text,{doi:'10.1002/cne.21638'})).status,'match');
  for(const omitted of ['Received 20 June 2007; ','Accepted 18 December 2007 ','Published online in ','© 2008 WILEY-LISS, INC.']){
    const incomplete=await inspect(text.replace(omitted,''),{doi:'10.1002/cne.21638'});assert.equal(incomplete.status,'unknown',omitted);
  }
});

test('a copyright journal footer may print the verified opening page after its DOI',async()=>{
  const title='Female oxytocin gene-knockout mice, in a semi-natural environment, display exaggerated aggressive behavior';
  const text='Female oxytocin gene-knockout mice, in a seminatural environment, display exaggerated aggressive behavior\nAuthors\nAbstract\nResearch text.\nGenes, Brain and Behavior (2005) 4: 229–239 Copyright # Blackwell Munksgaard 2005\ndoi: 10.1111/j.1601-183X.2005.00118.x 229';
  const target={doi:'10.1111/j.1601-183x.2005.00118.x',title};
  const r=await inspect(text,target);assert.equal(r.status,'match');assert.equal(r.matchedBy,'doi');assert.deepEqual(r.detectedDOIs,[target.doi]);
  assert.equal((await inspect(text,{doi:'10.1111/j.1601-183x.2005.00999.x'})).status,'mismatch');
  for(const invalid of [text.replace('Copyright # Blackwell Munksgaard 2005',''),text.replace(/ 229$/,' 230'),text.replace('4: 229–239','4: 229'),text.replace('Genes, Brain and Behavior (2005) 4: 229–239 Copyright # Blackwell Munksgaard 2005','Copyright # Blackwell Munksgaard 2005')]){
    assert.equal((await inspect(invalid,target)).status,'unknown');
  }
});

test('a target article after a previous article reference section remains a diagnostic candidate', async () => {
  const title='Mesotocin and Nonapeptide Receptors Promote Estrildid Flocking Behavior';
  const text='References and Notes\n1. A cited paper.\n'+('Previous article bibliography.\n'.repeat(110))+'10.1126/science.1175028\nMesotocin and Nonapeptide Receptors\nPromote Estrildid Flocking Behavior\nJames L. Goodson\nResearch text.';
  const r=await inspect(text,{doi:'10.1126/science.1174929',title});
  assert.equal(r.status,'unknown');assert.equal(r.reason,'title_outside_front_matter');assert.deepEqual(r.detectedDOIs,[]);assert.equal(r.matchedBy,'');
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
    Zotero: { PDFWorker: { async _enqueue(fn, priority) { calls.push(['queue', priority]); return fn(); }, async _query(action, data, transfer) { calls.push(['query', action]); assert.equal(data.maxPages, action === 'pdf.getFulltext' ? 2 : undefined); assert.equal(transfer[0], data.buf); assert.notEqual(data.buf, bytes.buffer); return action === 'pdf.getFulltext' ? { text: 'DOI: ' + DOI } : { pages: [] }; } } }
  });
  const r = await api.inspect('fixture.pdf', target);
  assert.equal(r.status, 'match'); assert.deepEqual(calls, [['stat', 'fixture.pdf'], ['read', 'fixture.pdf'], ['queue', false], ['query', 'pdf.getFulltext'], ['query', 'pdf.getRecognizerData']]);
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

// The installed worker emits regions containing lines of geometric word arrays.
// These minimal fixtures retain the real layout/ordinal-copyright behavior,
// without copying paper bodies, user paths or correspondence from local PDFs.
function recognizedPage(lines, metadata = {}) {
  const rows = lines.map((value, i) => {
    const entry = typeof value === 'string' ? { text: value } : value;
    const font = entry.font || 10, y = entry.y ?? 50 + i * 18;
    let x = entry.x || 40;
    const parts = entry.text.split(' ');
    const words = parts.map((part, j) => {
      const width = part.length * font * 0.45;
      const word = [x, y, x + width, y + font, font, j < parts.length - 1 ? 1 : 0, y + font * 0.8, 0, 0, 0, 0, 0, 0, part];
      x += width + font * 0.25;return word;
    });
    for (const extra of entry.extra || []) words.push([extra.x, y, extra.x + 12, y + extra.font, extra.font, 0, y + extra.font * 0.8, 0, 0, 0, 0, 0, 0, extra.text]);
    return [words];
  });
  return { metadata, pages: [[600, 800, [[[[0, 0, 0, 0, rows]]]]]] };
}
async function inspectGeometry(text, recognized, item = target) {
  return create({ extractText: async () => ({ text, recognized, extractedPages: 2, totalPages: 20 }) }).inspect('fixture.pdf', item);
}

test('Latin macrons lost by embedded fonts normalize only as a complete front title', async () => {
  const title = 'Population genomics of the critically endangered kākāpō';
  const r = await inspect('Short article\nPopulation genomics of the critically endangered kakapo\nGraphical abstract\nHighlights\nBody text.', { doi: '10.1016/j.xgen.2021.100002', title });
  assert.equal(r.status, 'match');assert.equal(r.matchedBy, 'title');assert.equal(r.titleSimilarity, 1);
  assert.equal(r.evidence.titleReliable, true);assert.equal(r.detectedTitle.endsWith('kakapo'), true);
  const reference = await inspect('A different article about avian survival and conservation\nAbstract\nBody text.\nReferences\n' + title, { title });
  assert.equal(reference.status, 'unknown');assert.equal(reference.related, false);
});

test('native geometric lines recover the article DOI beside a distant logo without publisher-specific rules', async () => {
  const item = { doi: '10.1016/j.xgen.2021.100002', title: 'Population genomics of the critically endangered kākāpō' };
  const recognized = recognizedPage([
    'Short article', { text: 'Population genomics of the critically endangered', font: 18 }, { text: 'kakapo', font: 18 },
    'Graphical abstract', 'Highlights', 'Authors',
    { text: 'Example et al., 2021, Example Journal 1, 100002', y: 700 },
    { text: 'October 13, 2021 ª 2021 The Author(s).', y: 716 },
    { text: 'https://doi.org/' + item.doi, y: 732, font: 8, extra: [{ x: 500, font: 16, text: 'xy' }] },
  ], { doi: '10.1234/stale', Title: 'Untrusted metadata title' });
  const raw = 'Short article\nPopulation genomics of the critically endangered kakapo\nGraphical abstract\nAuthors\nExample et al., 2021, Example Journal 1, 100002 October 13, 2021 a 2021 The Author(s).\nhttps://doi.org/' + item.doi + ' xy';
  const r = await inspectGeometry(raw, recognized, item);
  assert.equal(r.status, 'match');assert.equal(r.matchedBy, 'doi');assert.deepEqual(r.detectedDOIs, [item.doi]);
  assert.equal(r.titleSimilarity, 1);assert.equal(r.related, true);assert.equal(r.candidateScore, 1);
  assert.equal(r.evidence.extractionSucceeded, true);assert(r.evidence.firstPageCharacterCount > 100);
  assert.equal(r.evidence.extractedPages, 2);assert.equal(r.evidence.totalPages, 20);
  assert.deepEqual(r.evidence.candidateBasis, ['article_doi_match', 'front_title_match']);
});

test('native geometric footer restores a different article DOI and excludes the unrelated file', async () => {
  const other = '10.1016/j.cub.2016.02.062';
  const recognized = recognizedPage(['Report', 'Genomic Flatlining in the Endangered Island Fox', 'Highlights', 'Authors',
    { text: 'Example et al., 2016, Example Journal 26, 1183–1189', y: 700 },
    { text: 'May 9, 2016 ª 2016 Example Publisher Ltd.', y: 716 }, { text: 'http://dx.doi.org/' + other, y: 732 }]);
  const r = await inspectGeometry('Report\nGenomic Flatlining in the Endangered Island Fox\nHighlights\nExample et al., 2016, Example Journal 26, 1183–1189 May 9, 2016 a 2016 Example Publisher Ltd. http://dx.doi.org/' + other, recognized,
    { doi: '10.1016/j.xgen.2021.100002', title: 'Population genomics of the critically endangered kākāpō' });
  assert.equal(r.status, 'mismatch');assert.equal(r.reason, 'doi_mismatch');assert.deepEqual(r.detectedDOIs, [other]);
  assert.equal(r.related, false);assert.equal(r.candidateScore, 0);assert(r.titleSimilarity < 0.3);
  assert.equal(r.evidence.titleReliable, true);assert.equal(r.evidence.doiReliable, true);
});

test('same DOI with a reliably different title remains a reviewable identity conflict', async () => {
  const r = await inspect('Research article\nGenomic Flatlining in the Endangered Island Fox\nDOI: ' + DOI + '\nAbstract\nResearch.');
  assert.equal(r.status, 'unknown');assert.equal(r.reason, 'conflicting_identity');assert.equal(r.matchedBy, '');
  assert.equal(r.related, true);assert.equal(r.evidence.identityConflict, true);assert(r.candidateScore < 1);
});

test('journal headers do not become a conflicting article title', async () => {
  const r = await inspect('International Journal of Neural Development and Behavioral Sciences\nDOI: ' + DOI + '\nAbstract\nResearch.');
  assert.equal(r.status, 'match');assert.equal(r.matchedBy, 'doi');assert.equal(r.evidence.titleReliable, false);
  const actual = await inspect('International Review of Neural Development and Behavioral Sciences\nGenomic Flatlining in the Endangered Island Fox\nAbstract\nResearch.\nCopyright 2021 Example Publisher.\nhttps://doi.org/' + DOI);
  assert.equal(actual.reason, 'conflicting_identity');assert.equal(actual.detectedTitle, 'Genomic Flatlining in the Endangered Island Fox');
});

test('nearby titles are ranked for review but are never a fuzzy auto-match', async () => {
  const r = await inspect('Research article\n' + TITLE.replace('social', 'economic') + '\nAbstract\nResearch.');
  assert.equal(r.status, 'unknown');assert.equal(r.related, true);assert(r.titleSimilarity > 0.65 && r.titleSimilarity < 1);
  assert(r.candidateScore > 0 && r.candidateScore < 1);assert(r.evidence.candidateBasis.includes('front_title_similar'));
});

test('unrelated well-extracted files and extraction failures do not fill the candidate list', async () => {
  const unrelated = await inspect('Research article\nGenomic Flatlining in the Endangered Island Fox\nAbstract\nResearch.');
  assert.equal(unrelated.status, 'unknown');assert.equal(unrelated.related, false);assert.equal(unrelated.candidateScore, 0);
  assert.equal(unrelated.evidence.extractionSucceeded, true);assert(unrelated.evidence.firstPageCharacterCount > 0);
  const failed = await create({ extractText: async () => { throw new Error('private-path-or-token'); } }).inspect('private.pdf', target);
  assert.equal(failed.related, false);assert.equal(failed.candidateScore, 0);assert.equal(failed.evidence.extractionSucceeded, false);
  assert.equal(failed.evidence.firstPageCharacterCount, 0);assert.deepEqual(failed.evidence.candidateBasis, ['extraction_failed']);
  assert.doesNotMatch(JSON.stringify(failed), /private/);
  const empty = await inspect('');assert.equal(empty.evidence.extractionSucceeded, true);assert.deepEqual(empty.evidence.candidateBasis, ['no_extractable_text']);
});

test('recognizer metadata, references and second-page words cannot supply article identity', async () => {
  const fakeMetadata = recognizedPage(['Research article', 'Unrelated ecosystem restoration and population dynamics', 'Abstract', 'Body text.'], { doi: DOI, Title: TITLE });
  assert.equal((await inspectGeometry('', fakeMetadata)).status, 'unknown');
  const references = recognizedPage(['Research article', 'Unrelated ecosystem restoration and population dynamics', 'Abstract', 'Body text.', 'References', TITLE, 'Copyright 2015 Example Publisher.', 'https://doi.org/' + DOI]);
  const r = await inspectGeometry('', references);assert.equal(r.status, 'unknown');assert.deepEqual(r.detectedDOIs, []);assert.equal(r.related, false);
  const next = recognizedPage(['Unrelated ecosystem restoration and population dynamics', 'Abstract', 'Body text.']);
  next.pages.push(recognizedPage([TITLE, 'DOI: ' + DOI]).pages[0]);
  assert.equal((await inspectGeometry('', next)).status, 'unknown');
});

test('an unheaded geometric citation or unverified ordinal glyph cannot masquerade as a footer DOI', async () => {
  for (const line of ['Smith et al. (2015). A cited paper', 'May 9, 2016 a 2016 Example Publisher Ltd.', 'May 9, 2016 ª 2015 Example Publisher Ltd.']) {
    const recognized = recognizedPage(['Another paper about ecosystems and species diversity', 'Abstract', 'Body text.', line, 'https://doi.org/' + DOI]);
    const r = await inspectGeometry('', recognized);assert.equal(r.status, 'unknown');assert.deepEqual(r.detectedDOIs, []);
  }
});

test('malformed or out-of-bounds geometric words cannot inject a matching title or DOI', async () => {
  for (const change of [word => { word[0] = -200; }, word => { word[2] = 7000; }, word => { word[4] = NaN; }]) {
    const recognized = recognizedPage(['DOI: ' + DOI]);
    const words = recognized.pages[0][2][0][0][0][4][0][0];for (const word of words) change(word);
    const r = await inspectGeometry('', recognized);assert.equal(r.status, 'unknown');assert.deepEqual(r.detectedDOIs, []);
  }
});

test('unsupported geometry preserves successful bounded fulltext extraction', async () => {
  const actions = [];
  const api = create({ Zotero: { PDFWorker: { _enqueue: fn => fn(), async _query(action) {
    actions.push(action);if (action === 'pdf.getRecognizerData') throw new Error('unsupported');return { text: 'DOI: ' + DOI };
  } } } });
  const r = await api.inspect('ignored.pdf', target, { bytes: new Uint8Array([37, 80, 68, 70]) });
  assert.equal(r.status, 'match');assert.deepEqual(actions, ['pdf.getFulltext', 'pdf.getRecognizerData']);
});

test('shared snapshot extraction is single-flight across targets while classification remains target-specific', async () => {
  let calls = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  const bytes = new Uint8Array([1, 2, 3]);
  const api = create({ extractText: async () => { calls++;await pending;return { text: 'DOI: ' + DOI }; } });
  const first = api.inspect('same.pdf', target, { bytes }), second = api.inspect('same.pdf', { doi: '10.1234/wrong' }, { bytes });
  release();const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);assert.equal(a.status, 'match');assert.equal(b.status, 'mismatch');
  assert.equal((await api.inspect('same.pdf', target, { bytes })).status, 'match');assert.equal(calls, 1);
});

test('mutated snapshots, failed extractions and the bounded cache cannot reuse stale text', async () => {
  let calls = 0;const bytes = new Uint8Array([1]);
  const api = create({ extractText: async (_path, { bytes }) => { calls++;return { text: 'DOI: ' + (bytes[0] === 1 ? DOI : '10.1234/wrong') }; } });
  assert.equal((await api.inspect('same.pdf', target, { bytes })).status, 'match');bytes[0] = 2;
  assert.equal((await api.inspect('same.pdf', target, { bytes })).status, 'mismatch');assert.equal(calls, 2);
  for (let i = 0; i < 4; i++) await api.inspect('other.pdf', target, { bytes: new Uint8Array([1]) });
  await api.inspect('same.pdf', target, { bytes });assert.equal(calls, 7);
  let attempts = 0;const retry = create({ extractText: async () => { if (++attempts === 1) throw new Error('temporary');return 'DOI: ' + DOI; } });
  assert.equal((await retry.inspect('same.pdf', target, { bytes })).reason, 'extraction_failed');
  assert.equal((await retry.inspect('same.pdf', target, { bytes })).status, 'match');assert.equal(attempts, 2);
});

test('inline abstract headings fence off cited DOIs and titles', async () => {
  for (const citation of ['https://doi.org/' + DOI, TITLE]) {
    const r = await inspect('Another scientific article about brain structures and behavior\nAbstract We discuss earlier research\n' + citation + '\nWe extend those findings.');
    assert.equal(r.status, 'unknown');assert.equal(r.related, false);assert.deepEqual(r.detectedDOIs, []);
  }
});

test('copyright does not override explicit adapted, reprinted or corrected attribution', async () => {
  for (const attribution of ['Adapted from', 'Reprinted from', 'Correction to', 'See also']) {
    const text = 'An unrelated scientific report with other experimental conclusions\nJane Smith1, John Jones2\nAbstract\nOur experiment is described here.\n' + attribution + ' Smith et al.\nCopyright 2015 Oxford University Press\nhttps://doi.org/' + DOI;
    const r = await inspect(text);assert.equal(r.status, 'unknown');assert.deepEqual(r.detectedDOIs, []);assert.equal(r.related, false);
  }
});

test('geometry joins bounded adjacent large-font title lines instead of trusting a half title', async () => {
  const title = 'Revealing extensive inbreeding and less efficient purging of deleterious mutations in wild Amur tigers in China';
  const recognized = recognizedPage([
    { text: 'Original Research', y: 150, font: 9 },
    { text: 'Revealing extensive inbreeding and less efficient purging of', y: 175, font: 13 },
    { text: 'deleterious mutations in wild Amur tigers in China', y: 192, font: 13 },
    { text: 'Jane Smith1, John Jones2', y: 218, font: 10 },
    { text: 'Department of Biological Research', y: 240, font: 8 },
    { text: 'Abstract', y: 290, font: 9 }, { text: 'Our study examines variation in populations.', y: 310, font: 9 },
  ]);
  const r = await inspectGeometry('Original Research\nRevealing extensive inbreeding and less efficient purging of\nJane Smith\nAbstract\nResearch.', recognized);
  assert.equal(r.detectedTitle, title);assert.equal(r.evidence.titleReliable, true);assert.equal(r.related, false);
  const matching = await inspectGeometry('', recognized, { title });assert.equal(matching.status, 'match');assert.equal(matching.matchedBy, 'title');
  const half = await inspect('Original Research\nRevealing extensive inbreeding and less efficient purging of\nJane Smith\nAbstract\nResearch.');
  assert.equal(half.evidence.titleReliable, false);
});

test('a reliable geometric title overrides weak plain text and triggers same-DOI cross-checking', async () => {
  const recognized = recognizedPage([
    { text: 'Research article', y: 45, font: 10 },
    { text: 'Genomic Flatlining in the', y: 80, font: 18 },
    { text: 'Endangered Island Fox', y: 102, font: 18 },
    { text: 'Jane Smith1, John Jones2', y: 132, font: 10 },
    { text: 'Abstract', y: 160, font: 9 },
    { text: 'Copyright 2015 Example Publisher.', y: 710, font: 8 }, { text: 'https://doi.org/' + DOI, y: 732, font: 8 },
  ]);
  const r = await inspectGeometry('Weak extracted heading containing enough unrelated words\nDOI: ' + DOI + '\nOther metadata\nAbstract\nResearch.', recognized);
  assert.equal(r.status, 'unknown');assert.equal(r.reason, 'conflicting_identity');assert.equal(r.detectedTitle, 'Genomic Flatlining in the Endangered Island Fox');
});

test('moderate title similarity cannot automatically pass just because its DOI matches', async () => {
  const r = await inspect('Research article\n' + TITLE.replace('social', 'economic') + '\nDOI: ' + DOI + '\nAbstract\nResearch.');
  assert(r.titleSimilarity >= 0.65 && r.titleSimilarity < 0.9);assert.equal(r.status, 'unknown');assert.equal(r.reason, 'conflicting_identity');
  assert.equal(r.evidence.identityConflict, true);assert.equal(r.related, true);
});

test('large-font geometric title reconstruction preserves cross-line hyphenation', async () => {
  const recognized = recognizedPage([
    { text: 'Research article', y: 45, font: 9 },
    { text: 'Neural representations of social values', y: 80, font: 18 },
    { text: 'during human deci-', y: 102, font: 18 },
    { text: 'sion making', y: 124, font: 18 },
    { text: 'Jane Smith', y: 152, font: 10 },
    { text: 'Abstract', y: 178, font: 9 },
    { text: 'This study concerns human decisions.', y: 196, font: 9 },
  ]);
  const r = await inspectGeometry('Research article\n' + TITLE + '\nJane Smith\nAbstract\nBody.', recognized);
  assert.equal(r.status, 'match');assert.equal(r.matchedBy, 'title');assert.equal(r.titleSimilarity, 1);assert.equal(r.detectedTitle, TITLE);
});

test('same-sized author lines do not turn a correct complete title into a geometry conflict', async () => {
  const recognized = recognizedPage([
    { text: 'Research article', y: 45, font: 9 },
    { text: 'Neural representations of social', y: 80, font: 10 },
    { text: 'values during human decision making', y: 98, font: 10 },
    { text: 'Jane Smith', y: 116, font: 10 },
    { text: 'DOI: ' + DOI, y: 134, font: 8 },
    { text: 'Abstract', y: 152, font: 10 },
    { text: 'This study concerns human decisions.', y: 170, font: 10 },
  ]);
  const r = await inspectGeometry('Research article\n' + TITLE + '\nJane Smith\nDOI: ' + DOI + '\nAbstract\nBody.', recognized);
  assert.equal(r.status, 'match');assert.equal(r.matchedBy, 'doi');assert.equal(r.detectedTitle, TITLE);assert.equal(r.titleSimilarity, 1);
});

test('highly similar titles with conflicting complete DOIs remain reviewable', async () => {
  const longer = TITLE + ' processes';
  const r = await inspect('Research article\n' + longer + '\nDOI: 10.1234/other\nAbstract\nBody.');
  assert(r.titleSimilarity >= 0.9);assert.equal(r.status, 'unknown');assert.equal(r.reason, 'conflicting_identity');assert.equal(r.related, true);
});
