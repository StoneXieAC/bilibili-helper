import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const content = await readFile(new URL('../content/content.js', import.meta.url), 'utf8');
const filename = await readFile(new URL('../shared/filename.js', import.meta.url), 'utf8');

function harness() {
  const names = [];
  const c = vm.createContext({
    TextEncoder, Blob, filenameTemplate: '{title} - {quality}',
    selectedQn: 80, selectedFormat: 'mp4', streamPreference: 'high-bitrate',
    qualities: [{ qn: 80, label: '1080P' }],
    activeJobs: new Map(), queueRunning: true, queueCancelled: false,
    checkDownloadContext: async () => {}, waitWhileQueuePaused: async () => {},
    setupMuxInPage: async () => {}, updateProgress() {}, debugLog() {},
    videoInfo: {}, t: (key) => key,
    downloadBlob: async (_blob, name) => { names.push(name); return 1; },
    agentCall: async (_type, args) => ({
      blob: new Blob(['media']), filename: `${args.filenameBase}.${args.audioOnly ? 'm4a' : 'mp4'}`,
      actualQn: args.audioOnly ? 0 : 64, actualLabel: '720P'
    })
  });
  vm.runInContext(filename, c);
  vm.runInContext(content.slice(content.indexOf('    function buildFilenameBase('), content.indexOf('    function refreshFilenamePreview(')), c);
  vm.runInContext(content.slice(content.indexOf('    async function runSingleDownload('), content.indexOf('    function finishActiveJob(')), c);
  vm.runInContext(content.slice(content.indexOf('    function coverFilename('), content.indexOf('    function normalizeCoverUrl(')), c);
  return { c, names };
}

test('batch suffix survives actual quality changes and matches audio and cover numbering', async () => {
  const { c, names } = harness();
  const info = { title: '视频名称', aid: 1, cid: 2 };
  c.activeJobs.set('batch', { batchIndex: 7, filenameTemplate: '{title} - {quality}' });
  await c.runSingleDownload(info, { jobId: 'batch', qn: 80, format: 'mp4' });
  await c.runSingleDownload(info, { jobId: 'batch', qn: 80, format: 'm4a', filenameBase: c.buildFilenameBase(info, 80, 'm4a', { batchIndex: 7 }) });
  assert.deepEqual(names, ['视频名称 - 720P_p7.mp4', '视频名称 - 音频_p7.m4a']);
  assert.equal(c.coverFilename(info, 'https://i0.hdslb.com/cover.png', { batchIndex: 7 }), '视频名称 - listContentCover_p7.png');
  assert.equal(c.buildFilenameBase(info, 80, 'mp4'), '视频名称 - 1080P');
});

test('long unicode templates keep identifiers and batch suffix through 105 numbered outputs', () => {
  const { c } = harness();
  const F = c.BiliDlFilename;
  const names = new Set();
  for (let batchIndex = 1; batchIndex <= 105; batchIndex++) {
    const base = F.renderTemplate('{title} - {part} - {index} - {bvid}', {
      title: '长🎞'.repeat(120), bvid: 'BVoriginal', part: 7
    }, { index: batchIndex, batchIndex });
    assert.ok(base.endsWith(` - 07 - ${String(batchIndex).padStart(2, '0')} - BVoriginal_p${batchIndex}`));
    assert.ok(Array.from(base).length <= 120);
    assert.ok(Buffer.byteLength(base) <= 220);
    assert.ok(F.withExtension(base, 'mp4').endsWith(`_p${batchIndex}.mp4`));
    names.add(base);
  }
  assert.equal(names.size, 105);
});
