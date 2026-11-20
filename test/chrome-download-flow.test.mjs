import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const content = await readFile(new URL('../content/content.js', import.meta.url), 'utf8');
const popup = await readFile(new URL('../popup/popup.js', import.meta.url), 'utf8');

function qualityHarness(selectedQn, qualityStrategy) {
  const context = vm.createContext({
    selectedQn, qualityStrategy, qualityVideoKey: '', qualityBeforeAutoDefault: null,
    resetQualityOnNavigation: false, syncQualityStrategy() {}
  });
  vm.runInContext(content.slice(content.indexOf('    function updateDefaultQuality('), content.indexOf('    function renderQualityPills(')), context);
  return context;
}

test('新视频预选普通 1080P，重复渲染保留手动选择', () => {
  const context = qualityHarness(112, 'highest');
  const available = [{ qn: 112 }, { qn: 80 }, { qn: 64 }];
  context.updateDefaultQuality(available, 'video-a');
  assert.equal(context.selectedQn, 80);
  context.qualityBeforeAutoDefault = null;
  context.qualityStrategy = 'exact';
  context.selectedQn = 64;
  context.updateDefaultQuality(available, 'video-a');
  assert.equal(context.selectedQn, 64);
  context.updateDefaultQuality(available, 'video-b');
  assert.equal(context.selectedQn, 80);
});

test('无普通 1080P 时沿用原有手动档位或最高策略', () => {
  const exact = qualityHarness(64, 'exact');
  const highest = qualityHarness(64, 'highest');
  for (const context of [exact, highest]) {
    context.updateDefaultQuality([{ qn: 112 }, { qn: 80 }, { qn: 64 }], 'video-a');
    context.updateDefaultQuality([{ qn: 64 }, { qn: 112 }], 'video-b');
  }
  assert.equal(exact.selectedQn, 64);
  assert.equal(highest.selectedQn, 112);
  exact.updateDefaultQuality([{ qn: 32 }], 'video-c');
  assert.equal(exact.selectedQn, 32);
});

test('工具栏发送一次打开消息，面板确认后关闭，失败时保留刷新入口', async () => {
  const messages = [];
  const nodes = new Map(['btn-retry', 'error-text'].map((id) => [id, {}]));
  let state, closed = 0, reloaded = 0, succeeds = true;
  const tab = { id: 1, url: 'https://space.bilibili.com/123/lists/456' };
  const context = vm.createContext({
    URL, t: (key) => key, $: (id) => nodes.get(id), showState: (value) => { state = value; },
    showEmptyState: () => { state = 'empty'; }, window: { close: () => { closed++; } },
    EXT: { runtime: { getManifest: () => ({}) }, tabs: {
      query: async () => [tab],
      sendMessage: async (id, message) => { messages.push([id, { ...message }]); return { ok: succeeds }; },
      reload: async () => { reloaded++; }
    } }
  });
  vm.runInContext(popup.slice(popup.indexOf('function isBiliDownloadUrl('), popup.indexOf('function formatCurrentSite(')), context);
  vm.runInContext(popup.slice(popup.indexOf('async function init()'), popup.indexOf("document.getElementById('popup-history-toggle')")), context);
  await context.init();
  assert.deepEqual(messages, [[1, { type: 'BILI_DL_OPEN_PANEL', fromToolbar: true }]]);
  assert.equal(closed, 1);
  tab.url = 'https://www.bilibili.com/video/BVtest';
  succeeds = false;
  await context.init();
  assert.deepEqual(messages[1], [1, { type: 'BILI_DL_OPEN_PANEL', fromToolbar: true }]);
  assert.equal(state, 'state-error');
  assert.equal(closed, 1);
  await nodes.get('btn-retry').onclick();
  assert.equal(reloaded, 1);
  tab.url = 'https://notbilibili.com/video/BVtest';
  await context.init();
  assert.equal(messages.length, 2);
  assert.equal(state, 'empty');
});

function storageHarness(beforeOpen = () => {}) {
  const entries = new Map();
  let failWrite = false;
  const directory = {
    async getFileHandle(name, { create = false } = {}) {
      if (!entries.has(name)) {
        if (!create) throw new DOMException('', 'NotFoundError');
        entries.set(name, new Blob());
      }
      return {
        getFile: async () => entries.get(name),
        isSameEntry: async () => true,
        async createWritable({ mode }) {
          assert.equal(mode, 'exclusive');
          beforeOpen(name);
          let pending;
          return {
            write: async (blob) => {
              if (failWrite) throw new DOMException('disk full', 'QuotaExceededError');
              pending = blob;
            },
            close: async () => { entries.set(name, pending); },
            abort: async () => { pending = null; }
          };
        }
      };
    },
    removeEntry: async (name) => { entries.delete(name); }
  };
  const context = vm.createContext({
    Blob, TextEncoder, t: (key) => key, window: {}, EXT: { runtime: { getManifest: () => ({}) } }
  });
  vm.runInContext(content.slice(content.indexOf('  async function pickBatchDirectory('), content.indexOf('  function formatView(')), context);
  return { context, directory, entries, failNextWrite: () => { failWrite = true; } };
}

test('目录选择需要真实点击，并区分取消和失败', async () => {
  const { context, directory } = storageHarness();
  let picks = 0;
  context.window.showDirectoryPicker = async (opts) => {
    assert.equal(opts.mode, 'readwrite');
    picks++;
    return directory;
  };
  await assert.rejects(context.pickBatchDirectory({ isTrusted: false }), /batchDirectoryUnavailable/);
  assert.equal(picks, 0);
  assert.equal(await context.pickBatchDirectory({ isTrusted: true }), directory);
  context.window.showDirectoryPicker = async () => { throw new DOMException('', 'AbortError'); };
  assert.equal(await context.pickBatchDirectory({ isTrusted: true }), undefined);
  context.window.showDirectoryPicker = async () => { throw new DOMException('', 'SecurityError'); };
  await assert.rejects(context.pickBatchDirectory({ isTrusted: true }), /batchDirectoryFailed/);
});

test('目录写入完成后才返回，重名顺延，磁盘失败清理未提交文件', async () => {
  const { context, directory, entries, failNextWrite } = storageHarness();
  entries.set('视频.mp4', new Blob(['原文件']));
  const blob = new Blob(['媒体内容']);
  const save = (name) => context.writeBatchFile(directory, blob, name, () => false);
  assert.equal(await save('视频.mp4'), '视频 (1).mp4');
  assert.equal(await entries.get('视频.mp4').text(), '原文件');
  assert.equal(await entries.get('视频 (1).mp4').text(), '媒体内容');
  assert.equal(await save('音频.m4a'), '音频.m4a');
  assert.equal(await save('封面.jpg'), '封面.jpg');
  failNextWrite();
  await assert.rejects(save('磁盘失败.mp4'), /保存阶段失败/);
  assert.equal(entries.has('磁盘失败.mp4'), false);
});

test('打开写入流时磁盘失败会清理空文件，重试可使用原名', async () => {
  let diskFull = true;
  const { context, directory, entries } = storageHarness(() => {
    if (diskFull) throw new DOMException('disk full', 'QuotaExceededError');
  });
  const blob = new Blob(['媒体内容']);
  const save = () => context.writeBatchFile(directory, blob, '视频.mp4', () => false);
  await assert.rejects(save(), /保存阶段失败/);
  assert.equal(entries.has('视频.mp4'), false);
  diskFull = false;
  assert.equal(await save(), '视频.mp4');
});

test('并发写入占用原名时保留该条目，清理失败的顺延文件', async () => {
  const { context, directory, entries } = storageHarness((name) => {
    if (name === '视频.mp4') throw new DOMException('locked', 'NoModificationAllowedError');
    throw new DOMException('disk full', 'QuotaExceededError');
  });
  await assert.rejects(context.writeBatchFile(directory, new Blob(['媒体']), '视频.mp4', () => false), /保存阶段失败/);
  assert.deepEqual([...entries.keys()], ['视频.mp4']);
});

function panelHarness(pathname, snapshot) {
  const node = () => {
    const classes = new Set();
    return {
      dataset: {},
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        toggle: (name, active) => active ? classes.add(name) : classes.delete(name),
        contains: (name) => classes.has(name)
      },
      setAttribute(name, value) { this[name] = value; }
    };
  };
  const tabs = ['video', 'list'].map((mode) => Object.assign(node(), { dataset: { mode } }));
  const c = vm.createContext({
    URL, location: { pathname, href: 'https://www.bilibili.com' + pathname },
    collectionHref: '', videoInfo: null, panelOpening: null, isOpen: false,
    activeMode: 'video', operationMode: null, queueRunning: false, estimateRequestId: 0,
    fetchSnapshot: () => snapshot, downloadPrefsReady: Promise.resolve(),
    snapshotKey: () => pathname, t: (key) => key,
    isSpaceCollectionsIndex: () => false, isSpacePage: () => false, isSpaceCollectionPage: () => false,
    isMultiPartVideo: () => false, selectedFormat: 'mp4',
    panel: { querySelector: () => null },
    openMenuShell() {}, showHome() {}, syncSpaceDownloadAllVisibility() {},
    syncQualitySelection() {}, refreshEstimate() {}, updatePgcAccessRows() {}, schedulePgcAccessChecks() {},
    setDetect() {}, setVideoLoading() {}, clearNode() {}, appendTextElement() {},
    renderQualityPills() {}, refreshStartBtnForQueue() {}, debugLog() {},
    showDownloadError: (message) => assert.fail(message), translateUserError: (message) => message
  });
  for (const name of ['menu', 'modeTabsEl', 'homeEl', 'videoBodyEl', 'listBodyEl', 'titleEl',
    'authorEl', 'subEl', 'estimateEl', 'queueBtn', 'startBtn', 'coverDownloadBtn', 'statusEl',
    'pillsEl', 'coverPh', 'coverSk', 'pagesEl', 'qualitySection']) c[name] = node();
  c.modeTabsEl.querySelectorAll = () => tabs;
  c.loadListItems = async () => {};
  const run = (start, end) => vm.runInContext(content.slice(content.indexOf(start), content.indexOf(end, content.indexOf(start))), c);
  run('    function isListPage()', '    let spaceGathering');
  run('    async function setDownloadMode(', '    function showDownloadError(');
  run('    async function loadVideoInfo(', '    function getSelectedQualityLabel(');
  run('    function closeMenuShell()', '    closeBtn.onclick');
  run('    async function openPanel(', '    window.__BILI_DL_API__');
  run("    modeTabsEl.querySelectorAll('[data-mode]').forEach((button) => {\n      button.onclick", '    formatPillsEl.querySelectorAll');
  return { c, tabs };
}

test('列表页立即选中列表，普通视频页打开单视频', async () => {
  const snapshot = { info: { title: '视频' }, qualities: [] };
  const list = panelHarness('/list/ml123', snapshot);
  const opened = list.c.openPanel();
  assert.equal(list.tabs[1]['aria-selected'], 'true');
  await opened;
  const video = panelHarness('/video/BVtest', snapshot);
  await video.c.openPanel();
  assert.equal(video.tabs[0]['aria-selected'], 'true');
  assert.ok(video.c.modeTabsEl.classList.contains('hidden'));
});

test('识别合集后切到列表，手动选择单视频后重开恢复列表', async () => {
  const snapshot = { info: { title: '合集', collection: { items: [{}] } }, qualities: [] };
  const { c, tabs } = panelHarness('/video/BVcollection', snapshot);
  const opened = c.openPanel();
  assert.equal(c.activeMode, 'video');
  await opened;
  assert.equal(tabs[1]['aria-selected'], 'true');
  await tabs[0].onclick();
  await c.openPanel();
  assert.equal(c.activeMode, 'video');
  c.isOpen = false;
  c.closeMenuShell();
  await c.openPanel();
  assert.equal(c.activeMode, 'list');
});

test('列表页异步识别期间手动切换单视频，识别完成后保留选择', async () => {
  let resolve;
  const snapshot = new Promise((done) => { resolve = done; });
  const { c, tabs } = panelHarness('/list/ml123', snapshot);
  const opened = c.openPanel();
  await tabs[0].onclick();
  resolve({ info: { title: '视频' }, qualities: [] });
  await opened;
  assert.equal(tabs[0]['aria-selected'], 'true');
});

function singleVideoHarness() {
  const { context: c, directory, entries, failNextWrite } = storageHarness();
  const outcomes = [], requests = [], statuses = [];
  let sequence = 0;
  Object.assign(c, {
    location: { href: 'https://www.bilibili.com/video/BVtest' },
    videoSourceRevision: 0, pickingVideoDirectory: false, queueRunning: false,
    activeJobs: new Map(), PARALLEL_MAX: 3, isLargeMerge: () => false,
    selectedFormat: 'mp4', canStartCurrentDownload: () => true,
    captureDownloadJob: () => ({
      info: { title: '视频', aid: 1, cid: 2 }, format: c.selectedFormat, qn: 80,
      filenameBase: '模板文件', streamPreference: 'high-bitrate'
    }),
    createDownloadTask: (seed) => ({ ...seed, jobId: 'job-' + ++sequence }),
    refreshStartBtnForParallel() {}, mountJobCard() {}, updateProgress() {}, debugLog() {},
    showStatus: (...args) => statuses.push(args), statusEl: { classList: { add() {} } },
    TASK_STATE: { completed: 'completed', failed: 'failed' },
    setTaskState(job, state) { job.state = state; },
    classifyDownloadError: (error) => ({ type: 'save', message: error.message }),
    showRetryableDownloadError(job) { job.state = 'failed'; },
    removeJobCard(id) { outcomes.push(c.activeJobs.get(id)); c.activeJobs.delete(id); },
    addHistory() {}, noteDownloadSuccessForRating() {},
    checkDownloadContext: async () => {}, setupMuxInPage: async () => {}, waitWhileQueuePaused: async () => {},
    agentCall: async (type, payload) => {
      requests.push({ type, payload });
      const extension = payload.audioOnly ? 'm4a' : 'mp4';
      return { blob: new Blob(['内容']), filename: payload.filenameBase + '.' + extension, audioOnly: payload.audioOnly };
    }
  });
  vm.runInContext(content.slice(content.indexOf('    async function runSingleDownload('), content.indexOf('    function coverFilename(')), c);
  return { c, directory, entries, failNextWrite, outcomes, requests, statuses };
}

test('单视频确认目录前不建任务或请求媒体，支持两种格式与重名保存', async () => {
  const { c, directory, entries, outcomes, requests } = singleVideoHarness();
  const event = { isTrusted: true };
  let resolve, picks = 0;
  c.window.showDirectoryPicker = () => {
    picks++;
    return new Promise((done) => { resolve = done; });
  };
  entries.set('模板文件.mp4', new Blob(['原文件']));
  const start = c.startDownload(event);
  await c.startDownload(event);
  assert.equal(picks, 1);
  assert.equal(c.activeJobs.size, 0);
  assert.equal(requests.length, 0);
  resolve(directory);
  await start;
  await new Promise(setImmediate);
  assert.equal(outcomes[0].state, 'completed');
  assert.equal(outcomes[0].directorySave, true);
  assert.equal(await entries.get('模板文件.mp4').text(), '原文件');
  assert.equal(await entries.get('模板文件 (1).mp4').text(), '内容');

  c.selectedFormat = 'm4a';
  const audio = c.startDownload(event);
  resolve(directory);
  await audio;
  await new Promise(setImmediate);
  assert.equal(outcomes[1].state, 'completed');
  assert.equal(await entries.get('模板文件.m4a').text(), '内容');
});

test('取消、选择失败和选目录期间切换视频或分 P 均不启动单视频任务', async () => {
  const { c, directory, requests, outcomes, statuses } = singleVideoHarness();
  const event = { isTrusted: true };
  c.window.showDirectoryPicker = async () => { throw new DOMException('', 'AbortError'); };
  await c.startDownload(event);
  assert.equal(statuses.length, 0);
  c.window.showDirectoryPicker = async () => { throw new DOMException('', 'SecurityError'); };
  await c.startDownload(event);
  assert.deepEqual(statuses, [['error', 'batchDirectoryFailed']]);
  c.window.showDirectoryPicker = async () => { c.location.href += 'other'; return directory; };
  await c.startDownload(event);
  c.window.showDirectoryPicker = async () => { c.videoSourceRevision++; return directory; };
  await c.startDownload(event);
  assert.equal(requests.length, 0);
  assert.equal(outcomes.length, 0);
  assert.equal(c.activeJobs.size, 0);
});

test('单视频写入失败后重试要重新选目录，并在新目录保存', async () => {
  const { c, directory, entries, failNextWrite, outcomes, requests } = singleVideoHarness();
  const second = storageHarness();
  const event = { isTrusted: true };
  let picks = 0;
  c.window.showDirectoryPicker = async () => ++picks === 1 ? directory : second.directory;
  failNextWrite();
  await c.startDownload(event);
  await new Promise(setImmediate);
  assert.equal(outcomes[0].state, 'failed');
  assert.equal(entries.size, 0);
  await c.launchVideoTask(outcomes[0], event);
  await new Promise(setImmediate);
  assert.equal(picks, 2);
  assert.equal(requests.length, 2);
  assert.equal(outcomes[1].state, 'completed');
  assert.equal(outcomes[1].attempts, 2);
  assert.equal(await second.entries.get('模板文件.mp4').text(), '内容');
});

test('同目录同时保存同名文件时分别提交，不覆盖已完成文件', async () => {
  const { context, directory, entries } = storageHarness();
  const names = await Promise.all(['one', 'two', 'three'].map((data) =>
    context.writeBatchFile(directory, new Blob([data]), '视频_p1.mp4', () => false)));
  assert.deepEqual(names, ['视频_p1.mp4', '视频_p1 (1).mp4', '视频_p1 (2).mp4']);
  assert.deepEqual(await Promise.all(names.map((name) => entries.get(name).text())), ['one', 'two', 'three']);
});
