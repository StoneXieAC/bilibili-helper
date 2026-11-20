import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../content/content.js', import.meta.url), 'utf8');

test('面板按可视区域独立定位，支持小窗口、缩放与视口偏移', () => {
  const c = vm.createContext({
    window: { innerWidth: 1280, innerHeight: 900 },
    document: { documentElement: { clientWidth: 1280 } },
    menu: { style: {} }
  });
  vm.runInContext(source.slice(source.indexOf('    function placeMenu()'), source.indexOf('    function openMenuShell()')), c);
  c.placeMenu();
  assert.equal(c.menu.style.left, '856px');
  assert.equal(c.menu.style.top, '234px');
  assert.equal(c.menu.style.width, '408px');
  assert.equal(c.menu.style.height, '650px');
  for (const viewport of [
    { width: 320, height: 480, offsetLeft: 0, offsetTop: 0 },
    { width: 200, height: 250, offsetLeft: 80, offsetTop: 100 },
    { width: 20, height: 30, offsetLeft: 0, offsetTop: 0 }
  ]) {
    c.window.visualViewport = viewport;
    c.placeMenu();
    const { left, top, width, height } = Object.fromEntries(
      Object.entries(c.menu.style).map(([key, value]) => [key, parseFloat(value)]));
    assert.ok(left >= viewport.offsetLeft && top >= viewport.offsetTop);
    assert.ok(left + width <= viewport.offsetLeft + viewport.width);
    assert.ok(top + height <= viewport.offsetTop + viewport.height);
    assert.ok(width > 0 && height > 0);
  }
});
