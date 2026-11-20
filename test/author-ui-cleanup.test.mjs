import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('runtime UI and background contain no author services or promotional entry points', async () => {
  for (const path of ['content/content.js', 'popup/popup.html', 'popup/popup.js', 'background.js', 'manifest.json',
    'shared/i18n.js', 'shared/i18n-extra.js', 'shared/i18n-ja-ko.js']) {
    const source = await read(path);
    assert.doesNotMatch(source, /mailto:|donate-|FEEDBACK_EMAIL|BILI_DL_FETCH_(?:JSON|ASSET)/, path);
    assert.doesNotMatch(source, /data-sheet="(?:donate|feedback|plugins|coop|notice)"/, path);
  }
  const content = await read('content/content.js');
  assert.match(content, /function showRetryableDownloadError\(/);
  assert.match(content, /copyTextToClipboard\(report\)/);
  assert.match(content, /timings: formatTaskTimings\(job\)/);
  assert.doesNotMatch(content, /feedbackEmailLabel|remoteContent|loadPluginCatalog|StoreRating/);
});

test('removed sheets cannot be opened programmatically, even with old cached content', async () => {
  const source = await read('content/content.js');
  const calls = [];
  const node = { classList: { add() {}, remove() {} } };
  const context = vm.createContext({
    menu: node, homeEl: node, pageEl: node, renderInfoSheet: (key) => calls.push(key),
    remoteContent: { donate: { enabled: true }, coop: { body: 'old promotion' } }
  });
  vm.runInContext(source.slice(source.indexOf('    function openInfoSheet('), source.indexOf("    panel.querySelectorAll('[data-sheet]')")), context);
  for (const key of ['donate', 'feedback', 'plugins', 'coop', 'notice']) context.openInfoSheet(key);
  assert.deepEqual(calls, []);
  for (const key of ['settings', 'tasks', 'diagnostics']) context.openInfoSheet(key);
  assert.deepEqual(calls, ['settings', 'tasks', 'diagnostics']);
});

test('packer includes power client and exclude donations and removed refresh transformations', async () => {
  for (const path of ['scripts/pack.py']) {
    const source = await read(path);
    assert.match(source, /shared\/download-power\.js/);
    assert.doesNotMatch(source, /donate-|DEBUG_REFRESH_MARKERS|REMOTE_CATALOG_DEBUG_REFRESH/);
  }
  const manifest = JSON.parse(await read('manifest.json'));
  assert.ok(manifest.permissions.includes('power'));
  const scripts = manifest.content_scripts.find((entry) => entry.js.includes('content/content.js')).js;
  assert.ok(scripts.indexOf('shared/download-power.js') < scripts.indexOf('content/content.js'));
});
