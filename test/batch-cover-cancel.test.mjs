import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const sender = { id: 'extension', tab: { id: 1, incognito: false }, frameId: 0, documentId: 'doc', url: 'https://www.bilibili.com/video/BVtest' };
function harness(fetch) {
  let listener;
  const timers = new Map();
  let seq = 0;
  const c = vm.createContext({
    URL, btoa, AbortController, fetch,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    chrome: {
      runtime: { id: 'extension', onInstalled: { addListener() {} }, onMessage: { addListener(fn) { listener = fn; } } },
      downloads: {}
    }
  });
  vm.runInContext(source, c);
  const call = (msg, from = sender) => new Promise((resolve) => listener(msg, from, resolve));
  const read = (requestId = 'cover-1', from = sender) => call({
    type: 'BILI_DL_DOWNLOAD_COVER', url: 'https://i0.hdslb.com/a.png', filename: 'a.png', forBatch: true, requestId
  }, from);
  const cancel = (from = sender, requestId = 'cover-1') => call({ type: 'BILI_DL_CANCEL_COVER', requestId }, from);
  return { c, timers, call, read, cancel };
}
function waitForAbort(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
for (const phase of ['headers', 'body']) {
  test(`cover cancellation aborts stalled ${phase}, settles reply and clears request state`, async () => {
    let signal;
    const h = harness(async (_url, opts) => {
      signal = opts.signal;
      if (phase === 'headers') return waitForAbort(signal);
      return { ok: true, headers: new Headers({ 'content-type': 'image/png' }), arrayBuffer: () => waitForAbort(signal) };
    });
    const pending = h.read();
    await new Promise(setImmediate);
    assert.equal((await h.cancel()).ok, true);
    assert.equal(signal.aborted, true);
    assert.match((await pending).error, /下载已取消/);
    assert.equal(h.timers.size, 0);
    assert.equal(vm.runInContext('batchCoverRequests.size', h.c), 0);
  });
}

test('cover timeout bounds stalled response body and cleans up', async () => {
  let signal;
  const h = harness(async (_url, opts) => {
    signal = opts.signal;
    return { ok: true, headers: new Headers({ 'content-type': 'image/png' }), arrayBuffer: () => waitForAbort(signal) };
  });
  const pending = h.read();
  await new Promise(setImmediate);
  const [{ fn, ms }] = h.timers.values();
  assert.equal(ms, 30000);
  fn();
  assert.match((await pending).error, /超时/);
  assert.equal(signal.aborted, true);
  assert.equal(h.timers.size, 0);
  assert.equal(vm.runInContext('batchCoverRequests.size', h.c), 0);
});

test('cover cancellation is isolated by tab, frame, document, privacy context and request ID', async () => {
  let signal;
  const h = harness((_url, opts) => { signal = opts.signal; return waitForAbort(signal); });
  const pending = h.read();
  for (const from of [
    { ...sender, tab: { id: 2 } }, { ...sender, frameId: 1 },
    { ...sender, documentId: 'another' }, { ...sender, tab: { id: 1, incognito: true } }
  ]) {
    await h.cancel(from);
    assert.equal(signal.aborted, false);
  }
  await h.cancel(sender, 'other-request');
  assert.equal(signal.aborted, false);
  assert.equal((await h.cancel({ ...sender, id: 'other-extension' })).ok, false);
  assert.equal((await h.cancel({ ...sender, url: 'https://evil.test/' })).ok, false);
  assert.equal((await h.read()).ok, false, 'duplicate IDs cannot replace live requests');
  await h.cancel();
  assert.equal((await pending).ok, false);
});

test('successful cover reads clear timers and allow reuse of a completed request ID', async () => {
  const h = harness(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }));
  for (let i = 0; i < 2; i++) {
    const result = await h.read();
    assert.equal(result.ok, true);
    assert.equal(result.base64, 'AQID');
    assert.equal(h.timers.size, 0);
  }
});

const content = await readFile(new URL('../content/content.js', import.meta.url), 'utf8');
for (const failure of ['timeout', 'cancel after context invalidation']) {
  test(`content cover wait settles on ${failure} without waiting for background`, async () => {
    let poll, timer, cancelled = false, cancelCalls = 0;
    const cleared = [];
    const c = vm.createContext({
      crypto, t: (key) => key,
      setInterval: (fn) => { poll = fn; return 1; },
      clearInterval: (id) => cleared.push(id),
      setTimeout: (fn, ms) => { assert.equal(ms, 35000); timer = fn; return 2; },
      clearTimeout: (id) => cleared.push(id),
      EXT: { runtime: { sendMessage: (msg) => {
        if (msg.type === 'BILI_DL_CANCEL_COVER') {
          cancelCalls++;
          throw new Error('Extension context invalidated');
        }
        return new Promise(() => {});
      } } }
    });
    vm.runInContext(content.slice(content.indexOf('    async function requestBatchCover('), content.indexOf('    async function saveListCover(')), c);
    const pending = c.requestBatchCover('https://i0.hdslb.com/a.png', 'a.png', () => cancelled);
    if (failure === 'timeout') timer();
    else { cancelled = true; poll(); }
    await assert.rejects(pending, failure === 'timeout' ? /batchCoverReadFailed/ : /下载已取消/);
    assert.equal(cancelCalls, 1);
    assert.deepEqual(cleared, [1, 2]);
  });
}
