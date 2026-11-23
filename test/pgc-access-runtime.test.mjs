import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../content/content.js', import.meta.url), 'utf8');
const agent = await readFile(new URL('../content/page-agent.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const allowed = { state: 'checked', video: true, audio: true };

test('简体中文剧集页匹配两个脚本，并通过官方剧集接口读取选集', async () => {
  const match = 'https://www.bilibili.com/zh-Hans/bangumi/play/*';
  for (const script of ['content/page-agent.js', 'content/content.js']) {
    assert.ok(manifest.content_scripts.some(entry => entry.js.includes(script) && entry.matches.includes(match)));
  }

  for (const [path, query] of [
    ['/zh-Hans/bangumi/play/ss1637?from_spmid=666.25.series.0', 'season_id=1637'],
    ['/zh-Hans/bangumi/play/ep123', 'ep_id=123'],
    ['/bangumi/play/ss1637', 'season_id=1637']
  ]) {
    const location = new URL(path, 'https://www.bilibili.com');
    const requests = [], replies = [];
    let onMessage;
    const window = {
      addEventListener(_type, listener) { onMessage = listener; },
      postMessage(message) { if (message.id) replies.push(message); }
    };
    vm.runInNewContext(agent, {
      window, location, URL, AbortController, setTimeout, clearTimeout,
      console: { log() {} },
      async fetch(url) {
        requests.push(url);
        return { ok: true, async json() {
          return { code: 0, result: { title: '测试剧集', episodes: [{ id: 123, aid: 1, cid: 2 }] } };
        } };
      }
    });
    await onMessage({ source: window, data: { source: 'bili-dl-panel', id: 'list', type: 'RESOLVE_LIST' } });
    assert.deepEqual(requests, [`https://api.bilibili.com/pgc/view/web/season?${query}`]);
    const [reply] = replies;
    assert.equal(reply.type, 'OK');
    assert.equal(reply.data.pgc, true);
    assert.equal(reply.data.items[0].epId, '123');
  }
});

function harness(count = 10) {
  let now = 0;
  const requests = [], timers = [], logs = [];
  const c = vm.createContext({
    isOpen: true, activeMode: 'list', queueRunning: false, document: { hidden: false },
    listDownloadKind: 'video', listContentParts: kind => kind.split('+').filter(Boolean),
    listItems: Array.from({ length: count }, (_, i) => ({ epId: `${i + 1}`, aid: `${i + 1}`, cid: `${i + 1}`, cover: 'cover' })),
    listItemKey: item => item.epId, selectedListKeys: new Set(), listCountEl: {},
    listItemsEl: { querySelectorAll: () => [] }, updateListSelection() {},
    t: (key, args) => args || key, debugLog: (...args) => logs.push(args),
    Date: { now: () => now },
    setTimeout: (fn, delay) => timers.push({ fn, at: now + delay }),
    agentCall: (type, payload) => new Promise((resolve, reject) => requests.push({ type, ...payload, resolve, reject })),
    listLoading: false, isSpaceCollectionsIndex: () => true
  });
  vm.runInContext(source.slice(source.indexOf('    const pgcAccessCache'), source.indexOf('    function listItemKey(')), c);
  // Exercise the real invalidation entrypoint, stopping before list I/O.
  vm.runInContext(source.slice(source.indexOf('    async function loadListItems('), source.indexOf('    async function loadMoreListItems(')), c);
  return { c, requests, logs, async advance(ms) {
    now += ms;
    const ready = timers.filter(timer => timer.at <= now);
    for (const timer of ready) {
      timers.splice(timers.indexOf(timer), 1);
      timer.fn();
    }
    await flush();
  } };
}

test('four independent slots publish results immediately and refill after 100 ms', async () => {
  const h = harness();
  h.c.schedulePgcAccessChecks();
  assert.equal(h.requests.length, 4);
  assert.ok(h.requests.every(request => request.type === 'CHECK_PGC_ACCESS'));
  h.requests[2].resolve(allowed);
  await flush();
  assert.equal(h.c.canSelectListItem(h.c.listItems[2]), true);
  assert.equal(h.c.canSelectListItem(h.c.listItems[0]), false);
  h.c.schedulePgcAccessChecks();
  await h.advance(99);
  assert.equal(h.requests.length, 4);
  await h.advance(1);
  assert.equal(h.requests.length, 5);
  assert.equal(h.requests[4].epId, '5');
  for (const index of [0, 1, 3, 4]) h.requests[index].resolve(allowed);
  await flush();
  await h.advance(100);
  assert.equal(h.requests.length, 9);
  assert.equal(new Set(h.requests.map(request => request.epId)).size, 9);
});

test('failure, timeout and UI errors release slots without retry loops', async () => {
  const h = harness(6);
  h.c.schedulePgcAccessChecks();
  h.c.listItemsEl.querySelectorAll = () => { throw new Error('detached UI'); };
  h.requests[0].reject(new Error('network failed'));
  h.requests[1].reject(new Error('页面代理超时，请刷新页面重试'));
  await flush();
  assert.equal(h.c.pgcAccess(h.c.listItems[0]).reason, 'error');
  assert.equal(h.c.pgcAccess(h.c.listItems[1]).reason, 'error');
  assert.equal(h.logs.length, 2);
  await h.advance(100);
  assert.equal(h.requests.length, 6);
  assert.equal(new Set(h.requests.map(request => request.epId)).size, 6);
});

for (const condition of ['closed', 'hidden', 'video', 'queue', 'cover', 'empty']) {
  test(`cooldown rechecks ${condition} state and resumes when eligible`, async () => {
    const h = harness(5);
    h.c.schedulePgcAccessChecks();
    h.requests[0].resolve(allowed);
    await flush();
    if (condition === 'closed') h.c.isOpen = false;
    if (condition === 'hidden') h.c.document.hidden = true;
    if (condition === 'video') h.c.activeMode = 'video';
    if (condition === 'queue') h.c.queueRunning = true;
    if (condition === 'cover') h.c.listDownloadKind = 'cover';
    if (condition === 'empty') h.c.listDownloadKind = '';
    await h.advance(100);
    h.c.schedulePgcAccessChecks();
    assert.equal(h.requests.length, 4);
    Object.assign(h.c, { isOpen: true, activeMode: 'list', queueRunning: false, listDownloadKind: 'video' });
    h.c.document.hidden = false;
    h.c.schedulePgcAccessChecks();
    assert.equal(h.requests.length, 5);
  });
}

test('cache suppresses repeat requests, expires after three minutes and cover needs no checks', async () => {
  const h = harness(1);
  h.c.listDownloadKind = 'cover';
  h.c.schedulePgcAccessChecks();
  assert.equal(h.requests.length, 0);
  assert.equal(h.c.canSelectListItem(h.c.listItems[0]), true);
  h.c.listDownloadKind = 'video';
  h.c.schedulePgcAccessChecks();
  h.requests[0].resolve(allowed);
  await flush();
  await h.advance(100);
  h.c.schedulePgcAccessChecks();
  assert.equal(h.requests.length, 1);
  await h.advance(180000);
  h.c.schedulePgcAccessChecks();
  assert.equal(h.requests.length, 2);
});

test('forced refresh ignores stale success and failure without exceeding four slots', async () => {
  const h = harness(4);
  h.c.schedulePgcAccessChecks();
  await h.c.loadListItems(true);
  h.c.schedulePgcAccessChecks();
  assert.equal(h.requests.length, 4);
  h.requests[0].resolve(allowed);
  h.requests[1].reject(new Error('old error'));
  await flush();
  assert.equal(h.c.pgcAccess(h.c.listItems[0]), null);
  assert.equal(h.c.pgcAccess(h.c.listItems[1]), null);
  await h.advance(100);
  assert.equal(h.requests.length, 6);
  assert.deepEqual(h.requests.slice(4).map(request => request.epId), ['1', '2']);
  h.requests[4].resolve(allowed);
  await flush();
  assert.equal(h.c.canSelectListItem(h.c.listItems[0]), true);
});

test('in-flight checks update only their own keys after switching lists', async () => {
  const h = harness(4);
  h.c.schedulePgcAccessChecks();
  h.c.listItems = [{ epId: '99', aid: '99', cid: '99' }];
  h.requests[0].resolve(allowed);
  await flush();
  assert.equal(h.c.canSelectListItem(h.c.listItems[0]), false);
  await h.advance(100);
  assert.equal(h.requests[4].epId, '99');
});

test('restricted results remain unselectable and are not repeatedly checked', async () => {
  const h = harness(1);
  h.c.schedulePgcAccessChecks();
  h.requests[0].resolve({ state: 'blocked', reason: 'permission', video: false, audio: false });
  await flush();
  assert.equal(h.c.pgcAccessLabel(h.c.listItems[0]), 'pgcPermission');
  assert.equal(h.c.canSelectListItem(h.c.listItems[0]), false);
  await h.advance(100);
  assert.equal(h.requests.length, 1);
});

test('list durations use whole seconds', () => {
  const c = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('    function formatDuration('), source.indexOf('    function listDownloadKindLabel(')), c);
  for (const [input, expected] of [[1355.177, '22:35'], [1356, '22:36'], [60.9, '1:00'], [0, '0:00'], [-1, '0:00'], [undefined, '0:00']]) {
    assert.equal(c.formatDuration(input), expected);
  }
});
