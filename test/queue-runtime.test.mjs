import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../content/content.js', import.meta.url), 'utf8');
function queueHarness(overrides = {}) {
  const calls = [], states = [], actions = [];
  const c = vm.createContext({
    batchConcurrency: 3, queueRunning: false, pickingVideoDirectory: false, queueCancelled: false, queuePaused: false, operationMode: null,
    activeJobs: new Map(), videoInfo: { pages: [{}, {}, {}] }, location: { href: 'https://www.bilibili.com/video/BVoriginal' },
    selectedQn: 64, selectedFormat: 'mp4', streamPreference: 'high-bitrate', qualities: [],
    chapterSelection: { enabled: false, parts: new Map() },
    filenameTemplate: '{title} - {bvid} - {quality}',
    buildFilenameBase: (info) => String(info?.title || 'video'),
    startBtn: {}, queueBtn: {}, queueLabelEl: {}, statusEl: { classList: { add() {} }, querySelector: () => null },
    canStartCurrentDownload: () => true, isMultiPartVideo: () => true, getSelectedQualityLabel: () => '720P',
    syncJobListVisibility() {}, ensureMuxReady: async () => true, waitWhileQueuePaused: async () => {},
    createDownloadTask: (seed) => ({ ...seed, jobId: `p${seed.pageIndex}`, attempts: 0 }),
    mountJobCard() {}, updateProgress() {},
    agentCall: async (_type, args) => { calls.push(args); return { info: { title: `P${args.pageIndex}`, cid: args.pageIndex + 1 } }; },
    runSingleDownload: async () => ({}), addHistory: async () => {},
    pickBatchDirectory: async () => null,
    setTaskState: (_job, state) => states.push(state),
    TASK_STATE: { completed: 'completed', failed: 'failed', cancelled: 'cancelled' },
    classifyDownloadError: (e) => ({ type: /保存/.test(e.message) ? 'save' : /取消/.test(e.message) ? 'cancelled' : 'network', message: e.message }),
    debugLog() {}, setTimeout: (fn) => setTimeout(fn, 0),
    showStatus: (type, text) => states.push({ type, text }),
    t: (key) => key, translateUserError: (message) => message,
    appendTextElement: (_el, _tag, _class, text) => { const action = { text, dataset: {} }; actions.push(action); return action; },
    resetQueueCancelButton() {}, setQueueLabel() {}, refreshStartBtnForParallel() {},
    ...overrides
  });
  c.removeJobCard = (id) => c.activeJobs.delete(id);
  vm.runInContext(source.slice(source.indexOf('    function buildChapterPlan('), source.indexOf('    function snapshotKey(')), c);
  vm.runInContext(source.slice(source.indexOf('    async function prepareBatchDestination('), source.indexOf('    async function startListDownload(')), c);
  return { c, calls, states, actions };
}
test('chapter queue snapshots only selected ranges across parts and retries failed files', async () => {
  const chapters = [
    { number: 1, title: '跳过', start: 0, end: 5 },
    { number: 2, title: '第 1–2 集', start: 5, end: 10 },
    { number: 3, title: '第 3–4 集', start: 10, end: 15 }
  ];
  const parts = new Map([
    ['111', { cid: '111', index: 0, number: 1, title: '1~16', chapters, selected: new Set([2]) }],
    ['222', { cid: '222', index: 1, number: 2, title: '17~32', chapters, selected: new Set([3]) }]
  ]);
  const attempts = [], saved = [];
  let fail = true, picks = 0;
  const directory = {};
  const h = queueHarness({
    videoInfo: { title: '系列', aid: '100', bvid: 'BVoriginal' },
    chapterSelection: { enabled: true, parts },
    pickBatchDirectory: async () => { picks++; return directory; },
    runSingleDownload: async (info, opts) => {
      attempts.push([info.cid, opts.chapter.number, opts.chapter.start, opts.chapter.end, opts.qn]);
      assert.equal(opts.directory, directory);
      if (info.cid === '222' && fail) throw new Error('保存失败');
      return {};
    },
    addHistory: async (entry) => saved.push(entry.title)
  });
  await h.c.startQueueDownload();
  assert.equal(picks, 1);
  assert.deepEqual(attempts, [['111', 2, 5, 10, 64], ['222', 3, 10, 15, 64]]);
  assert.equal(h.calls.length, 0);
  h.c.videoInfo = null;
  h.c.selectedQn = 120;
  parts.clear();
  fail = false;
  await h.actions[0].onclick();
  assert.equal(picks, 2);
  assert.deepEqual(attempts.at(-1), ['222', 3, 10, 15, 64]);
  assert.deepEqual(saved, ['系列 - P1 · 第 1–2 集', '系列 - P2 · 第 3–4 集']);
});
test('queue runs in parallel and snapshots origin before SPA navigation', async () => {
  let active = 0, max = 0;
  const h = queueHarness({ runSingleDownload: async () => {
    max = Math.max(max, ++active);
    h.c.location.href = 'https://www.bilibili.com/video/BVother';
    await Promise.resolve(); active--;
    return {};
  } });
  await h.c.startQueueDownload();
  assert.equal(max, 3);
  assert.equal(h.calls.length, 3);
  assert.ok(h.calls.every((call) => call.href.endsWith('BVoriginal')));
  assert.equal(h.c.queueRunning, false);
});
test('double click during directory selection opens one picker and runs one queue', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const directory = {};
  let picks = 0;
  const h = queueHarness({
    pickBatchDirectory: () => { picks++; return pending; },
    runSingleDownload: async (_info, opts) => { assert.equal(opts.directory, directory); return {}; }
  });
  const first = h.c.startQueueDownload();
  await h.c.startQueueDownload();
  assert.equal(h.calls.length, 0);
  assert.equal(picks, 1);
  release(directory); await first;
  assert.equal(h.calls.length, 3);
});
test('failed-only retry excludes saved parts; save failures are not retried automatically', async () => {
  let rejectPart = true;
  const attempts = [];
  let picks = 0;
  const directory = {};
  const retryDirectory = {};
  const h = queueHarness({ batchConcurrency: 1, pickBatchDirectory: async () => ++picks === 1 ? directory : retryDirectory,
    runSingleDownload: async (info, opts) => {
    attempts.push([info.cid, opts.directory]);
    if (info.cid === 2 && rejectPart) throw new Error('浏览器保存失败');
    return {};
  } });
  await h.c.startQueueDownload();
  assert.deepEqual(attempts, [[1, directory], [2, directory]]);
  assert.equal(h.actions.length, 1);
  rejectPart = false;
  await h.actions[0].onclick();
  assert.deepEqual(attempts, [[1, directory], [2, directory], [2, retryDirectory], [3, retryDirectory]]);
  assert.equal(h.c.activeJobs.size, 0);
});
test('cancel during parsing never starts a download', async () => {
  let downloads = 0;
  const h = queueHarness({ agentCall: async () => { h.c.queueCancelled = true; return { info: { title: 'part' } }; },
    runSingleDownload: async () => { downloads++; } });
  await h.c.startQueueDownload();
  assert.equal(downloads, 0);
  assert.equal(h.c.queueRunning, false);
  assert.equal(h.c.activeJobs.size, 0);
});
test('startup failure always releases queue lock', async () => {
  const h = queueHarness({ ensureMuxReady: async () => { throw new Error('启动失败'); } });
  await h.c.startQueueDownload();
  assert.equal(h.c.queueRunning, false);
});

for (const concurrency of [1, 3, 5]) {
  test(`multi-P queue bounds active tasks at ${concurrency} and freezes settings`, async () => {
    let active = 0, peak = 0;
    const h = queueHarness({
      batchConcurrency: concurrency,
      videoInfo: { title: 'series', pages: Array.from({ length: 12 }, (_, i) => ({ page: i + 1 })) },
      runSingleDownload: async (_info, opts) => {
        peak = Math.max(peak, ++active);
        h.c.batchConcurrency = 1;
        assert.equal(opts.batchIndex, opts.pageIndex + 1);
        await new Promise(setImmediate);
        active--;
        return {};
      }
    });
    await h.c.startQueueDownload();
    assert.equal(peak, concurrency);
    assert.equal(h.calls.length, 12);
  });
}

test('out-of-order multi-P failures retry in original order with frozen numbers', async () => {
  const h = queueHarness();
  let retrying = false;
  const saved = [];
  h.c.runSingleDownload = async (info, opts) => {
    if (!retrying && info.cid === 1) await new Promise(setImmediate);
    if (!retrying && info.cid !== 2) throw new Error('保存失败');
    saved.push(opts.batchIndex);
    return {};
  };
  await h.c.startQueueDownload();
  assert.deepEqual(saved, [2]);
  retrying = true;
  await h.actions[0].onclick();
  assert.deepEqual(saved, [2, 1, 3]);
});

test('cancelled multi-P batch retains active and unstarted parts for retry', async () => {
  const h = queueHarness({ batchConcurrency: 1 });
  let cancel = true;
  const saved = [];
  h.c.runSingleDownload = async (_info, opts) => {
    if (cancel) { h.c.queueCancelled = true; throw new Error('下载已取消'); }
    saved.push(opts.batchIndex);
    return {};
  };
  await h.c.startQueueDownload();
  assert.equal(h.calls.length, 1);
  cancel = false;
  await h.actions[0].onclick();
  assert.deepEqual(saved, [1, 2, 3]);
});

test('concurrency is captured before the directory picker and later changes affect only new batches', async () => {
  let release;
  const h = queueHarness({
    batchConcurrency: 1,
    pickBatchDirectory: () => new Promise((resolve) => { release = resolve; })
  });
  let active = 0, peak = 0;
  h.c.runSingleDownload = async () => {
    peak = Math.max(peak, ++active);
    await new Promise(setImmediate);
    active--;
    return {};
  };
  const batch = h.c.startQueueDownload();
  h.c.batchConcurrency = 5;
  release(null);
  await batch;
  assert.equal(peak, 1);
});
