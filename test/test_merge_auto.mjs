/**
 * 自动测试：下载真实 m4s 并合并（无需浏览器手动操作）
 * 运行: node test/test_merge_auto.mjs
 */
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import vm from 'node:vm';

// Exercise the packaged, locally modified implementation, including validation.
vm.runInThisContext(fs.readFileSync(new URL('../lib/mp4-remux.iife.js', import.meta.url), 'utf8'));
vm.runInThisContext(fs.readFileSync(new URL('../lib/m4s-mux.js', import.meta.url), 'utf8'));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[3] || path.join(__dirname, '_out'));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0';
const REF = 'https://www.bilibili.com/';

function get(url, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': UA, Referer: REF } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).href, redirects + 1));
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Network stalled')));
  });
}

function getJson(url) {
  return get(url).then((b) => JSON.parse(b.toString()));
}

async function pickWorkingUrl(url) {
  const mirrors = [
    'upos-sz-mirrorali.bilivideo.com',
    'upos-sz-mirrorcos.bilivideo.com',
    'upos-sz-mirrorbos.bilivideo.com',
  ];
  const u = new URL(url);
  for (const host of [u.hostname, ...mirrors]) {
    const test = new URL(url);
    test.hostname = host;
    try {
      const lib = test.protocol === 'https:' ? https : http;
      const ok = await new Promise((resolve) => {
        const req = lib.request(test, { method: 'GET', headers: { 'User-Agent': UA, Referer: REF, Range: 'bytes=0-1' } }, (res) => {
          resolve(res.statusCode === 200 || res.statusCode === 206);
          res.destroy();
        });
        req.on('error', () => resolve(false));
        req.setTimeout(4000, () => { resolve(false); req.destroy(); });
        req.end();
      });
      if (ok) return test.toString();
    } catch { /* next */ }
  }
  return url;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const bvid = process.argv[2] || 'BV13CT66DEE5';
  console.log('=== 自动合并测试 ===', bvid);

  const view = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
  const { aid, cid } = view.data;
  const play = await getJson(
    `https://api.bilibili.com/x/player/playurl?avid=${aid}&cid=${cid}&qn=80&fnval=16&fourk=1&platform=pc`
  );
  const dash = play.data.dash;
  const video = dash.video.sort((a, b) => b.id - a.id)[0];
  const audio = dash.audio.sort((a, b) => b.id - a.id)[0];
  const videoUrl = await pickWorkingUrl(video.baseUrl || video.base_url);
  const audioUrl = await pickWorkingUrl(audio.baseUrl || audio.backupUrl?.[0] || audio.base_url);

  console.log('视频 URL:', videoUrl.slice(0, 80) + '...');
  console.log('音频 URL:', audioUrl.slice(0, 80) + '...');

  const [vBuf, aBuf] = await Promise.all([get(videoUrl), get(audioUrl)]);
  console.log(`下载完成: video=${(vBuf.length / 1024 / 1024).toFixed(2)}MB audio=${(aBuf.length / 1024 / 1024).toFixed(2)}MB`);

  fs.writeFileSync(path.join(OUT, 'video.m4s'), vBuf);
  fs.writeFileSync(path.join(OUT, 'audio.m4s'), aBuf);

  const t0 = Date.now();
  const blob = await globalThis.BiliM4sMux.mergeM4s(new Blob([vBuf]), new Blob([aBuf]), globalThis.mp4Remux);
  const mp4 = Buffer.from(await blob.arrayBuffer());
  const elapsed = Date.now() - t0;

  const outPath = path.join(OUT, 'merged.mp4');
  fs.writeFileSync(outPath, mp4);
  console.log(`合并成功: ${(mp4.length / 1024 / 1024).toFixed(2)}MB, 耗时 ${elapsed}ms`);
  console.log('输出:', outPath);

  if (mp4.length < vBuf.length * 0.5) {
    console.warn('警告: 合并文件偏小，请检查');
    process.exit(1);
  }
  console.log('PASS');
}

main().catch((e) => {
  console.error('FAIL:', e.message || e);
  process.exit(1);
});
