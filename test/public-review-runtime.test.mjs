import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const content = await readFile(new URL('../content/content.js', import.meta.url), 'utf8');
const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
function load(context, start, end) {
  const from = content.indexOf(start);
  const to = content.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start);
  vm.runInContext(content.slice(from, to), context);
}

test('initial URL selects the requested part and rejects invalid part numbers', () => {
  const from = content.includes('  function pageIndexFromUrl(')
    ? '  function pageIndexFromUrl(' : '  let pageIndex =';
  for (const [query, expected] of [['?p=2', 1], ['?p=105', 104], ['', 0], ['?p=0', 0],
    ['?p=-2', 0], ['?p=1.5', 0], ['?p=Infinity', 0], ['?p=9007199254740992', 0]]) {
    const c = vm.createContext({ URL, location: { href: 'https://www.bilibili.com/video/BVtest' + query } });
    load(c, from, '  let isOpen =');
    assert.equal(vm.runInContext('pageIndex', c), expected, query);
  }
});

test('single PGC video and audio snapshots retain epId through START_DOWNLOAD', async () => {
  for (const format of ['mp4', 'm4a']) {
    const requests = [];
    const c = vm.createContext({
      Date, selectedQn: 80, selectedFormat: format, pageIndex: 0,
      qualities: [{ qn: 80, mode: 'dash' }], streamPreference: 'compatible',
      videoInfo: { bvid: 'BVepisode', aid: '12', cid: '34', epId: '56', title: '剧集', pages: [] },
      filenameTemplate: '{title}', currentEstimateBytes: 1024,
      getSelectedQualityLabel: () => '1080P', buildFilenameBase: () => 'episode',
      checkDownloadContext: async () => {}, waitWhileQueuePaused: async () => {},
      setupMuxInPage: async () => {}, activeJobs: new Map(), queueRunning: false,
      downloadBlob: async () => 1, updateProgress() {},
      agentCall: async (type, data) => {
        requests.push({ type, data });
        return { blob: new Blob(['media']), filename: 'episode.' + format };
      }
    });
    load(c, '    function captureDownloadJob()', '    function canStartCurrentDownload(');
    load(c, '    async function runSingleDownload(', '    async function saveReusedAudio(');
    const job = c.captureDownloadJob();
    assert.equal(job.info.epId, '56');
    await c.runSingleDownload(job.info, job);
    assert.equal(requests[0].type, 'START_DOWNLOAD');
    assert.equal(requests[0].data.epId, '56');
    assert.equal(Boolean(requests[0].data.audioOnly), format === 'm4a');
    if (format === 'mp4') assert.equal(requests[0].data.streamPreference, 'compatible');
  }
});

test('stream compatibility preference restores, synchronizes controls and persists', async () => {
  let estimates = 0;
  const writes = [];
  const controls = [{ value: 'high-bitrate' }, { value: 'high-bitrate' }];
  const c = vm.createContext({
    streamPreference: 'high-bitrate', streamPreferenceEls: controls,
    selectedQn: 80, qualityStrategy: 'exact', spaceQualityTier: 'highest',
    DOWNLOAD_PREFS_KEY: 'prefs',
    EXT: { storage: { local: { get: async () => ({ prefs: { streamPreference: 'compatible' } }) } } },
    syncQualityStrategy() {}, syncQualitySelection() {},
    isSpacePage: () => false, isSpaceCollectionPage: () => false,
    loadFilenameSettings: async () => {}, refreshFilenamePreview() {},
    refreshEstimate: () => { estimates++; },
    saveDownloadPrefs: () => writes.push(c.streamPreference)
  });
  load(c, '    async function loadDownloadPrefs()', '    showStatus =');
  await c.loadDownloadPrefs();
  assert.equal(c.streamPreference, 'compatible');
  assert.deepEqual(controls.map(control => control.value), ['compatible', 'compatible']);
  load(c, '    streamPreferenceEls.forEach((el) => {\n      el.onchange', '    if (EXT.storage?.onChanged)');
  controls[1].value = 'high-bitrate';
  controls[1].onchange();
  assert.deepEqual(controls.map(control => control.value), ['high-bitrate', 'high-bitrate']);
  assert.deepEqual(writes, ['high-bitrate']);
  assert.equal(estimates, 1);
});

test('gather all uploads starts at page one even from the second visible page', async () => {
  const requests = [];
  const page = (pn) => ({
    items: Array.from({ length: pn === 3 ? 5 : 30 }, (_, index) => ({ bvid: 'BV' + ((pn - 1) * 30 + index), title: '投稿' })),
    total: 65, hasMore: pn < 3, cursor: { pn: pn + 1 }
  });
  const c = vm.createContext({
    location: { href: 'https://space.bilibili.com/123/upload/video?pn=2' },
    spaceGathering: false, queueRunning: false, listLoading: false, listLoaded: false,
    listItems: [], listTotal: 65, listCursor: null, listHasMore: false, selectedListKeys: new Set(),
    pendingListSync: false, listItemKey: item => item.bvid,
    captureListView: () => ({}), isCurrentListView: () => true,
    setTimeout: fn => { fn(); }, t: key => key,
    updateListSelection() {}, updateListLoadMore() {}, renderListItems() {},
    setListStatus() {}, debugLog() {}, scheduleListSync() {},
    translateUserError: message => message,
    agentCall: async (type, { cursor }) => { requests.push([type, cursor?.pn || 1]); return page(cursor?.pn || 1); }
  });
  c.applySpaceListData = async (data) => {
    c.listItems = data.items;
    c.listCursor = data.cursor;
    c.listHasMore = data.hasMore;
    c.listTotal = data.total;
  };
  c.window = { __BILI_DL_API__: { openPanel: async () => {
    await c.applySpaceListData({ ...page(2), cursor: null, hasMore: true });
    c.listLoaded = true;
  } } };
  c.listCountEl = {};
  c.formatListLoadedCount = () => '';
  load(c, '    function mergeListItems(', '    function mergeSpacePageItems(');
  load(c, '    async function loadMoreListItems()', '    async function setDownloadMode(');
  load(c, '    async function prepareAllSpaceUploads(', '    // Space is a SPA:');
  const button = {};
  await c.prepareAllSpaceUploads(button);
  assert.equal(c.selectedListKeys.size, 65);
  assert.deepEqual(requests, [['RESOLVE_LIST', 1], ['LOAD_LIST_PAGE', 2], ['LOAD_LIST_PAGE', 3]]);
  assert.equal(button.disabled, false);
});

test('background refuses cross-privacy state reads and cancellations in a shared worker', async () => {
  let listener;
  const cancelled = [];
  const c = vm.createContext({ URL, console, chrome: {
    runtime: { id: 'extension', onInstalled: { addListener() {} }, onMessage: { addListener(fn) { listener = fn; } } },
    downloads: {
      search: async () => [{ id: 7, byExtensionId: 'extension', incognito: c.targetPrivate, state: 'in_progress' }],
      cancel: async id => cancelled.push(id)
    }
  } });
  vm.runInContext(background, c);
  for (const targetPrivate of [true, false]) {
    c.targetPrivate = targetPrivate;
    for (const type of ['BILI_DL_MEDIA_STATE', 'BILI_DL_CANCEL_MEDIA']) {
      const call = incognito => new Promise(resolve => listener({ type, downloadId: 7 }, {
        id: 'extension', url: 'https://www.bilibili.com/video/BVtest', tab: { id: 1, incognito }
      }, resolve));
      assert.equal((await call(!targetPrivate)).ok, false);
      assert.equal((await call(targetPrivate)).ok, true);
    }
  }
  assert.deepEqual(cancelled, [7, 7]);
});

test('SPA navigation invalidates current metadata while preserving active job snapshots', () => {
  const old = { bvid: 'BVold', title: '旧视频' };
  const c = vm.createContext({
    URL, location: { href: 'https://www.bilibili.com/video/BVnew?p=2' },
    lastUrl: 'https://www.bilibili.com/video/BVold', videoInfo: old,
    downloading: true, queueRunning: false, selectedQn: 80, isOpen: false, activeMode: 'video',
    videoSourceRevision: 0, listViewRevision: 0, collectionHref: '',
    keepMenuVisible() {}, renderListItems() {}, updateListLoadMore() {}, updateListRetryFailed() {},
    restoreIncompleteTasks: async () => {}, readSpaceDomPageNumber: () => 1, spaceViewKey: () => '',
    syncSpaceListTools() {}, isListPage: () => false, setDownloadMode() {}, scheduleListSync() {},
    menu: { classList: { toggle() {} } }, modeTabsEl: { classList: { toggle() {} } },
    startBtn: {}, coverDownloadBtn: {}, queueBtn: {}
  });
  if (content.includes('  function pageIndexFromUrl(')) load(c, '  function pageIndexFromUrl(', '  let pageIndex =');
  load(c, '    function onUrlChanged()', '    // SPA 路由监听');
  c.onUrlChanged();
  assert.equal(c.videoInfo, null);
  assert.equal(c.pageIndex, 1);
  assert.equal(c.startBtn.disabled, true);
  assert.equal(c.coverDownloadBtn.disabled, true);
  assert.equal(old.bvid, 'BVold');
});
