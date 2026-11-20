// MV3 Service Worker — 处理浏览器原生下载与下载期间的电源管理
chrome.runtime.onInstalled.addListener(() => {
  const v = chrome.runtime.getManifest().version;
  console.log('[BiliDL] 已安装 v' + v);
});

function isBilibiliSender(sender) {
  try {
    const senderUrl = new URL(sender.url || '');
    return sender.id === chrome.runtime.id && sender.tab &&
      senderUrl.protocol === 'https:' && /(^|\.)bilibili\.com$/.test(senderUrl.hostname);
  } catch {
    return false;
  }
}

// Serialize history mutations across all pages connected to this background.
// A separate read-modify-write queue in each content script loses entries
// when multiple tabs finish a download at the same time.
let historyWriteQueue = Promise.resolve();

async function updateHistory(entry, incognito) {
  // Chromium split backgrounds share storage.local, so give their histories
  // distinct keys. Use the sending tab context when choosing its history key.
  const key = incognito ? 'biliDlHistoryPrivate' : 'biliDlHistory';
  if (!entry) {
    await chrome.storage.local.set({ [key]: [] });
    return [];
  }
  const data = await chrome.storage.local.get(key);
  const items = Array.isArray(data[key]) ? data[key] : [];
  const older = items.filter((item) => {
    if (!item || typeof item !== 'object') return false;
    // Older records can lack CID; preserve the BV + part migration fallback.
    const samePart = item.cid && entry.cid ? String(item.cid) === String(entry.cid)
      : item.bvid === entry.bvid && (item.pageIndex ?? 0) === (entry.pageIndex ?? 0);
    return !samePart || (item.format === 'm4a') !== (entry.format === 'm4a');
  });
  const seen = new Set();
  const next = [entry, ...older].filter((item) => {
    if (!item || typeof item !== 'object') return false;
    const part = item.cid ? `c:${item.cid}` : `b:${item.bvid || ''}#${item.pageIndex ?? 0}`;
    const key = `${part}|${item.format === 'm4a' ? 'm4a' : 'mp4'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 50);
  await chrome.storage.local.set({ [key]: next });
  return next;
}

function queueHistoryUpdate(entry, incognito) {
  const write = historyWriteQueue.then(() => updateHistory(entry, incognito));
  historyWriteQueue = write.catch(() => {});
  return write;
}

// One system wake request is shared by content connections and native saves.
const powerPorts = new Map();
const powerDownloadIds = new Set();
let pendingPowerDownloads = 0;
let powerTimer = null;
let powerHeld = false;
const canKeepAwake = Boolean(chrome.power?.requestKeepAwake && chrome.power?.releaseKeepAwake);

function syncPower(force = false) {
  if (!canKeepAwake) return;
  const needed = pendingPowerDownloads > 0 || powerDownloadIds.size > 0 || [...powerPorts.values()].some(Boolean);
  try {
    if (needed && (!powerHeld || force)) chrome.power.requestKeepAwake('system');
    if (!needed && (powerHeld || force)) chrome.power.releaseKeepAwake();
    powerHeld = needed;
  } catch (error) {
    console.warn('[BiliDL] 防休眠失败', error);
    for (const port of powerPorts.keys()) {
      try { port.postMessage({ type: 'ERROR', error: '防休眠接口调用失败' }); } catch { /* Closed document. */ }
    }
  }
  if ((needed || powerHeld) && powerTimer === null) {
    powerTimer = setInterval(() => {
      for (const [port, active] of powerPorts) {
        if (!active) continue;
        try { port.postMessage({ type: 'POLL' }); } catch { powerPorts.delete(port); }
      }
      // An API call also keeps the MV3 worker alive during native saves.
      syncPower(true);
    }, 20000);
  } else if (!needed && !powerHeld && powerTimer !== null) {
    clearInterval(powerTimer);
    powerTimer = null;
  }
}

function beginPowerDownload() {
  if (!canKeepAwake) return;
  pendingPowerDownloads++;
  syncPower();
}

function finishPowerDownload(downloadId) {
  if (!canKeepAwake) return;
  pendingPowerDownloads = Math.max(0, pendingPowerDownloads - 1);
  if (Number.isInteger(downloadId)) {
    powerDownloadIds.add(downloadId);
    // Completion may precede the download() callback; reconcile with actual state.
    chrome.downloads.search({ id: downloadId }).then(([item]) => {
      if (!item || item.byExtensionId !== chrome.runtime.id || item.state !== 'in_progress') powerDownloadIds.delete(downloadId);
      syncPower();
    }).catch((error) => console.warn('[BiliDL] 防休眠下载状态读取失败', error));
  }
  syncPower();
}

chrome.runtime.onConnect?.addListener((port) => {
  if (port.name !== 'BILI_DL_POWER') return;
  if (!isBilibiliSender(port.sender)) {
    port.disconnect();
    return;
  }
  if (!canKeepAwake) {
    port.postMessage({ type: 'ERROR', unsupported: true, error: '当前浏览器不支持下载防休眠' });
    return;
  }
  powerPorts.set(port, false);
  port.onMessage.addListener((message) => {
    if (message?.type !== 'STATE' || typeof message.active !== 'boolean') return;
    powerPorts.set(port, message.active);
    syncPower();
  });
  port.onDisconnect.addListener(() => {
    powerPorts.delete(port);
    syncPower();
  });
});

if (canKeepAwake) {
  // Track terminal events during the initial query so stale results cannot
  // resurrect a finished download when a service worker has restarted.
  let recovering = true;
  const endedDuringRecovery = new Set();
  chrome.downloads.onChanged.addListener((delta) => {
    if (!['complete', 'interrupted'].includes(delta.state?.current)) return;
    if (recovering) endedDuringRecovery.add(delta.id);
    powerDownloadIds.delete(delta.id);
    syncPower();
  });
  chrome.downloads.onErased.addListener((id) => {
    if (recovering) endedDuringRecovery.add(id);
    powerDownloadIds.delete(id);
    syncPower();
  });
  chrome.downloads.search({ state: 'in_progress' }).then((items) => {
    for (const item of items) {
      if (item.byExtensionId === chrome.runtime.id && item.state === 'in_progress' &&
          Boolean(item.incognito) === Boolean(chrome.extension.inIncognitoContext) && !endedDuringRecovery.has(item.id)) {
        powerDownloadIds.add(item.id);
      }
    }
    syncPower(true);
  }).catch((error) => console.warn('[BiliDL] 防休眠下载恢复失败', error)).finally(() => {
    recovering = false;
    endedDuringRecovery.clear();
  });
}

function encodeBase64(bytes) {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

// Register before creating downloads: filename determination can run before
// downloads.download resolves with its ID. Match each unique download URL.
const pendingMediaFilenames = new Map();
chrome.downloads.onDeterminingFilename?.addListener((item, suggest) => {
  const expected = pendingMediaFilenames.get(item.url);
  if (!expected || item.byExtensionId !== chrome.runtime.id) {
    suggest();
    return;
  }
  pendingMediaFilenames.delete(item.url);
  suggest({ filename: expected.filename, conflictAction: 'uniquify' });
});

// Request IDs are scoped to the sending document; another tab/frame cannot
// cancel its neighbour's cover read even if it supplies the same ID.
const batchCoverRequests = new Map();
function batchCoverRequestKey(sender, requestId) {
  if (!isBilibiliSender(sender) || !Number.isInteger(sender.tab.id) ||
    typeof requestId !== 'string' || !requestId || requestId.length > 128) return null;
  return JSON.stringify([sender.tab.id, sender.frameId ?? 0,
    sender.documentId || sender.url, Boolean(sender.tab.incognito), requestId]);
}

async function readBatchCover(url, key) {
  if (batchCoverRequests.has(key)) throw new Error('重复的封面请求');
  const controller = new AbortController();
  batchCoverRequests.set(key, controller);
  // Covers are small: bound the entire fetch, including a stalled response body.
  const timer = setTimeout(() => controller.abort(new Error('封面读取超时')), 30000);
  try {
    const response = await fetch(url, { credentials: 'omit', redirect: 'error', signal: controller.signal });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const mime = String(response.headers.get('content-type') || '').split(';', 1)[0].toLowerCase();
    if (!/^image\/(jpeg|png|webp)$/.test(mime)) throw new Error('封面格式无效');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!bytes.length) throw new Error('封面内容为空');
    return { ok: true, mime, base64: encodeBase64(bytes) };
  } catch (error) {
    throw controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    clearTimeout(timer);
    batchCoverRequests.delete(key);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'BILI_DL_ADD_HISTORY' || msg?.type === 'BILI_DL_CLEAR_HISTORY') {
    const adding = msg.type === 'BILI_DL_ADD_HISTORY';
    const allowed = adding ? isBilibiliSender(_sender)
      : _sender.id === chrome.runtime.id && _sender.url === chrome.runtime.getURL('popup/popup.html');
    if (!allowed || (adding && (!msg.entry || typeof msg.entry !== 'object' ||
        typeof msg.entry.bvid !== 'string' || !msg.entry.bvid || typeof msg.entry.title !== 'string'))) {
      sendResponse({ ok: false, error: '不允许的历史记录请求' });
      return;
    }
    queueHistoryUpdate(adding ? msg.entry : null, adding ? Boolean(_sender.tab.incognito) : msg.incognito === true)
      .then((items) => sendResponse({ ok: true, items }),
        (error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }
  if (msg?.type === 'BILI_DL_CHECK_DOWNLOAD_CONTEXT') {
    if (!isBilibiliSender(_sender)) {
      sendResponse({ ok: false, error: '不允许的下载请求' });
      return;
    }
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return;
  }
  if (['BILI_DL_SAVE_MEDIA', 'BILI_DL_MEDIA_STATE', 'BILI_DL_CANCEL_MEDIA'].includes(msg?.type)) {
    (async () => {
      const senderUrl = new URL(_sender.url || '');
      if (!isBilibiliSender(_sender)) throw new Error('不允许的下载请求');
      if (msg.type === 'BILI_DL_SAVE_MEDIA') {
        if (_sender.tab.incognito && !chrome.extension.inIncognitoContext) {
          throw new Error('无痕保存环境未分离，请重载扩展并重新打开无痕页面');
        }
        const url = new URL(String(msg.url || ''));
        if (url.protocol !== 'blob:' || url.origin !== senderUrl.origin) throw new Error('无效的媒体地址');
        const filename = String(msg.filename || '');
        if (!filename || /[\\/\x00-\x1f]/.test(filename) || !/\.(mp4|m4a)$/.test(filename)) throw new Error('无效的文件名');
        for (const [key, entry] of pendingMediaFilenames) {
          if (Date.now() - entry.at > 600000) pendingMediaFilenames.delete(key);
        }
        pendingMediaFilenames.set(url.href, { filename, at: Date.now() });
        let downloadId;
        beginPowerDownload();
        try {
          downloadId = await chrome.downloads.download({ url: url.href, filename, saveAs: false, conflictAction: 'uniquify' });
          console.info('[BiliDL] 浏览器保存已创建', { downloadId, filename, incognito: Boolean(_sender.tab.incognito) });
        } catch (error) {
          pendingMediaFilenames.delete(url.href);
          console.warn('[BiliDL] 浏览器保存创建失败', { filename, incognito: Boolean(_sender.tab.incognito), error: String(error?.message || error) });
          throw error;
        } finally {
          finishPowerDownload(downloadId);
        }
        return { ok: true, downloadId };
      }
      if (!Number.isInteger(msg.downloadId)) throw new Error('无效的下载编号');
      const [item] = await chrome.downloads.search({ id: msg.downloadId });
      // Re-check ownership after service-worker restarts; never expose other downloads.
      if (!item || item.byExtensionId !== chrome.runtime.id ||
          Boolean(item.incognito) !== Boolean(_sender.tab.incognito)) throw new Error('下载记录不可用，请打开浏览器下载记录检查');
      if (msg.type === 'BILI_DL_CANCEL_MEDIA' && item.state === 'in_progress') await chrome.downloads.cancel(item.id);
      if (msg.type === 'BILI_DL_CANCEL_MEDIA' || item.state === 'complete' || item.state === 'interrupted') pendingMediaFilenames.delete(item.url);
      return { ok: true, state: item.state, error: item.error || '', bytesReceived: item.bytesReceived || 0,
        actualFilename: String(item.filename || '').split(/[\\/]/).pop() || '' };
    })().then(sendResponse, (error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }
  if (msg?.type === 'BILI_DL_OPEN_DOWNLOADS') {
    const url = typeof browser !== 'undefined' && browser.runtime.getBrowserInfo ? 'about:downloads' : 'chrome://downloads/';
    chrome.tabs.create({ url }, () => {
      const error = chrome.runtime.lastError;
      sendResponse({ ok: !error, error: error?.message || '' });
    });
    return true;
  }
  if (msg?.type === 'BILI_DL_CANCEL_COVER') {
    const key = batchCoverRequestKey(_sender, msg.requestId);
    if (!key) {
      sendResponse({ ok: false, error: '不允许的封面取消请求' });
      return;
    }
    batchCoverRequests.get(key)?.abort(new Error('下载已取消'));
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === 'BILI_DL_DOWNLOAD_COVER') {
    if (!isBilibiliSender(_sender)) {
      sendResponse({ ok: false, error: '不允许的下载请求' });
      return;
    }
    const sourceUrl = String(msg.url || '').trim();
    const filename = String(msg.filename || 'bilibili-cover.jpg');
    if (!filename || /[\\/\x00-\x1f]/.test(filename) || !/\.(jpe?g|png|webp)$/i.test(filename)) {
      sendResponse({ ok: false, error: '无效的文件名' });
      return;
    }
    let url;
    try {
      url = new URL(sourceUrl.replace(/^http:\/\//i, 'https://'));
    } catch { /* Invalid addresses are rejected with the same error as other disallowed URLs. */ }
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.port ||
      !/(^|\.)hdslb\.com$/.test(url.hostname)) {
      sendResponse({ ok: false, error: '不允许的封面地址' });
      return;
    }
    if (msg.forBatch === true) {
      const key = batchCoverRequestKey(_sender, msg.requestId);
      if (!key) {
        sendResponse({ ok: false, error: '无效的封面请求编号' });
        return;
      }
      readBatchCover(url, key)
        .then(sendResponse, (error) => sendResponse({ ok: false, error: String(error.message || error) }));
      return true;
    }
    console.info('[BiliDL] 封面下载请求', { filename, hostname: url.hostname });
    // A fragment does not change the CDN resource, but distinguishes concurrent
    // downloads of the same cover when their template metadata differs.
    url.hash = `bili-dl-cover-${crypto.randomUUID()}`;
    for (const [key, entry] of pendingMediaFilenames) {
      if (Date.now() - entry.at > 600000) pendingMediaFilenames.delete(key);
    }
    pendingMediaFilenames.set(url.href, { filename, at: Date.now() });
    beginPowerDownload();
    chrome.downloads.download({ url: url.href, filename, saveAs: false, conflictAction: 'uniquify' }, (downloadId) => {
      const error = chrome.runtime.lastError;
      finishPowerDownload(error ? undefined : downloadId);
      if (error) {
        pendingMediaFilenames.delete(url.href);
        console.error('[BiliDL] 封面下载启动失败', error.message || error);
        sendResponse({ ok: false, error: error.message || '封面下载失败' });
      } else {
        console.info('[BiliDL] 封面下载已创建', { downloadId, filename });
        sendResponse({ ok: true, downloadId });
      }
    });
    return true;
  }
});
