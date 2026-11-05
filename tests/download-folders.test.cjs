const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path').win32;
const { normalize, discover } = require('../src/download-folders.js');

function setup() {
  const locations = { DfltDwnld: 'C:\\Users\\Test\\Downloads', Home: 'C:\\Users\\Test', LocalAppData: 'C:\\Users\\Test\\AppData\\Local' };
  const files = new Map(), children = new Map(), reads = [], stats = [];
  const bases = {
    Edge: path.join(locations.LocalAppData, 'Microsoft', 'Edge', 'User Data'),
    Chrome: path.join(locations.LocalAppData, 'Google', 'Chrome', 'User Data'),
  };
  const env = {
    locations, files, children, reads, stats, bases,
    directory(value) { files.set(value, { type: 'directory' }); return value; },
    profile(browser, name, content, info = {}) {
      const folder = path.join(bases[browser], name), preference = path.join(folder, 'Preferences');
      const text = typeof content === 'string' ? content : JSON.stringify(content);
      children.set(bases[browser], [...(children.get(bases[browser]) || []), folder]);
      files.set(preference, { type: 'regular', size: text.length, text, ...info });
      return preference;
    },
  };
  env.directory(locations.DfltDwnld);
  env.discover = () => discover({
    Services: { dirsvc: { get(key) {
      if (!locations[key]) throw new Error('Unavailable special directory');
      return { path: locations[key] };
    } } },
    PathUtils: { join: path.join, filename: path.basename },
    IOUtils: {
      async stat(value) {
        stats.push(value);
        if (!files.has(value)) throw new Error('File not found');
        const { text, ...info } = files.get(value);
        return info;
      },
      async getChildren(value) {
        if (!children.has(value)) throw new Error('Folder unavailable');
        return children.get(value);
      },
      async readUTF8(value) {
        reads.push(value);
        if (!files.has(value)) throw new Error('File not found');
        return files.get(value).text;
      },
    },
  });
  return env;
}

test('normalization trims absolute paths and removes duplicates across Windows case and separators', () => {
  assert.deepEqual(normalize([
    '  C:\\Downloads\\ ', 'c:/downloads/', 'D:\\Papers', 'd:\\PAPERS\\',
    '\\\\server\\share\\Downloads\\', '/mnt/papers/',
    '', 'relative\\downloads', 'C:relative', 'https://example.test/downloads', 3, null, {},
    'C:\\' + 'x'.repeat(4096),
  ]), ['C:\\Downloads', 'D:\\Papers', '\\\\server\\share\\Downloads', '/mnt/papers']);
  assert.deepEqual(normalize(null), []);
});

test('the platform download folder is returned without reading unrelated profile data', async () => {
  const env = setup();
  assert.deepEqual(await env.discover(), [env.locations.DfltDwnld]);
  assert.deepEqual(env.reads, []);
});

test('the home Downloads folder is used when the platform download-directory key is unavailable', async () => {
  const env = setup();
  delete env.locations.DfltDwnld;
  assert.deepEqual(await env.discover(), ['C:\\Users\\Test\\Downloads']);
});

test('Edge and Chrome profile download.default_directory values are discovered and deduplicated', async () => {
  const env = setup();
  const lab = env.directory('D:\\LabDownloads'), incoming = env.directory('E:\\Incoming'), shared = env.directory('\\\\server\\papers');
  const allowed = [
    env.profile('Edge', 'Default', { download: { default_directory: lab }, account: { unrelated: 'must-not-be-returned' } }),
    env.profile('Edge', 'Profile 1', { download: { default_directory: incoming } }),
    env.profile('Chrome', 'Default', { download: { default_directory: 'd:/labdownloads/' } }),
    env.profile('Chrome', 'Profile 3', { download: { default_directory: shared } }),
  ];
  assert.deepEqual(await env.discover(), [env.locations.DfltDwnld, lab, incoming, shared]);
  assert.deepEqual(env.reads, allowed);
  assert(env.reads.every(value => value.endsWith('\\Preferences')));
});

test('non-profile folders and invalid or absent preference files are ignored', async () => {
  const env = setup(), custom = env.directory('D:\\ValidDownloads');
  const ignored = [];
  for (const name of ['Guest Profile', 'System Profile', 'Default Backup', 'Profile x', 'Crashpad']) {
    ignored.push(env.profile('Edge', name, { download: { default_directory: custom } }));
  }
  env.profile('Edge', 'Default', '{ this is not JSON');
  const missing = env.profile('Edge', 'Profile 1', { download: { default_directory: custom } });
  env.files.delete(missing);
  env.profile('Edge', 'Profile 2', { download: { default_directory: 'D:\\DoesNotExist' } });
  env.profile('Edge', 'Profile 3', { download: { default_directory: 42 } });
  ignored.push(env.profile('Edge', 'Profile 4', { download: { default_directory: custom } }, { type: 'symlink' }));
  ignored.push(env.profile('Edge', 'Profile 5', { download: { default_directory: custom } }, { size: 11 * 1024 * 1024 }));
  env.profile('Edge', 'Profile 6', { download: { default_directory: 'relative\\Downloads' } });
  env.profile('Edge', 'Profile 7', { unrelated: { default_directory: custom }, download: { directory: custom } });
  assert.deepEqual(await env.discover(), [env.locations.DfltDwnld]);
  assert(ignored.every(value => !env.reads.includes(value)));
  assert(!env.reads.includes(missing));
});

test('an unavailable browser profile base does not prevent discovery from another browser', async () => {
  const env = setup(), chrome = env.directory('D:\\ChromeDownloads');
  env.profile('Chrome', 'Default', { download: { default_directory: chrome } });
  assert.deepEqual(await env.discover(), [env.locations.DfltDwnld, chrome]);
});

test('missing, regular-file and symlink download locations are excluded', async () => {
  const env = setup();
  env.files.delete(env.locations.DfltDwnld);
  env.profile('Edge', 'Default', { download: { default_directory: 'D:\\Missing' } });
  env.files.set('D:\\File', { type: 'regular', size: 100 });
  env.profile('Chrome', 'Default', { download: { default_directory: 'D:\\File' } });
  env.files.set('D:\\Link', { type: 'symlink' });
  env.profile('Chrome', 'Profile 1', { download: { default_directory: 'D:\\Link' } });
  assert.deepEqual(await env.discover(), []);
});

test('normalization preserves filesystem roots chosen as the download directory', () => {
  assert.deepEqual(normalize(['D:\\', 'd:/', '/']), ['D:\\', '/']);
});
