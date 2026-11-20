// 验证生产页面代理的实际接口路径；匿名网络测试，不下载媒体。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../content/page-agent.js', import.meta.url), 'utf8');
const location = { origin: 'https://www.bilibili.com', href: 'https://www.bilibili.com/' };
const context = vm.createContext({
  window: { addEventListener() {}, postMessage() {} }, location,
  document: { cookie: '' }, console, URL, URLSearchParams, TextEncoder,
  AbortController, setTimeout, clearTimeout, fetch
});
vm.runInContext(source.replace(/\}\)\(\);\s*$/, 'window.test = { resolveVideo, getQualities }; })();'), context);
const bvid = process.argv[2] || 'BV1GJ411x7h7';
assert.match(bvid, /^BV[a-zA-Z0-9]{10}$/);
const info = await context.window.test.resolveVideo(`https://www.bilibili.com/video/${bvid}`, 0);
assert.ok(info.aid && info.cid);
const result = await context.window.test.getQualities(info.aid, info.cid);
assert.ok(result.qualities.length);
console.log('PASS:', bvid, result.qualities.map(item => item.label).join(', '));
