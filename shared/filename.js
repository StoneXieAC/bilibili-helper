/**
 * Pure filename template helpers for Bilibili downloader.
 * Attaches to globalThis.BiliDlFilename for classic script loading.
 */
(function (root) {
  'use strict';

  const VARIABLES = [
    { key: 'title', label: '标题', tip: '视频标题；缺失时回退 bilibili-video' },
    { key: 'author', label: 'UP主', tip: 'UP 主名称；缺失时省略' },
    { key: 'bvid', label: 'BV号', tip: '形如 BVxxxx；缺失时省略' },
    { key: 'part', label: '分P编号', tip: '实际分 P 编号，至少两位；无分 P 时为 01' },
    { key: 'partTitle', label: '分P标题', tip: '分 P 标题；缺失时回退标题' },
    { key: 'index', label: '批次序号', tip: '当前选中批次中的顺序，至少两位；单视频为 01' },
    { key: 'quality', label: '清晰度', tip: '如 1080P；音频任务显示「音频」' },
    { key: 'date', label: '日期', tip: '任务创建当天本地日期 YYYY-MM-DD' }
  ];

  const PRESETS = {
    title: '{title}',
    'title-bvid': '{title} - {bvid}',
    'title-bvid-quality': '{title} - {bvid} - {quality}',
    detailed: '{title} - {author} - {bvid} - {quality}'
  };

  const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  const MAX_BASENAME = 120;
  // Directory writes allow 240 bytes, including the extension and collision suffix.
  const MAX_BASENAME_BYTES = 220;
  const utf8 = new TextEncoder();

  function pad2(n) {
    const v = Math.max(0, Number(n) || 0);
    return String(v).padStart(2, '0');
  }

  function todayLocal(date) {
    const d = date instanceof Date ? date : new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function sanitizeSegment(raw, fallback) {
    let text = String(raw == null ? '' : raw)
      .normalize('NFKC')
      .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u206F]/g, '')
      .replace(/[\\/:*?"<>|~]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, '');
    if (!text) text = fallback || '';
    if (WIN_RESERVED.test(text)) text = `_${text}`;
    return text;
  }

  function truncateUnicode(text, max) {
    const chars = Array.from(String(text || ''));
    if (chars.length <= max) return chars.join('');
    return chars.slice(0, Math.max(1, max)).join('').replace(/[. ]+$/g, '') || 'bilibili-video';
  }

  function fitPrefix(text, maxChars, maxBytes, suffix = '') {
    let prefix = '';
    let chars = maxChars - suffix.length;
    let bytes = maxBytes - suffix.length;
    for (const char of text) {
      const charBytes = utf8.encode(char).length;
      if (chars <= 0 || bytes < charBytes) break;
      prefix += char;
      chars--;
      bytes -= charBytes;
    }
    return prefix ? prefix.trimEnd() + suffix : '';
  }

  function migrateStyleToTemplate(style) {
    return PRESETS[style] || PRESETS.title;
  }

  function findUnknownVariables(template) {
    const known = new Set(VARIABLES.map((item) => item.key));
    const unknown = [];
    String(template || '').replace(/\{([a-zA-Z]+)\}/g, (_, key) => {
      if (!known.has(key) && !unknown.includes(key)) unknown.push(key);
      return '';
    });
    return unknown;
  }

  function validateTemplate(template) {
    const value = String(template || '').trim();
    if (!value) return { ok: false, error: '模板不能为空' };
    if (/[\\/]|\.\./.test(value)) return { ok: false, error: '模板不能包含路径分隔符' };
    const unknown = findUnknownVariables(value);
    if (unknown.length) return { ok: false, error: `未知变量：${unknown.map((k) => `{${k}}`).join('、')}` };
    return { ok: true, template: value };
  }

  function buildValues(meta, opts) {
    const options = opts || {};
    const format = options.format || 'mp4';
    const title = sanitizeSegment(meta?.title, 'bilibili-video') || 'bilibili-video';
    const author = sanitizeSegment(meta?.author, '');
    let bvid = String(meta?.bvid || '').trim();
    if (bvid) bvid = `BV${bvid.replace(/^BV/i, '')}`;
    bvid = sanitizeSegment(bvid, '');
    const partNum = meta?.part != null ? meta.part : (meta?.page != null ? meta.page : 1);
    const part = pad2(partNum);
    const partTitle = sanitizeSegment(meta?.partTitle || meta?.part_title || title, title) || title;
    const index = pad2(options.index != null ? options.index : 1);
    const quality = format === 'm4a'
      ? (sanitizeSegment(options.qualityLabel, '') || '音频')
      : (sanitizeSegment(options.qualityLabel || meta?.quality || '', '') || '视频');
    const date = options.date || todayLocal(options.createdAt ? new Date(options.createdAt) : undefined);
    return { title, author, bvid, part, partTitle, index, quality, date };
  }

  function renderTemplate(template, meta, opts) {
    const check = validateTemplate(template);
    if (!check.ok) throw new Error(check.error);
    const batchIndex = opts?.batchIndex;
    const suffix = Number.isSafeInteger(batchIndex) && batchIndex > 0 ? `_p${batchIndex}` : '';
    const basenameChars = MAX_BASENAME - suffix.length;
    const basenameBytes = MAX_BASENAME_BYTES - suffix.length;
    const values = buildValues(meta, opts);
    // Reserve room for identifiers and quality before shortening free-form text.
    // A long title must not consume the suffix of a configured template.
    const occurrences = {};
    check.template.replace(/\{([a-zA-Z]+)\}/g, (_, key) => {
      occurrences[key] = (occurrences[key] || 0) + 1;
      return '';
    });
    const expand = () => check.template.replace(/\{([a-zA-Z]+)\}/g, (_, key) => values[key] || '');
    const render = () => sanitizeSegment(expand().replace(/\s+-\s+/g, ' - '), 'bilibili-video');
    for (const key of ['title', 'partTitle', 'author']) {
      const count = occurrences[key] || 0;
      if (!count || !values[key]) continue;
      const expanded = render();
      const excessChars = Math.max(0, Array.from(expanded).length - basenameChars);
      const excessBytes = Math.max(0, utf8.encode(expanded).length - basenameBytes);
      if (!excessChars && !excessBytes) break;
      const chars = Array.from(values[key]);
      const maxChars = Math.max(1, chars.length - Math.ceil(excessChars / count));
      const maxBytes = Math.max(utf8.encode(chars[0]).length, utf8.encode(values[key]).length - Math.ceil(excessBytes / count));
      values[key] = fitPrefix(values[key], maxChars, maxBytes, '...') || fitPrefix(values[key], maxChars, maxBytes);
    }
    const base = fitPrefix(render(), basenameChars, basenameBytes).replace(/[. ]+$/g, '') || 'bilibili-video';
    return base + suffix;
  }

  function withExtension(base, format) {
    const ext = format === 'm4a' ? 'm4a' : 'mp4';
    const safeBase = truncateUnicode(sanitizeSegment(base, 'bilibili-video') || 'bilibili-video', MAX_BASENAME);
    return `${safeBase}.${ext}`;
  }

  const api = {
    VARIABLES,
    PRESETS,
    MAX_BASENAME,
    migrateStyleToTemplate,
    validateTemplate,
    findUnknownVariables,
    renderTemplate,
    withExtension,
    sanitizeSegment,
    todayLocal,
    pad2
  };

  root.BiliDlFilename = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
