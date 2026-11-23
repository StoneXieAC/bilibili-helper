const EXT = typeof browser !== 'undefined' ? browser : chrome;

const VERSION = EXT.runtime.getManifest().version;

document.getElementById('app-version').textContent = 'v' + VERSION;

const THEME_PREF_KEY = 'biliDlTheme_v1';

function t(key, values) {

  return globalThis.BiliDlI18n?.t?.(key, values) ?? key;

}

function applyPopupTheme(value) {

  const Theme = globalThis.BiliDlTheme;

  if (!Theme) return;

  Theme.applyToRoot(document.body, value);

}

function applyPopupLanguage() {

  globalThis.BiliDlI18n?.apply(document);

}

function translateUserError(msg) {

  const s = String(msg || '');

  const exact = {

    '无法获取视频信息': 'getInfoFailed',

    '页面数据未加载': 'pageDataNotLoaded',

    '页面未就绪': 'pageNotReady'

  };

  if (exact[s]) return t(exact[s]);

  return s;

}

Promise.all([

  globalThis.BiliDlI18n?.ready,

  globalThis.BiliDlTheme?.loadThemes?.()

]).then(() => EXT.storage.local.get(THEME_PREF_KEY))

  .then((data) => {

    applyPopupLanguage();

    applyPopupTheme(data?.[THEME_PREF_KEY]);

    init();

  })

  .catch(() => init());

EXT.storage.onChanged?.addListener((changes, area) => {

  if (area !== 'local') return;

  if (changes[THEME_PREF_KEY]) applyPopupTheme(changes[THEME_PREF_KEY].newValue);

  if (changes[globalThis.BiliDlI18n?.KEY]) applyPopupLanguage();

});

globalThis.BiliDlI18n?.onChange?.(() => applyPopupLanguage());



const $ = (id) => document.getElementById(id);



function clearNode(node) {

  node.replaceChildren();

}



function appendDiv(parent, className, text, title) {

  const el = document.createElement('div');

  el.className = className;

  el.textContent = text;

  if (title) el.title = title;

  parent.appendChild(el);

  return el;

}



function isBiliDownloadUrl(url) {

  try {
    const { protocol, hostname, pathname } = new URL(url);
    if (protocol !== 'https:') return false;
    if (hostname === 'space.bilibili.com') return isSpaceDownloadUrl(url);
    if (hostname === 'www.bilibili.com' && /^\/(?:zh-Hans\/)?bangumi\/play\//.test(pathname)) return true;
    if (['www.bilibili.com', 'bilibili.com'].includes(hostname) && pathname.startsWith('/list/')) return true;
    return ['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(hostname) && pathname.startsWith('/video/');
  } catch {
    return false;
  }

}



function isSpaceDownloadUrl(value) {

  try {

    const url = new URL(value);

    return url.hostname === 'space.bilibili.com' && /^\/\d+(?:\/upload\/video|\/lists(?:\/\d+)?)?\/?$/.test(url.pathname);

  } catch { return false; }

}



function formatCurrentSite(url) {

  if (!url) return t('currentPageEmpty');

  try {

    const u = new URL(url);

    if (u.protocol !== 'http:' && u.protocol !== 'https:') {

      return t('currentPage') + u.protocol.replace(':', '');

    }

    let path = u.pathname;

    if (path.length > 24) path = path.slice(0, 24) + '…';

    const suffix = path && path !== '/' ? path : '';

    return t('currentPage') + u.hostname + suffix;

  } catch {

    return t('currentPageUnknown');

  }

}



const HISTORY_KEY = EXT.extension?.inIncognitoContext ? 'biliDlHistoryPrivate' : 'biliDlHistory';



function historyPartKey(h) {

  if (h?.cid) return `c:${h.cid}`;

  return `b:${h?.bvid || ''}#${h?.pageIndex ?? 0}`;

}



/** 同集同格式只留一条；MP4 与故意下的 M4A 可并列 */

function pruneHistoryItems(items) {

  const kept = [];

  const seen = new Set();

  for (const h of (Array.isArray(items) ? items : []).filter(Boolean)) {

    const fmt = h.format === 'm4a' ? 'm4a' : 'mp4';

    const dedupeKey = `${historyPartKey(h)}|${fmt}`;

    if (seen.has(dedupeKey)) continue;

    seen.add(dedupeKey);

    kept.push(h);

  }

  return kept;

}



async function loadHistory() {

  try {

    const { [HISTORY_KEY]: items } = await EXT.storage.local.get(HISTORY_KEY);

    return pruneHistoryItems(items);

  } catch {

    return [];

  }

}



function historyEntryUrl(entry) {

  if (/^\d+$/.test(String(entry?.epId || ''))) return `https://www.bilibili.com/bangumi/play/ep${entry.epId}`;

  if (!entry?.bvid) return null;

  return `https://www.bilibili.com/video/${entry.bvid}${entry.pageIndex > 0 ? `?p=${entry.pageIndex + 1}` : ''}`;

}



function formatHistoryTime(ts) {

  const d = new Date(ts);

  const pad = (n) => String(n).padStart(2, '0');

  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

}



function formatBytes(n) {

  const v = Number(n) || 0;

  if (v >= 1024 * 1024 * 1024) return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';

  if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';

  if (v >= 1024) return Math.round(v / 1024) + ' KB';

  if (v > 0) return v + ' B';

  return '0 B';

}



/** 与面板一致：跳转视频页并自动展开下载面板 */

async function openHistoryEntry(entry) {

  const url = historyEntryUrl(entry);

  if (!url) return;



  await EXT.storage.local.set({ biliDlAutoOpen: 1 });



  const [active] = await EXT.tabs.query({ active: true, currentWindow: true });

  if (active?.id && isBiliDownloadUrl(active.url)) {

    try {

      await EXT.scripting.executeScript({

        target: { tabId: active.id },

        func: () => {

          try { sessionStorage.setItem('biliDlAutoOpen', '1'); } catch { /* ignore */ }

        }

      });

    } catch { /* ignore */ }

    await EXT.tabs.update(active.id, { url });

    window.close();

    return;

  }



  if (active?.id && active.url && /bilibili\.com/i.test(active.url)) {

    try {

      await EXT.scripting.executeScript({

        target: { tabId: active.id },

        func: () => {

          try { sessionStorage.setItem('biliDlAutoOpen', '1'); } catch { /* ignore */ }

        }

      });

    } catch { /* ignore */ }

    await EXT.tabs.update(active.id, { url });

    window.close();

    return;

  }



  await EXT.tabs.create({ url });

  window.close();

}



async function renderPopupHistory() {

  const items = await loadHistory();

  const countEl = $('popup-history-count');

  const listEl = $('popup-history-list');

  const clearEl = $('popup-history-clear');

  if (items.length) {

    countEl.textContent = items.length;

    countEl.classList.remove('hidden');

    clearEl.classList.remove('hidden');

    clearNode(listEl);

    const frag = document.createDocumentFragment();

    items.forEach((h, i) => {

      const itemEl = document.createElement('div');

      itemEl.className = 'popup-history-item';

      const mainEl = document.createElement('div');

      mainEl.className = 'popup-history-item-main';

      itemEl.appendChild(mainEl);

      appendDiv(mainEl, 'popup-history-item-title', h.title || t('untitled'), h.title || t('untitled'));

      appendDiv(

        mainEl,

        'popup-history-item-meta',

        `${formatHistoryTime(h.ts)} · ${h.label || ''}${h.format === 'm4a' ? ' · M4A' : ''}${h.fileSize ? ' · ' + formatBytes(h.fileSize) : ''}`

      );

      if (historyEntryUrl(h)) {

        const btn = document.createElement('button');

        btn.type = 'button';

        btn.className = 'popup-history-open';

        btn.textContent = t('historyOpen');

        btn.addEventListener('click', async () => {

          const entry = items[i];

          if (entry) await openHistoryEntry(entry);

        });

        itemEl.appendChild(btn);

      }

      if (Number.isInteger(h.downloadId)) {
        const showFile = document.createElement('button');
        showFile.type = 'button';
        showFile.className = 'popup-history-open';
        showFile.textContent = t('historyShowFile');
        showFile.addEventListener('click', async () => {
          try {
            const [download] = await EXT.downloads.search({ id: h.downloadId });
            if (!download || download.byExtensionId !== EXT.runtime.id || download.exists === false ||
                Boolean(download.incognito) !== Boolean(EXT.extension.inIncognitoContext)) {
              throw new Error(t('historyFileMissing'));
            }
            await EXT.downloads.show(h.downloadId);
          } catch (error) {
            showFile.title = error?.message || t('historyFileMissing');
            showFile.textContent = t('historyFileMissing');
            showFile.disabled = true;
          }
        });
        itemEl.appendChild(showFile);
      }
      frag.appendChild(itemEl);

    });

    listEl.appendChild(frag);

  } else {

    countEl.classList.add('hidden');

    clearEl.classList.add('hidden');

    clearNode(listEl);

    appendDiv(listEl, 'popup-history-empty', t('historyEmpty'));

  }

}



function showEmptyState(tab) {

  const siteEl = $('empty-current-site');

  if (siteEl) siteEl.textContent = formatCurrentSite(tab?.url);

  showState('state-empty');

}



function showState(name) {

  ['state-loading', 'state-empty', 'state-error'].forEach((id) => {

    $(id).classList.toggle('hidden', id !== name);

  });

}



async function init() {
  showState('state-loading');
  const [tab] = await EXT.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !isBiliDownloadUrl(tab.url)) {
    showEmptyState(tab);
    return;
  }
  const tabId = tab.id;
  $('btn-retry').onclick = async () => {
    try {
      await EXT.tabs.reload(tabId);
      window.close();
    } catch {
      $('error-text').textContent = t('cannotRefreshPage');
    }
  };
  try {
    const response = await EXT.tabs.sendMessage(tabId, { type: 'BILI_DL_OPEN_PANEL', fromToolbar: true });
    if (!response?.ok) throw new Error(t('pageNotReady'));
    window.close();
  } catch {
    $('error-text').textContent = t('cannotOpenPanel');
    showState('state-error');
  }
}

document.getElementById('popup-history-toggle')?.addEventListener('click', async () => {

  const panel = document.getElementById('popup-history-panel');

  const hidden = panel.classList.contains('hidden');

  panel.classList.toggle('hidden', !hidden);

  if (hidden) await renderPopupHistory();

});



document.getElementById('popup-history-clear')?.addEventListener('click', async () => {

  const result = await EXT.runtime.sendMessage({ type: 'BILI_DL_CLEAR_HISTORY', incognito: Boolean(EXT.extension?.inIncognitoContext) });
  if (!result?.ok) return;

  await renderPopupHistory();

});



renderPopupHistory();

