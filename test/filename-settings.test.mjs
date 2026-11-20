import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const require = createRequire(import.meta.url);

async function loadShared(name) {
  const code = await readFile(new URL(`../shared/${name}`, import.meta.url), 'utf8');
  const sandbox = { console, TextEncoder, module: { exports: {} }, exports: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox, { filename: name });
  return sandbox.module.exports || sandbox.BiliDlFilename || sandbox.BiliDlSettings;
}

const Filename = await loadShared('filename.js');

assert.equal(Filename.migrateStyleToTemplate('title'), '{title}');
assert.equal(Filename.migrateStyleToTemplate('title-bvid'), '{title} - {bvid}');
assert.equal(Filename.migrateStyleToTemplate('title-bvid-quality'), '{title} - {bvid} - {quality}');
assert.equal(Filename.migrateStyleToTemplate('detailed'), '{title} - {author} - {bvid} - {quality}');

assert.equal(Filename.validateTemplate('').ok, false);
assert.equal(Filename.validateTemplate('{title}/{bvid}').ok, false);
assert.equal(Filename.validateTemplate('{title} - {unknown}').ok, false);
assert.equal(Filename.validateTemplate('{title} - {bvid}').ok, true);

const base = Filename.renderTemplate('{title} - {author} - {bvid} - {part} - {index} - {quality} - {date}', {
  title: '测/试:标题',
  author: 'UP主',
  bvid: 'BV1GJ411x7h7',
  part: 3,
  partTitle: '分P'
}, {
  format: 'mp4',
  qualityLabel: '1080P',
  index: 4,
  createdAt: Date.parse('2026-09-15T12:00:00')
});
assert.match(base, /测_试_标题/);
assert.match(base, /03/);
assert.match(base, /04/);
assert.match(base, /1080P/);
assert.match(base, /2026-09-15/);
assert.equal(Filename.withExtension(base, 'mp4').endsWith('.mp4'), true);

const longBase = Filename.renderTemplate('{title} - {bvid} - {quality} - {date}', {
  title: '长'.repeat(100),
  bvid: 'BV1GJ411x7h7'
}, { qualityLabel: '1080P', date: '2026-11-19' });
assert.match(longBase, /^长+.* - BV1GJ411x7h7 - 1080P - 2026-11-19$/);
assert.ok(Buffer.byteLength(longBase + ' (12345).webp') <= 240);
const repeated = Filename.renderTemplate('{title} - {bvid} - {title} - {quality}', {
  title: '🎞'.repeat(100),
  bvid: 'BV1GJ411x7h7'
}, { qualityLabel: '1080P' });
assert.match(repeated, /^🎞+.* - BV1GJ411x7h7 - 🎞+.* - 1080P$/u);
assert.ok(Buffer.byteLength(repeated + ' (12345).mp4') <= 240);

assert.equal(Filename.sanitizeSegment('con', 'x'), '_con');
assert.equal(Filename.sanitizeSegment('hello.', 'x'), 'hello');

const SettingsCode = await readFile(new URL('../shared/download-settings.js', import.meta.url), 'utf8');
const store = {};
const settingsSandbox = {
  console,
  module: { exports: {} },
  exports: {},
  BiliDlFilename: Filename,
  chrome: {
    storage: {
      local: {
        async get(keys) {
          const out = {};
          for (const key of keys) out[key] = store[key];
          return out;
        },
        async set(values) {
          Object.assign(store, values);
        }
      }
    }
  }
};
settingsSandbox.globalThis = settingsSandbox;
vm.runInNewContext(SettingsCode, settingsSandbox, { filename: 'download-settings.js' });
const Settings = settingsSandbox.BiliDlSettings;

store.biliDlDownloadPrefs_v1 = { filenameStyle: 'detailed' };
const migrated = await Settings.loadSettings();
assert.equal(migrated.filenameTemplate, '{title} - {author} - {bvid} - {quality}');
delete store.biliDlSettings_v1;
delete store.biliDlDownloadPrefs_v1;
store.biliDlSettings_v1 = {
  version: 1,
  filenameTemplate: '{title} - {bvid}'
};
const loaded = await Settings.loadSettings();
assert.equal(loaded.filenameTemplate, '{title} - {bvid}');

await assert.rejects(() => Settings.saveSettings({ filenameTemplate: '{bad}' }));

const popupHtml = await readFile(new URL('../popup/popup.html', import.meta.url), 'utf8');
assert.doesNotMatch(popupHtml, /常见问题/);
assert.doesNotMatch(popupHtml, /隐私政策/);
assert.doesNotMatch(popupHtml, /popup-open-settings/);

const popup = await readFile(new URL('../popup/popup.js', import.meta.url), 'utf8');
assert.doesNotMatch(popup, /popup-open-settings/);

console.log('filename settings checks passed');

// Batch markers are independent of template fields and reserve both byte and character budgets.
assert.equal(Filename.renderTemplate('{title}', { title: '视频' }, { batchIndex: 1 }), '视频_p1');
assert.equal(Filename.renderTemplate('{title}_{index}_{part}', { title: '视频', part: 7 }, { index: 2, batchIndex: 2 }), '视频_02_07_p2');
for (const batchIndex of [1, 2, 100, 12345]) {
  for (const title of ['长'.repeat(500), '🎞'.repeat(500), 'a'.repeat(500)]) {
    const name = Filename.renderTemplate('{title}-{bvid}', { title, bvid: 'BVtest' }, { batchIndex });
    assert.ok(name.endsWith(`-BVtest_p${batchIndex}`));
    assert.ok(Array.from(name).length <= 120);
    assert.ok(Buffer.byteLength(name) <= 220);
    assert.ok(Filename.withExtension(name, 'm4a').endsWith(`_p${batchIndex}.m4a`));
  }
}
assert.equal(Settings.normalizeSettings({}).batchConcurrency, 3);
for (const value of [0, 6, -1, 1.5, '5', null]) {
  assert.equal(Settings.normalizeSettings({ batchConcurrency: value }).batchConcurrency, 3);
}
for (const value of [1, 3, 5]) {
  const saved = await Settings.saveSettings({ batchConcurrency: value });
  assert.equal(saved.batchConcurrency, value);
  assert.equal((await Settings.loadSettings()).batchConcurrency, value);
  assert.equal(saved.filenameTemplate, '{title} - {bvid}');
}
assert.equal((await Settings.resetSettings()).batchConcurrency, 3);
