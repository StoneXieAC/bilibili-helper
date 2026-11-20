import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../lib/chapter-mp4.js';
import Filename from '../shared/filename.js';

const source = await readFile(new URL('../content/page-agent.js', import.meta.url), 'utf8');
const mp4 = globalThis.BiliChapterMp4;

function mediaIndex(version, entries) {
  const entryOffset = version ? 40 : 32;
  const index = Buffer.alloc(entryOffset + entries.length * 12);
  index.writeUInt32BE(index.length, 0);
  index.write('sidx', 4);
  index[8] = version;
  index.writeUInt32BE(1000, 16);
  index.writeUInt16BE(entries.length, entryOffset - 2);
  entries.forEach(([size, duration, sap], i) => {
    const offset = entryOffset + i * 12;
    index.writeUInt32BE(size, offset);
    index.writeUInt32BE(duration, offset + 4);
    index.writeUInt32BE(sap, offset + 8);
  });
  return index;
}

function rangeHarness(fetch) {
  const context = vm.createContext({
    fetch, Blob, AbortController, BiliChapterMp4: mp4,
    location: { href: 'https://www.bilibili.com/video/BVtest' },
    withStallTimeout: (promise) => promise,
    waitWhilePaused: async (session) => { if (session.paused) await session.resume; },
    throwIfCancelled: (session) => { if (session.cancelled) throw new Error('下载已取消'); },
    extractStreamUrls: ({ url }) => [url],
    prioritizeCandidates: (candidates) => candidates,
    buildCdnCandidates: (url) => [url],
    isDownloadableCdnUrl: () => true
  });
  vm.runInContext(source.slice(source.indexOf('  function parseSegmentRange('), source.indexOf('  async function handleChapterDownload(')), context);
  return context;
}

test('sidx maps a clip to byte ranges with decode preroll and excludes later fragments', () => {
  for (const version of [0, 1]) {
    const index = mediaIndex(version, [[100, 5000, 0x90000000], [200, 5000, 0],
      [300, 5000, 0x90000000], [400, 5000, 0x90000000]]);
    const offset = 1000 + index.length;
    assert.deepEqual(mp4.chapterRange(index, 1000, 3000, 5.5, 9, true), { start: offset, end: offset + 299 });
    assert.deepEqual(mp4.chapterRange(index, 1000, 3000, 10, 15, true), { start: offset + 300, end: offset + 599 });
    assert.deepEqual(mp4.chapterRange(index, 1000, 3000, 5.5, 9, false), { start: offset + 100, end: offset + 299 });
    assert.throws(() => mp4.chapterRange(index, 1000, 3000, 20, 30, true), /章节媒体索引/);
    index.writeUInt32BE(0x80000001, index.length - 12);
    assert.throws(() => mp4.chapterRange(index, 1000, 3000, 10, 15, true), /章节媒体索引/);
  }
});

test('only initialization, index and selected bytes are fetched', async () => {
  const index = mediaIndex(1, Array.from({ length: 4 }, () => [100, 5000, 0x90000000]));
  const source = Buffer.concat([Buffer.alloc(20), index, Buffer.alloc(400)]);
  const ranges = [];
  const ctx = rangeHarness(async (_url, options) => {
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range).map(Number);
    ranges.push([start, end]);
    return new Response(source.subarray(start, end + 1), {
      status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${source.length}` }
    });
  });
  const report = [];
  const track = { url: 'https://example.bilivideo.com/video', segment_base: {
    initialization: '0-19', index_range: `20-${19 + index.length}`
  } };
  const session = { controllers: {}, pauseEpoch: 0 };
  const chapter = { start: 11, end: 14 };
  const blob = await ctx.downloadChapterTrack(session, [track], chapter, 'video', (...value) => report.push(value));
  assert.equal(blob.size, 120);
  assert.deepEqual(ranges, [[20, 19 + index.length], [0, 19], [220 + index.length, 319 + index.length]]);
  assert.deepEqual(report.at(-1), [100, 100]);
  await assert.rejects(ctx.downloadChapterTrack(session, [{ url: track.url }], chapter, 'video'), /章节媒体索引/);
});

test('Range rejects a full or mismatched response before reading and checks actual bytes', async () => {
  const range = { start: 10, end: 19 };
  const session = { controllers: {}, pauseEpoch: 0 };
  const blocked = { getReader() { assert.fail('unexpected response body was read'); } };
  for (const [status, contentRange] of [[200, ''], [206, 'bytes 10-20/100'], [206, 'bytes 9-19/100']]) {
    const ctx = rangeHarness(async () => ({ status, headers: new Headers({ 'Content-Range': contentRange }), body: blocked }));
    await assert.rejects(ctx.fetchChapterRange(session, '', range, 'video'), /有效的章节字节范围/);
    assert.equal(session.controllers.video.signal.aborted, true);
  }
  const ctx = rangeHarness(async () => new Response(new Uint8Array(9), {
    status: 206, headers: { 'Content-Range': 'bytes 10-19/100' }
  }));
  await assert.rejects(ctx.fetchChapterRange(session, '', range, 'video'), /下载数据不完整/);
});

test('bounded download resumes at the next byte and cancels outstanding reads', async () => {
  const ranges = [];
  const session = { controllers: {}, pauseEpoch: 0 };
  const ctx = rangeHarness(async (_url, { headers, signal }) => {
    ranges.push(headers.Range);
    if (ranges.length === 2) return new Response(new Uint8Array([4, 5]), {
      status: 206, headers: { 'Content-Range': 'bytes 13-14/20' }
    });
    return {
      status: 206, headers: new Headers({ 'Content-Range': 'bytes 10-14/20' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          signal.addEventListener('abort', () => controller.error(new Error('AbortError')));
        }
      })
    };
  });
  const file = await ctx.fetchChapterRange(session, '', { start: 10, end: 14 }, 'video', 20, (received) => {
    if (received !== 3) return;
    session.paused = true;
    session.pauseEpoch++;
    session.resume = Promise.resolve().then(() => { session.paused = false; });
    session.controllers.video.abort();
  });
  assert.deepEqual(ranges, ['bytes=10-14', 'bytes=13-14']);
  assert.deepEqual([...new Uint8Array(await file.blob.arrayBuffer())], [1, 2, 3, 4, 5]);
  session.cancelled = true;
  await assert.rejects(ctx.fetchChapterRange(session, '', { start: 10, end: 14 }, 'video'), /下载已取消/);
  assert.equal(ranges.length, 2);
});

test('player metadata preserves chapter numbers after validation and sorting', async () => {
  let result;
  const context = vm.createContext({
    apiGet: async (path) => {
      assert.equal(path, '/x/player/wbi/v2?aid=123&cid=456');
      if (result instanceof Error) throw result;
      return result;
    },
    signedWbiQuery: ({ aid, cid }) => `aid=${aid}&cid=${cid}`
  });
  vm.runInContext(source.slice(source.indexOf('  async function getChapters('), source.indexOf('  async function loadSpacePage(')), context);
  result = { view_points: [
    { from: 30, to: 40, content: '剧集' },
    { from: -1, to: 10, content: '坏数据' },
    { from: 0, to: 30, content: ' 跳过 ' }
  ] };
  const chapters = await context.getChapters('123', '456', 40);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), [
    { number: 3, title: '跳过', start: 0, end: 30 },
    { number: 1, title: '剧集', start: 30, end: 40 }
  ]);
  result = {};
  assert.equal((await context.getChapters('123', '456', 40)).length, 0);
  result = { view_points: [{ from: 0, to: 50, content: '超出时长' }] };
  await assert.rejects(context.getChapters('123', '456', 40), /有效的时间区间/);
  result = new Error('暂时不可用');
  await assert.rejects(context.getChapters('123', '456', 40), /暂时不可用/);
});

test('filename reserves bytes for the part and chapter suffix', () => {
  const name = Filename.renderTemplate('{title} - {quality}', { title: '长'.repeat(200), part: 2 }, {
    qualityLabel: '1080P', chapter: { number: 3, title: '第21/22集' + '集'.repeat(100) }
  });
  assert.ok(Buffer.byteLength(name) <= 220);
  assert.match(name, /1080P - P02-03 第21_22集/);
});

const ffmpegEncoders = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
const ffprobe = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' });
const mediaTest = {
  skip: !/\blibx264\b/.test(ffmpegEncoders.stdout || '') || ffprobe.status !== 0
};
test('mux retains decode preroll and plays only the selected color and tone', mediaTest,
  (t) => checkChapterMux(t, ''));
test('mux keeps in-range B-frames with negative composition offsets', mediaTest,
  (t) => checkChapterMux(t, '+negative_cts_offsets'));

async function checkChapterMux(t, videoFlags) {
  const dir = await mkdtemp(join(tmpdir(), 'bili-chapter-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const videoPath = join(dir, 'video.mp4');
  const audioPath = join(dir, 'audio.mp4');
  const outputPath = join(dir, 'chapter.mp4');
  function run(command, args) {
    const result = spawnSync(command, args);
    assert.equal(result.status, 0, result.stderr?.toString());
    return result.stdout;
  }
  const common = ['-v', 'error', '-y'];
  const fragmented = '+empty_moov+default_base_moof+global_sidx+frag_keyframe';
  run('ffmpeg', [...common, ...['red', 'green', 'blue'].flatMap((color) => ['-f', 'lavfi', '-i', `color=${color}:s=160x90:r=25:d=2.4`]),
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264',
    '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-movflags', fragmented + videoFlags, '-use_editlist', '0', videoPath]);
  run('ffmpeg', [...common, ...[300, 700, 1100].flatMap((tone) => ['-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=2.4`]),
    '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1[a]', '-map', '[a]', '-c:a', 'aac',
    '-frag_duration', '1500000', '-movflags', fragmented, '-use_editlist', '0', audioPath]);
  const chapter = { start: 2.55, end: 4.73 };
  async function readClip(file, video) {
    const bytes = await readFile(file);
    for (let offset = 0; offset < bytes.length;) {
      const size = bytes.readUInt32BE(offset);
      if (bytes.toString('ascii', offset + 4, offset + 8) === 'sidx') {
        const range = mp4.chapterRange(bytes.subarray(offset, offset + size), offset, bytes.length, chapter.start, chapter.end, video);
        assert.ok(range.start > offset + size && range.end < bytes.length - 1);
        return new Blob([bytes.subarray(0, offset), bytes.subarray(range.start, range.end + 1)]);
      }
      offset += size;
    }
    assert.fail('Missing test media index');
  }
  const [video, audio] = await Promise.all([readClip(videoPath, true), readClip(audioPath, false)]);
  const blob = await mp4.muxChapter(video, audio, chapter);
  await writeFile(outputPath, Buffer.from(await blob.arrayBuffer()));
  const result = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration:stream=duration,start_time', '-of', 'json', outputPath]));
  assert.equal(Number(result.format.duration), 2.18);
  assert.equal(result.streams.length, 2);
  assert.ok(result.streams.every((stream) => Number(stream.start_time) === 0 && Number(stream.duration) === 2.18));
  const rgb = run('ffmpeg', ['-v', 'error', '-i', outputPath, '-map', '0:v:0',
    '-vf', 'scale=1:1,format=rgb24', '-f', 'rawvideo', '-']);
  assert.ok(rgb.length >= 53 * 3);
  for (let i = 0; i < rgb.length; i += 3) {
    assert.ok(rgb[i] < 20 && rgb[i + 1] > 80 && rgb[i + 2] < 20, 'non-green frame in the clip');
  }
  const pcm = run('ffmpeg', ['-v', 'error', '-i', outputPath, '-map', '0:a:0', '-f', 's16le', '-']);
  let crossings = 0;
  for (let i = 2; i < pcm.length; i += 2) {
    if ((pcm.readInt16LE(i) < 0) !== (pcm.readInt16LE(i - 2) < 0)) crossings++;
  }
  assert.ok(Math.abs(crossings * 44100 / pcm.length - 700) < 15, 'unexpected tone in the clip');
}
