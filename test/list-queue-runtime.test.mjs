import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../content/content.js', import.meta.url), 'utf8');
function harness(saveFailure = false, listDownloadKind = 'video') {
  let active = 0, peak = 0, calls = 0;
  const stored = {};
  const items = Array.from({length: 35}, (_, i) => ({ bvid: 'BV' + i, aid: i + 1, cid: i + 1, title: 'video' + i }));
  const c = vm.createContext({ listItems: items, selectedListKeys: new Set(items.map(i => i.bvid)),
    pendingListSync: false, listLoading: false, spaceGathering: false, activeMode: 'list',
    batchConcurrency: 3, queueRunning: false, pickingVideoDirectory: false, queueCancelled: false, queuePaused: false, operationMode: null,
    selectedQn: 80, effectiveQualityStrategy: () => 'exact', streamPreference: 'high-bitrate', listDownloadKind, activeJobs: new Map(),
    prepareBatchDestination: async () => null, isSpacePage: () => false, isSpaceCollectionPage: () => false,
    canSelectListItem: () => true, listItemKey: (item) => item.bvid,
    listContentParts: (kind) => kind === 'both' ? ['video', 'audio'] : kind.split('+').filter(Boolean),
    incompleteKey: () => 'checkpoint', ensureListItemVideoIds: async () => {},
    EXT: { storage: { local: {
      get: async (key) => ({ [key]: stored[key] }),
      set: async (values) => Object.assign(stored, structuredClone(values)),
      remove: async (key) => { delete stored[key]; }
    } } }, t: (key) => key,
    listStartBtn: {}, listItemsEl: { querySelectorAll: () => [] }, lastListFailures: [],
    syncJobListVisibility() {}, updateListRetryFailed() {}, setListStatus() {}, waitWhileQueuePaused: async () => {},
    listDownloadKindLabel: (kind) => ({ video: '仅视频', audio: '仅音频', both: '视频+音频' })[kind] || '仅视频',
    filenameTemplate: '{title}', buildFilenameBase: (item, _quality, format) => `${item.title}-${format}`,
    getSelectedQualityLabel: () => '1080P', createDownloadTask: x => x, mountJobCard() {}, updateProgress() {},
    agentCall: async () => ({ qualities: [{ qn: 80, label: '1080P' }] }),
    runSingleDownload: async () => { calls++; peak = Math.max(peak, ++active); await Promise.resolve(); active--; if(saveFailure) throw new Error('保存失败'); return {}; },
    TASK_STATE: {}, setTaskState() {}, addHistory: async () => {}, debugLog() {},
    classifyDownloadError: e => ({ type: 'save', message: e.message }), resetQueueCancelButton() {},
    updateListSelection() {}, refreshStartBtnForParallel() {}, noteDownloadSuccessForRating() {},
    schedulePgcAccessChecks() { assert.equal(c.queueRunning, false); c.accessResumes = (c.accessResumes || 0) + 1; },
    setTimeout: fn => setTimeout(fn, 0)
  });
  c.removeJobCard = id => c.activeJobs.delete(id);
  vm.runInContext(source.slice(source.indexOf('    async function restoreIncompleteTasks('), source.indexOf('    let activeMode')), c);
  vm.runInContext(source.slice(source.indexOf('    async function startListDownload('), source.indexOf('    function openMenuShell(')), c);
  return { c, stored, stats: () => ({calls, peak}) };
}

test('space retries retain the captured tier for unstarted tasks after navigation', async () => {
  const { c, stored } = harness();
  c.listItems = c.listItems.slice(0, 2);
  c.batchConcurrency = 1;
  c.selectedQn = 0;
  c.isSpacePage = () => true;
  c.spaceQualityTier = '720';
  c.waitWhileQueuePaused = async () => { c.queueCancelled = true; };
  await c.startListDownload();
  assert.equal(stored.checkpoint.length, 2);
  const restored = structuredClone(stored.checkpoint);
  c.isSpacePage = () => false;
  c.waitWhileQueuePaused = async () => {};
  c.chooseSpaceQuality = (available, tier) => {
    assert.equal(tier, '720');
    return available.find(item => item.qn === 64);
  };
  c.agentCall = async () => ({ qualities: [{ qn: 120, label: '4K' }, { qn: 64, label: '720P' }] });
  const saved = [];
  c.runSingleDownload = async (_item, opts) => { saved.push(opts.qn); return {}; };
  await c.startListDownload(restored);
  assert.deepEqual(saved, [64, 64]);
  assert.equal(stored.checkpoint, undefined);
});

test('unstarted highest-quality tasks restore their original strategy on retry', async () => {
  const { c } = harness();
  c.listItems = c.listItems.slice(0, 1);
  c.effectiveQualityStrategy = () => 'highest';
  c.waitWhileQueuePaused = async () => { c.queueCancelled = true; };
  await c.startListDownload();
  c.effectiveQualityStrategy = () => 'exact';
  c.waitWhileQueuePaused = async () => {};
  c.agentCall = async () => ({ qualities: [{ qn: 80, label: '1080P' }, { qn: 120, label: '4K' }] });
  const saved = [];
  c.runSingleDownload = async (_item, opts) => { saved.push(opts.qn); return {}; };
  await c.startListDownload(c.lastListFailures);
  assert.deepEqual(saved, [120]);
});

test('resolved retry quality remains frozen after a save failure', async () => {
  const { c } = harness();
  c.listItems = c.listItems.slice(0, 1);
  c.isSpacePage = () => true;
  c.spaceQualityTier = 'highest';
  c.chooseSpaceQuality = available => available[0];
  c.runSingleDownload = async () => { throw new Error('保存失败'); };
  await c.startListDownload();
  c.agentCall = async () => ({ qualities: [{ qn: 120, label: '4K' }, { qn: 80, label: '1080P' }] });
  const saved = [];
  c.runSingleDownload = async (_item, opts) => { saved.push(opts.qn); return {}; };
  await c.startListDownload(c.lastListFailures);
  assert.deepEqual(saved, [80]);
});
test('35 selected videos save in parallel and release active jobs', async () => {
  const h = harness(); await h.c.startListDownload();
  assert.deepEqual(h.stats(), { calls: 35, peak: 3 });
  assert.equal(h.c.activeJobs.size, 0); assert.equal(h.c.queueRunning, false);
  assert.equal(h.c.accessResumes, 1);
});
test('disk save failure stops subsequent downloads and preserves unfinished items for retry', async () => {
  const h = harness(true); h.c.batchConcurrency = 1; await h.c.startListDownload();
  assert.equal(h.stats().calls, 1); assert.equal(h.c.lastListFailures.length, 35);
  assert.equal(h.c.queueRunning, false); assert.equal(h.c.activeJobs.size, 0);
  assert.equal(h.c.accessResumes, 1);
});
test('cancel before first item retains all pending items for retry', async () => {
  const h = harness();
  h.c.waitWhileQueuePaused = async () => { h.c.queueCancelled = true; };
  await h.c.startListDownload();
  assert.equal(h.stats().calls, 0);
  assert.equal(h.c.lastListFailures.length, 35);
  assert.equal(h.c.queueRunning, false);
  assert.equal(h.c.accessResumes, 1);
});
test('successful queue deselects saved videos to avoid repeating them', async () => {
  const h = harness(); await h.c.startListDownload();
  assert.equal(h.c.selectedListKeys.size, 0);
});

test('视频+音频复用 MP4 合成阶段的音频，不再次拉取 M4A', async () => {
  const h = harness(false, 'both');
  const formats = [];
  let reused = 0;
  h.c.runSingleDownload = async (_item, options) => {
    formats.push(options.format);
    return options.format === 'mp4' ? { audioBlob: { size: 1024 } } : {};
  };
  h.c.saveReusedAudio = async (result) => {
    assert.equal(result.audioBlob.size, 1024);
    reused += 1;
    return { audioOnly: true, reusedAudio: true };
  };
  await h.c.startListDownload();
  assert.equal(formats.filter((format) => format === 'mp4').length, 35);
  assert.equal(formats.filter((format) => format === 'm4a').length, 0);
  assert.equal(reused, 35);
});

test('没有独立音轨可复用时，视频+音频仍回退下载 M4A', async () => {
  const h = harness(false, 'both');
  const formats = [];
  h.c.runSingleDownload = async (_item, options) => {
    formats.push(options.format);
    return {};
  };
  h.c.saveReusedAudio = async () => null;
  await h.c.startListDownload();
  assert.equal(formats.filter((format) => format === 'mp4').length, 35);
  assert.equal(formats.filter((format) => format === 'm4a').length, 35);
});

test('取消选择目录保留勾选、待重试项及磁盘检查点', async () => {
  const { c, stats } = harness();
  const previousFailures = [{ item: c.listItems[0], downloadKind: 'video' }];
  c.lastListFailures = previousFailures;
  c.prepareBatchDestination = async () => undefined;
  c.EXT.storage.local.set = c.EXT.storage.local.remove = async () => assert.fail('目录确认前不能更新检查点');
  await c.startListDownload(previousFailures);
  assert.equal(c.lastListFailures, previousFailures);
  assert.equal(c.selectedListKeys.size, 35);
  assert.equal(stats().calls, 0);
  assert.equal(c.queueRunning, false);
});

test('站内切到单视频后，任务中心重试在点击中选择目录并下载原任务', async () => {
  const { c, stored } = harness();
  const [item, otherItem] = c.listItems;
  const event = { isTrusted: true };
  const directory = {};
  let syncs = 0;
  let picks = 0;
  const saves = [];
  c.activeMode = 'video';
  c.pendingListSync = true;
  c.scheduleListSync = () => { syncs++; };
  c.setDownloadMode = async (mode) => { c.activeMode = mode; };
  c.prepareBatchDestination = async (click) => {
    assert.equal(click, event);
    picks++;
    return directory;
  };
  c.runSingleDownload = async (downloadItem, options) => {
    saves.push([downloadItem, options.directory]);
    return {};
  };
  await c.startListDownload(null, event);
  assert.equal(syncs, 1);
  assert.equal(picks, 0);

  const first = { item, downloadKind: 'video', checkpointKey: 'original' };
  const untouched = { item: otherItem, downloadKind: 'audio' };
  const otherPage = [{ item, downloadKind: 'cover' }];
  stored.original = [first, untouched];
  stored.checkpoint = otherPage;
  c.lastListFailures = otherPage;
  c.listItems = [];
  const retry = c.startListDownload([first], event);
  assert.equal(picks, 1);
  await retry;
  await new Promise(setImmediate);
  assert.deepEqual(saves, [[item, directory]]);
  assert.equal(syncs, 1);
  assert.deepEqual(stored.original, [untouched]);
  assert.equal(stored.checkpoint, otherPage);
  assert.deepEqual(Array.from(c.lastListFailures, (task) => [task.downloadKind, task.checkpointKey]), [['cover', 'checkpoint']]);
  assert.equal(c.selectedListKeys.has(item.bvid), true);
});

test('混合输出共用目录，磁盘失败后只重试未保存输出', async () => {
  const { c } = harness(false, 'video+audio+cover');
  c.batchConcurrency = 1;
  c.listItems.length = 2;
  const directory = {};
  const retryDirectory = {};
  const calls = [];
  let picks = 0;
  c.prepareBatchDestination = async () => ++picks === 1 ? directory : retryDirectory;
  c.runSingleDownload = async (item, options) => {
    calls.push([item.title, options.format, options.directory]);
    return { audioBlob: { size: 12 } };
  };
  c.saveReusedAudio = async (_result, _name, _cancel, _jobId, title, destination) => {
    calls.push([title, 'm4a', destination]);
    return {};
  };
  c.saveListCover = async (item, _cancel, _options, destination) => {
    calls.push([item.title, 'cover', destination]);
    if (destination === directory) throw new Error('保存阶段失败');
  };
  await c.startListDownload();
  assert.deepEqual(calls, ['mp4', 'm4a', 'cover'].map((format) => ['video0', format, directory]));
  assert.deepEqual(Array.from(c.lastListFailures, (task) => task.downloadKind), ['cover', 'video+audio+cover']);
  assert.ok(c.lastListFailures.every((task) => task.checkpointKey === 'checkpoint'));
  await c.startListDownload(c.lastListFailures);
  assert.deepEqual(calls.slice(3), [
    ['video0', 'cover', retryDirectory],
    ...['mp4', 'm4a', 'cover'].map((format) => ['video1', format, retryDirectory])
  ]);
  assert.equal(c.lastListFailures.length, 0);
});

for (const concurrency of [1, 3, 5]) {
  test(`list queue uses ${concurrency} slots and refills without awaiting the slowest item`, async () => {
    const h = harness();
    h.c.batchConcurrency = concurrency;
    await h.c.startListDownload();
    assert.equal(h.stats().peak, concurrency);
    assert.equal(h.stats().calls, 35);
    assert.equal(h.stored.checkpoint, undefined);
  });
}

test('selected items receive batch p1/p2 regardless of original position or completion order', async () => {
  const { c, stored } = harness();
  c.selectedListKeys = new Set(['BV2', 'BV6']);
  const saved = [];
  c.buildFilenameBase = (item, _qn, format, opts) => `${item.title}_p${opts.batchIndex}-${format}`;
  c.runSingleDownload = async (item, opts) => {
    if (item.bvid === 'BV2') await new Promise(setImmediate);
    saved.push(opts.filenameBase);
    return {};
  };
  await c.startListDownload();
  assert.deepEqual(saved, ['video6_p2-mp4', 'video2_p1-mp4']);
  assert.equal(stored.checkpoint, undefined);
});

test('parallel save failure stops new starts, waits for active work and retries only unfinished items', async () => {
  const { c, stored } = harness();
  c.listItems = c.listItems.slice(0, 8);
  const saved = [];
  c.runSingleDownload = async (item) => {
    if (item.bvid === 'BV0') throw new Error('保存失败');
    await new Promise(setImmediate);
    saved.push(item.bvid);
    return {};
  };
  await c.startListDownload();
  assert.deepEqual(saved.sort(), ['BV1', 'BV2']);
  const numbers = Array.from(c.lastListFailures, (task) => task.batchIndex);
  assert.deepEqual(numbers, [1, 4, 5, 6, 7, 8]);
  assert.deepEqual(Array.from(stored.checkpoint, (task) => task.batchIndex), numbers);
  c.runSingleDownload = async (item) => { saved.push(item.bvid); return {}; };
  await c.startListDownload(c.lastListFailures);
  assert.equal(new Set(saved).size, 8);
  assert.equal(saved.length, 8);
  assert.equal(stored.checkpoint, undefined);
});

test('parallel checkpoints serialize delayed storage and preserve remaining output types', async () => {
  const { c, stored } = harness(false, 'both');
  c.listItems = c.listItems.slice(0, 5);
  let writes = 0, peak = 0;
  c.EXT.storage.local.set = async (values) => {
    peak = Math.max(peak, ++writes);
    const snapshot = structuredClone(values);
    await new Promise(setImmediate);
    Object.assign(stored, snapshot);
    writes--;
  };
  c.runSingleDownload = async (_item, opts) => {
    if (opts.format === 'm4a') throw new Error('保存失败');
    return {};
  };
  await c.startListDownload();
  assert.equal(peak, 1);
  assert.ok(stored.checkpoint.length > 0);
  for (const task of stored.checkpoint) {
    assert.ok(Number.isInteger(task.batchIndex));
    if (task.batchIndex <= 3) assert.equal(task.downloadKind, 'audio');
  }
});

test('legacy restored records prefer stored index and freeze numbering before retry', async () => {
  const { c, stored } = harness();
  stored.checkpoint = [
    { item: c.listItems[6], downloadKind: 'video', index: 7 },
    { item: c.listItems[8], downloadKind: 'audio' }
  ];
  await c.restoreIncompleteTasks();
  assert.deepEqual(Array.from(c.lastListFailures, (task) => task.batchIndex), [7, 2]);
});

test('pause blocks new list work and cancellation wakes all workers without losing pending tasks', async () => {
  const { c } = harness();
  let releasePause;
  const gate = new Promise((resolve) => { releasePause = resolve; });
  c.queuePaused = true;
  c.waitWhileQueuePaused = () => c.queuePaused ? gate : Promise.resolve();
  let starts = 0;
  c.runSingleDownload = async () => { starts++; return {}; };
  // startListDownload resets the pause flag, so simulate a pause during its initial checkpoint.
  const set = c.EXT.storage.local.set;
  c.EXT.storage.local.set = async (values) => { await set(values); c.queuePaused = true; };
  const batch = c.startListDownload();
  await new Promise(setImmediate);
  assert.equal(starts, 0);
  assert.equal(c.activeJobs.size, 0);
  c.queueCancelled = true;
  c.queuePaused = false;
  releasePause();
  await batch;
  assert.equal(starts, 0);
  assert.equal(c.lastListFailures.length, 35);
});

test('individual cancellation retains its outputs while other parallel items finish', async () => {
  const { c } = harness();
  c.listItems = c.listItems.slice(0, 3);
  c.agentCall = async (_type, { aid }) => {
    if (aid === 2) {
      const job = [...c.activeJobs.values()].find((job) => job.info.aid === aid);
      job.cancelRequested = true;
    }
    return { qualities: [{ qn: 80, label: '1080P' }] };
  };
  const saved = [];
  c.runSingleDownload = async (item) => { saved.push(item.bvid); return {}; };
  await c.startListDownload();
  assert.deepEqual(saved.sort(), ['BV0', 'BV2']);
  assert.deepEqual(Array.from(c.lastListFailures, (task) => task.batchIndex), [2]);
});

test('a slow first item does not block later items from using and refilling other slots', async () => {
  const { c } = harness();
  c.listItems = c.listItems.slice(0, 8);
  let release;
  const first = new Promise((resolve) => { release = resolve; });
  const saved = [];
  c.runSingleDownload = async (item) => {
    if (item.bvid === 'BV0') await first;
    saved.push(item.bvid);
    return {};
  };
  const batch = c.startListDownload();
  await new Promise(setImmediate);
  assert.equal(saved.length, 7);
  assert.equal(c.queueRunning, true);
  assert.equal(c.activeJobs.size, 1);
  release();
  await batch;
  assert.equal(saved[7], 'BV0');
});

test('cancelled batch cover reads release the queue even when background never replies', async () => {
  const { c, stored } = harness(false, 'cover');
  const polls = new Map(), timers = new Map();
  let seq = 0, writes = 0;
  const replies = [], requests = [], cancellations = [];
  Object.assign(c, {
    crypto, Blob, atob,
    setInterval: (fn) => { const id = ++seq; polls.set(id, fn); return id; },
    clearInterval: (id) => polls.delete(id),
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    checkDownloadContext: async () => {},
    coverFilename: () => 'cover.png', normalizeCoverUrl: (url) => url,
    writeBatchFile: async () => { writes++; },
    classifyDownloadError: (error) => ({ type: /取消/.test(error.message) ? 'cancelled' : 'network', message: error.message })
  });
  c.listItems.forEach((item) => { item.cover = 'https://i0.hdslb.com/a.png'; });
  c.prepareBatchDestination = async () => ({});
  c.EXT.runtime = { sendMessage: (msg) => {
    if (msg.type === 'BILI_DL_CANCEL_COVER') { cancellations.push(msg.requestId); return Promise.resolve({ ok: true }); }
    requests.push(msg);
    return new Promise((resolve) => replies.push(resolve));
  } };
  vm.runInContext(source.slice(source.indexOf('    async function requestBatchCover('), source.indexOf('    async function prepareBatchDestination(')), c);
  const batch = c.startListDownload();
  await new Promise(setImmediate);
  assert.equal(requests.length, 3);
  assert.equal(new Set(requests.map((msg) => msg.requestId)).size, 3);
  c.queueCancelled = true;
  for (const poll of polls.values()) poll();
  await batch;
  assert.equal(c.queueRunning, false);
  assert.equal(c.activeJobs.size, 0);
  assert.equal(c.lastListFailures.length, 35);
  assert.equal(stored.checkpoint.length, 35);
  assert.equal(cancellations.length, 3);
  assert.equal(polls.size, 0);
  assert.equal(timers.size, 0);
  for (const reply of replies) reply({ ok: true, mime: 'image/png', base64: 'AQID' });
  await new Promise(setImmediate);
  assert.equal(writes, 0, 'late cover responses cannot save cancelled files');
  c.EXT.runtime.sendMessage = async () => ({ ok: true, mime: 'image/png', base64: 'AQID' });
  await c.startListDownload(c.lastListFailures.slice(0, 1));
  assert.equal(writes, 1, 'a new batch can run after cancellation');
});

function taskCardHarness() {
  const h = harness();
  const c = h.c;
  function node() {
    const children = new Map();
    const classes = new Set(['hidden']);
    return {
      dataset: {}, style: {}, textContent: '',
      classList: {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        contains: name => classes.has(name),
        toggle(name, force = !classes.has(name)) { force ? classes.add(name) : classes.delete(name); }
      },
      appendChild() {}, closest: () => true,
      querySelector(selector) {
        if (!children.has(selector)) children.set(selector, node());
        return children.get(selector);
      }
    };
  }
  c.document = { createElement: node };
  c.createFragment = () => ({});
  c.requestAnimationFrame = () => {};
  c.jobScope = job => job.scope;
  c.getTaskUi = () => ({ jobList: { appendChild() {} } });
  c.stepLabel = step => step;
  c.taskStateForStep = step => step;
  c.t = (key, values) => key === 'listDownloading'
    ? `正在下载 ${values.index}/${values.total}：${values.title}` : key;
  c.listStatusEl = node();
  c.listResultEl = node();
  c.listJobListEl = { querySelector() { assert.fail('队列状态不能改写其他任务卡'); } };
  const run = (start, end) => vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))), c);
  run('    function mountJobCard(', '    function removeJobCard(');
  run('    function setJobActionsVisible(', '    function setDetect(');
  run('    function formatBytes(', '    async function refreshEstimate(');
  run('    function setListStatus(', '    function formatDuration(');
  return h;
}

test('并行任务卡独立显示序号、标题和 MB 进度，乱序完成及补位不串项', async () => {
  const { c } = taskCardHarness();
  c.selectedListKeys = new Set(c.listItems.slice(0, 5).map(item => item.bvid));
  const pending = new Map();
  c.runSingleDownload = (_item, { jobId }) => new Promise(resolve => pending.set(c.activeJobs.get(jobId).queueIndex, resolve));
  const running = c.startListDownload();
  const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
  const assertCard = job => {
    const sub = job.cardEl.querySelector('.bili-dl-progress-sub');
    assert.equal(sub.textContent, `正在下载 ${job.queueIndex}/5：${job.info.title}`);
    assert.equal(sub.title, sub.textContent);
    assert.equal(sub.classList.contains('hidden'), false);
    c.updateProgress('video', 50, 1024 * 1024, 2 * 1024 * 1024, job.jobId);
    assert.equal(job.cardEl.querySelector('.bili-dl-job-pct').textContent, '1.0 MB / 2.0 MB');
    assert.equal(job.cardEl.querySelector('.bili-dl-progress-bar').style.width, '50%');
    c.updateProgress('paused', 50, 0, 0, job.jobId);
    c.updateProgress('video', 75, 1.5 * 1024 * 1024, 2 * 1024 * 1024, job.jobId);
    assert.equal(sub.textContent, `正在下载 ${job.queueIndex}/5：${job.info.title}`);
  };
  await flush();
  assert.deepEqual(Array.from(c.activeJobs.values(), job => job.queueIndex), [1, 2, 3]);
  c.activeJobs.forEach(assertCard);
  pending.get(2)({});
  await flush();
  assert.deepEqual(Array.from(c.activeJobs.values(), job => job.queueIndex), [1, 3, 4]);
  c.activeJobs.forEach(assertCard);
  pending.get(3)({});
  await flush();
  assert.deepEqual(Array.from(c.activeJobs.values(), job => job.queueIndex), [1, 4, 5]);
  c.activeJobs.forEach(assertCard);
  for (const index of [5, 4, 1]) pending.get(index)({});
  await running;
  assert.equal(c.activeJobs.size, 0);
});

test('重试卡使用当前队列序号和总数，原文件编号保持不变', async () => {
  const { c } = taskCardHarness();
  const seen = [];
  c.runSingleDownload = async (_item, { jobId }) => {
    const job = c.activeJobs.get(jobId);
    seen.push([job.queueIndex, job.queueTotal, job.batchIndex]);
    assert.equal(job.cardEl.querySelector('.bili-dl-progress-sub').textContent,
      `正在下载 ${job.queueIndex}/2：${job.info.title}`);
    return {};
  };
  await c.startListDownload([7, 19].map((batchIndex, i) => ({
    item: c.listItems[i], downloadKind: 'video', index: batchIndex, batchIndex
  })));
  assert.deepEqual(seen, [[1, 2, 7], [2, 2, 19]]);
});
