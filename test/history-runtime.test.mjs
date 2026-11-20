import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
function harness(storage = new Map()) {
  let listener, fail = false;
  const context = vm.createContext({
    URL, console,
    chrome: {
      downloads: {},
      runtime: {
        id: 'extension', getURL: path => 'chrome-extension://extension/' + path,
        onInstalled: { addListener() {} }, onMessage: { addListener(fn) { listener = fn; } }
      },
      storage: { local: {
        async get(key) {
          const snapshot = structuredClone(storage.get(key) || []);
          await new Promise(setImmediate);
          return { [key]: snapshot };
        },
        async set(value) {
          if (fail) { fail = false; throw new Error('storage failed'); }
          await new Promise(setImmediate);
          for (const [key, items] of Object.entries(value)) storage.set(key, structuredClone(items));
        }
      } }
    }
  });
  vm.runInContext(source, context);
  const sender = { id: 'extension', url: 'https://www.bilibili.com/video/BVtest', tab: { id: 1 } };
  function call(message, from = sender) {
    return new Promise((resolve) => {
      let replied = false;
      const handled = listener(message, from, (value) => { replied = true; resolve(value); });
      // A missing message handler should fail a regression, not hang the suite.
      assert.ok(handled === true || replied, 'history message must be handled');
    });
  }
  return { call, sender, get stored() { return storage.get('biliDlHistory') || []; },
    get privateStored() { return storage.get('biliDlHistoryPrivate') || []; },
    seed: value => { storage.set('biliDlHistory', value); }, failNextWrite: () => { fail = true; } };
}
const entry = (cid, format = 'mp4') => ({ bvid: 'BVtest' + cid, cid: String(cid), title: '视频' + cid, format, ts: cid });
const add = item => ({ type: 'BILI_DL_ADD_HISTORY', entry: item });
const popup = { id: 'extension', url: 'chrome-extension://extension/popup/popup.html' };

test('simultaneous completions from multiple tabs keep every history entry', async () => {
  const h = harness();
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    h.call(add(entry(index + 1)), { ...h.sender, tab: { id: index + 1 } })));
  assert.ok(results.every(result => result.ok));
  assert.equal(h.stored.length, 20);
  assert.equal(new Set(h.stored.map(item => item.cid)).size, 20);
});

test('history deduplicates by part and format, migrates missing CID and caps at 50', async () => {
  const h = harness();
  h.seed([{ bvid: 'BVtest1', pageIndex: 0, title: '旧记录', format: 'mp4-video' }]);
  await h.call(add(entry(1)));
  await h.call(add(entry(1, 'm4a')));
  await h.call(add({ ...entry(1), title: '最新记录' }));
  assert.deepEqual(h.stored.map(item => [item.format, item.title]), [['mp4', '最新记录'], ['m4a', '视频1']]);
  for (let cid = 2; cid <= 55; cid++) await h.call(add(entry(cid)));
  assert.equal(h.stored.length, 50);
  assert.equal(h.stored[0].cid, '55');
});

test('failed history writes do not poison later writes; popup clear shares the queue', async () => {
  const h = harness();
  h.failNextWrite();
  assert.equal((await h.call(add(entry(1)))).ok, false);
  const before = h.call(add(entry(2)));
  const cleared = h.call({ type: 'BILI_DL_CLEAR_HISTORY' }, popup);
  const after = h.call(add(entry(3)));
  assert.ok((await before).ok && (await cleared).ok && (await after).ok);
  assert.deepEqual(h.stored.map(item => item.cid), ['3']);
});

test('history messages reject other senders and page-initiated clearing', async () => {
  const h = harness();
  assert.equal((await h.call({ type: 'BILI_DL_CLEAR_HISTORY' }, { ...popup, id: 'other' })).ok, false);
  assert.equal((await h.call({ type: 'BILI_DL_CLEAR_HISTORY' })).ok, false);
  assert.equal((await h.call(add(entry(1)), { ...h.sender, tab: undefined })).ok, false);
  assert.equal((await h.call(add(entry(1)), { ...h.sender, id: 'other' })).ok, false);
  assert.equal((await h.call(add({ title: '无视频标识' }))).ok, false);
  assert.deepEqual(h.stored, []);
});

test('split backgrounds keep ordinary and private histories independent', async () => {
  const storage = new Map();
  const normal = harness(storage), privateContext = harness(storage);
  await Promise.all([
    normal.call(add(entry(1))),
    privateContext.call(add(entry(2)), { ...privateContext.sender, tab: { id: 2, incognito: true } })
  ]);
  assert.deepEqual(normal.stored.map(item => item.cid), ['1']);
  assert.deepEqual(privateContext.privateStored.map(item => item.cid), ['2']);
  assert.equal((await privateContext.call({ type: 'BILI_DL_CLEAR_HISTORY', incognito: true }, popup)).ok, true);
  assert.deepEqual(normal.stored.map(item => item.cid), ['1']);
  assert.deepEqual(privateContext.privateStored, []);
});
