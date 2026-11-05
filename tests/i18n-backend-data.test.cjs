const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const rows = require('../src/i18n-backend-data.js');
const script = fs.readFileSync(path.join(__dirname, '../src/i18n-backend-data.js'), 'utf8');
const engine = fs.readFileSync(path.join(__dirname, '../src/i18n.js'), 'utf8');
const han = /[\u4e00-\u9fff]/;
function create({ backendFirst = true } = {}) {
  const scope = {};
  if (backendFirst) vm.runInNewContext(script, scope);
  vm.runInNewContext(engine, scope);
  return scope;
}

test('backend catalog has unique static trilingual rows and preserves every placeholder', () => {
  assert(rows.length >= 400);
  assert(Object.isFrozen(rows));
  const seen = new Set();
  for (const row of rows) {
    assert(Object.isFrozen(row));
    assert.equal(row.length, 3);
    assert(row.every(value => typeof value === 'string' && value.trim()));
    assert(han.test(row[0]));
    assert(!han.test(row[2]), row[0]);
    assert(!/后|里|并|復制|采納|登錄|設置|消息|賬號/.test(row[1]), row[1]);
    assert(!seen.has(row[0]), row[0]);seen.add(row[0]);
    const tokens = value => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]).sort();
    assert.deepEqual(tokens(row[1]), tokens(row[0]), row[0]);
    assert.deepEqual(tokens(row[2]), tokens(row[0]), row[0]);
  }
});

test('key retrieval login identity and completion failures translate as complete messages', () => {
  const { FulltextI18n: i18n } = create();
  for (const message of [
    '自动查找暂未取得有效 PDF；这不能判断你是否拥有机构访问权限。可先点击“浏览器下载并自动入库”，在日常浏览器查看这篇论文并尝试下载；仍无法获取时可使用科研通兜底。',
    '登录会话无法恢复，请解锁 Zotero 凭据存储后重试。',
    'PDF 首页的文献 DOI 与目标条目不同，已阻止导入。',
    '采纳结果尚未在文件详情中确认；保留本地 PDF，不会自动重复提交。',
    '对应消息的已读状态尚未核实，未修改其他通知。',
    '这篇论文曾通过浏览器成功获取，访问方式未确认。可在日常浏览器重试。',
  ]) {
    const english = i18n.translate(message, 'en');
    assert.notEqual(english, message);assert(!han.test(english), english);
    const traditional = i18n.translate(message, 'zh-TW');
    assert.notEqual(traditional, message);assert(han.test(traditional));
    assert.equal(i18n.translate(message, 'zh-CN'), message);
  }
});

test('already interpolated retry and reward messages retain numeric values', () => {
  const { FulltextI18n: i18n } = create();
  assert.equal(i18n.translate('检查暂时失败，将在 120 秒后重试。', 'en'), 'The check failed temporarily. Retrying in 120 seconds.');
  assert.equal(i18n.translate('检查暂时失败，将在 {seconds} 秒后重试。', 'en', { seconds: 3600 }), 'The check failed temporarily. Retrying in 3600 seconds.');
  assert.match(i18n.translate('网站最低要求为 15 积分，超过当前配置；未发布、未自动加价。', 'en'), /at least 15 points/);
  assert.equal(i18n.translate('科研通返回 HTTP 429', 'en'), 'AbleSci returned HTTP 429');
});

test('candidate review confirmation and cancellation are translated in all three languages', () => {
  const { FulltextI18n: i18n } = create();
  for (const [chinese, traditional, english] of [
    ['PDF 身份已匹配；请预览后明确确认入库。', 'PDF 身份已匹配；請預覽後明確確認入庫。', 'The PDF matches this article. Preview it, then explicitly confirm import.'],
    ['候选文件核对已取消，请重新检查。', '候選檔案核對已取消，請重新檢查。', 'Candidate file review was cancelled. Check it again.'],
    ['此论文缺少 DOI 或有效出版社网址，暂不能保存机构访问记录。', '此論文缺少 DOI 或有效出版社網址，暫不能保存機構訪問記錄。', 'This article lacks a DOI or a valid publisher URL. Institutional access cannot be recorded yet.'],
  ]) {
    assert.equal(i18n.translate(chinese, 'zh-CN'), chinese);
    assert.equal(i18n.translate(chinese, 'zh-TW'), traditional);
    assert.equal(i18n.translate(chinese, 'en'), english);
  }
});

test('all optional batch-summary combinations translate without losing counts', () => {
  const { FulltextI18n: i18n } = create();
  const suffixes = ['，保留已有任务 4 项', '，重复选择 5 项', '，忽略不支持的条目 6 项', '，检查失败 7 项', '；操作已停止，未处理 8 项'];
  for (let flags = 0; flags < 32; flags++) {
    const source = '已选择 20 项：加入 9 项，已有 PDF 跳过 3 项' + suffixes.filter((_, bit) => flags & (1 << bit)).join('') + '。';
    const translated = i18n.translate(source, 'en');
    assert(!han.test(translated), translated);
    assert.deepEqual(translated.match(/\d+/g), source.match(/\d+/g));
  }
});

test('download-review template preserves a Chinese filename while translating the plugin explanation', () => {
  const { FulltextI18n: i18n } = create();
  const filename = '机构研究_10.1234_标题.pdf';
  const translated = i18n.translate('已检查“' + filename + '”：PDF 首页的文献 DOI 与目标条目不同，已阻止导入。', 'en');
  assert(translated.startsWith('Checked “' + filename + '”: '));
  assert(translated.endsWith('Import was blocked.'));
  assert(!han.test(translated.replace(filename, '')));
});

test('combined review sentences translate without rewriting unknown article content', () => {
  const { FulltextI18n: i18n } = create();
  const translated = i18n.translate('无法自动确认此 PDF 是否为目标论文。 请先预览，核对后再明确确认。', 'en');
  assert(!han.test(translated), translated);
  const title = '求助人下载了我的求助：一项中文研究';
  assert.equal(i18n.translate(title, 'en'), title);
});

test('backend data can load after the UI engine without a runtime translation service', () => {
  const scope = create({ backendFirst: false });
  const message = '下载文件夹检查未能启动，请重试。';
  assert.equal(scope.FulltextI18n.translate(message, 'en'), message);
  vm.runInNewContext(script, scope);
  assert.equal(scope.FulltextI18n.translate(message, 'en'), 'Download folder checks could not start. Try again.');
  assert.equal(scope.FulltextI18nBackendData.length, rows.length);
});
