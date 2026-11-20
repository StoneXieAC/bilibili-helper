import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const clientSource = await readFile(new URL('../shared/download-power.js', import.meta.url), 'utf8');
const content = await readFile(new URL('../content/content.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function event() {
  const listeners = [];
  return { addListener: (fn) => listeners.push(fn), fire: (...args) => listeners.forEach((fn) => fn(...args)) };
}
const sender = { id: 'extension', url: 'https://www.bilibili.com/video/BVtest', tab: { id: 1 } };
function port(owner = sender) {
  return {
    name: 'BILI_DL_POWER', sender: owner, onMessage: event(), onDisconnect: event(), messages: [], disconnected: false,
    postMessage(message) { this.messages.push(message); },
    disconnect() { this.disconnected = true; this.onDisconnect.fire(); }
  };
}
function backgroundHarness({ supported = true, items = [], search, failPower = false } = {}) {
  const calls = [], intervals = new Map();
  let sequence = 0;
  const chrome = {
    runtime: { id: 'extension', onInstalled: event(), onMessage: event(), onConnect: event(), getManifest: () => ({ version: '1.3.7' }) },
    extension: { inIncognitoContext: false },
    downloads: {
      onChanged: event(), onErased: event(), onDeterminingFilename: event(),
      search: search || (async (query) => items.filter((item) => query.id === undefined ? item.state === 'in_progress' : item.id === query.id)),
      download: async () => 99
    },
    power: supported ? {
      requestKeepAwake: (level) => { calls.push(['request', level]); if (failPower) throw new Error('power unavailable'); },
      releaseKeepAwake: () => calls.push(['release'])
    } : undefined
  };
  const context = vm.createContext({ chrome, URL, crypto, console: { log() {}, info() {}, warn() {}, error() {} },
    setInterval: (fn, ms) => { assert.equal(ms, 20000); intervals.set(++sequence, fn); return sequence; },
    clearInterval: (id) => intervals.delete(id)
  });
  vm.runInContext(background, context);
  const connect = (owner) => { const p = port(owner); chrome.runtime.onConnect.fire(p); return p; };
  const state = (p, active) => p.onMessage.fire({ type: 'STATE', active });
  const send = (message) => new Promise((resolve) => chrome.runtime.onMessage.fire(message, sender, resolve));
  return { chrome, calls, intervals, connect, state, send, tick: () => [...intervals.values()].forEach((fn) => fn()) };
}
function clientHarness() {
  const ports = [], timers = new Map(), logs = [];
  let demand = false, seq = 0;
  const runtime = {
    connect: () => { const p = port(); ports.push(p); return p; }
  };
  const c = vm.createContext({
    setTimeout: (fn) => { timers.set(++seq, fn); return seq; }, clearTimeout: (id) => timers.delete(id)
  });
  vm.runInContext(clientSource, c);
  const client = c.BiliDlPower.createClient({ runtime, needed: () => demand, log: (...args) => logs.push(args) });
  return { api: c.BiliDlPower, client, runtime, ports, timers, logs,
    demand(value) { demand = value; client.update(); },
    retry() { const pending = [...timers.values()]; timers.clear(); pending.forEach((fn) => fn()); }
  };
}

test('task demand covers working stages, pauses, terminal states and queue gaps', () => {
  const { api } = clientHarness();
  for (const state of ['queued', 'preparing', 'downloading', 'merging', 'saving']) {
    assert.equal(api.needsPower([{ state }], false), true, state);
  }
  for (const state of ['paused', 'completed', 'failed', 'cancelled']) {
    assert.equal(api.needsPower([{ state }], false), false, state);
  }
  assert.equal(api.needsPower([{ state: 'paused' }], true), false);
  assert.equal(api.needsPower([{ state: 'paused' }, { state: 'merging' }], false), true);
  assert.equal(api.needsPower([{ state: 'paused' }, { state: 'saving' }], false), true);
  assert.equal(api.needsPower([], true), true);
  assert.equal(api.needsPower([], false), false);
});

test('multiple pages share one request; disconnect and pause release only the last owner', async () => {
  const h = backgroundHarness(); await flush(); h.calls.length = 0;
  const a = h.connect(), b = h.connect();
  h.state(a, true); h.state(b, true);
  assert.deepEqual(h.calls, [['request', 'system']]);
  h.state(a, false); a.disconnect();
  assert.equal(h.calls.length, 1);
  h.tick();
  assert.equal(b.messages.at(-1).type, 'POLL');
  assert.deepEqual(h.calls.at(-1), ['request', 'system']);
  b.disconnect();
  assert.deepEqual(h.calls.at(-1), ['release']);
  assert.equal(h.intervals.size, 0);
});

test('untrusted connections and malformed states cannot request power', async () => {
  const h = backgroundHarness(); await flush(); h.calls.length = 0;
  for (const owner of [{ ...sender, id: 'other' }, { ...sender, tab: undefined },
    { ...sender, url: 'https://bilibili.com.evil.example/' }, { ...sender, url: 'http://www.bilibili.com/' }]) {
    assert.equal(h.connect(owner).disconnected, true);
  }
  const p = h.connect();
  p.onMessage.fire({ type: 'STATE', active: 'true' });
  p.onMessage.fire({ type: 'OTHER', active: true });
  assert.equal(h.calls.length, 0);
});

test('client reconnects after worker loss, responds to polls and releases on pause/page exit', () => {
  const h = clientHarness();
  h.client.update(); assert.equal(h.ports.length, 0);
  h.demand(true);
  assert.equal(h.ports[0].messages.at(-1).active, true);
  h.ports[0].onMessage.fire({ type: 'POLL' });
  assert.equal(h.ports[0].messages.length, 2);
  h.ports[0].disconnect(); h.retry();
  assert.equal(h.ports.length, 2);
  h.demand(false);
  assert.equal(h.ports[1].disconnected, true);
  assert.equal(h.timers.size, 0);
  h.demand(true); h.client.stop(); h.retry();
  assert.equal(h.ports.length, 3);
  assert.equal(h.ports[2].disconnected, true);
  h.client.resume(); assert.equal(h.ports.length, 4);
});

test('missing power support and API errors leave downloads independent and produce diagnostics', async () => {
  const noPower = backgroundHarness({ supported: false });
  const p = noPower.connect();
  assert.equal(p.messages[0].unsupported, true);
  const h = clientHarness(); h.demand(true);
  h.ports[0].onMessage.fire(p.messages[0]);
  assert.equal(h.logs.length, 1); assert.equal(h.ports[0].disconnected, true);
  h.client.update(); assert.equal(h.ports.length, 1);
  const failing = backgroundHarness({ failPower: true }); await flush();
  const active = failing.connect(); failing.state(active, true);
  assert.equal(active.messages.at(-1).type, 'ERROR');
  active.disconnect(); assert.equal(failing.intervals.size, 0);
});

test('native save is protected during creation and until completion, independent of page lifetime', async () => {
  const item = { id: 99, byExtensionId: 'extension', state: 'in_progress' };
  const h = backgroundHarness({ items: [] }); await flush(); h.calls.length = 0;
  let resolveDownload;
  h.chrome.downloads.download = () => new Promise((resolve) => { resolveDownload = resolve; });
  h.chrome.downloads.search = async () => [item];
  const response = h.send({ type: 'BILI_DL_SAVE_MEDIA', url: 'blob:https://www.bilibili.com/media', filename: 'test.mp4' });
  assert.deepEqual(h.calls, [['request', 'system']]);
  resolveDownload(99); assert.equal((await response).ok, true); await flush();
  assert.equal(h.intervals.size, 1);
  item.state = 'complete'; h.chrome.downloads.onChanged.fire({ id: 99, state: { current: 'complete' } });
  assert.deepEqual(h.calls.at(-1), ['release']); assert.equal(h.intervals.size, 0);
});

test('native creation failure and completion before creation callback do not leak requests', async () => {
  const h = backgroundHarness(); await flush();
  h.chrome.downloads.download = async () => { throw new Error('save failed'); };
  const message = { type: 'BILI_DL_SAVE_MEDIA', url: 'blob:https://www.bilibili.com/media', filename: 'test.mp4' };
  assert.equal((await h.send(message)).ok, false);
  assert.equal(h.intervals.size, 0);
  h.chrome.downloads.download = async () => 99;
  h.chrome.downloads.search = async () => [{ id: 99, byExtensionId: 'extension', state: 'complete' }];
  assert.equal((await h.send(message)).ok, true); await flush();
  assert.equal(h.intervals.size, 0);
});

test('cover saves are protected until interrupted or erased', async () => {
  const item = { id: 12, byExtensionId: 'extension', state: 'in_progress' };
  const h = backgroundHarness(); await flush();
  h.chrome.downloads.search = async () => [item];
  h.chrome.downloads.download = (_options, cb) => cb(12);
  assert.equal((await h.send({ type: 'BILI_DL_DOWNLOAD_COVER', url: 'https://i0.hdslb.com/cover.jpg', filename: 'cover.jpg' })).ok, true);
  await flush(); assert.equal(h.intervals.size, 1);
  h.chrome.downloads.onErased.fire(12);
  assert.equal(h.intervals.size, 0);
});

test('restart recovers only owned downloads in the matching privacy context', async () => {
  const h = backgroundHarness({ items: [
    { id: 1, state: 'in_progress', byExtensionId: 'extension' },
    { id: 2, state: 'in_progress', byExtensionId: 'other' },
    { id: 3, state: 'in_progress', byExtensionId: 'extension', incognito: true }
  ] }); await flush();
  assert.deepEqual(h.calls.at(-1), ['request', 'system']);
  h.chrome.downloads.onChanged.fire({ id: 1, state: { current: 'interrupted' } });
  assert.deepEqual(h.calls.at(-1), ['release']); assert.equal(h.intervals.size, 0);
});

test('terminal event racing startup recovery cannot restore a stale download', async () => {
  let resolveSearch;
  const h = backgroundHarness({ search: () => new Promise((resolve) => { resolveSearch = resolve; }) });
  h.chrome.downloads.onChanged.fire({ id: 1, state: { current: 'complete' } });
  resolveSearch([{ id: 1, state: 'in_progress', byExtensionId: 'extension' }]); await flush();
  assert.equal(h.calls.some(([name]) => name === 'request'), false);
  assert.equal(h.intervals.size, 0);
});

test('content lifecycle updates the client on task states, membership and queue controls', () => {
  let updates = 0;
  const c = vm.createContext({ powerClient: { update: () => updates++ }, Date });
  vm.runInContext(content.slice(content.indexOf('    function setTaskState('), content.indexOf('    function classifyDownloadError(')), c);
  const job = {};
  for (const state of ['preparing', 'downloading', 'paused', 'merging', 'saving', 'completed', 'failed', 'cancelled']) c.setTaskState(job, state);
  assert.equal(updates, 8);
  assert.match(content, /function syncJobListVisibility\(\) \{\s*powerClient.update\(\)/);
  assert.match(content, /pagehide', \(\) => powerClient.stop\(\)/);
  assert.match(content, /pageshow', \(\) => powerClient.resume\(\)/);
  assert.match(content, /queueRunning && Boolean\(operationMode\) && !queuePaused && !queueCancelled/);
});

test('disconnect and messaging failures are diagnostic only; invalidated contexts stop retrying', () => {
  const h = clientHarness(); h.demand(true);
  h.ports[0].disconnect = () => { throw new Error('already closed'); };
  assert.doesNotThrow(() => h.demand(false));
  assert.equal(h.logs.length, 1);
  h.runtime.connect = () => { throw new Error('Extension context invalidated.'); };
  assert.doesNotThrow(() => h.demand(true));
  assert.equal(h.timers.size, 0);
});
