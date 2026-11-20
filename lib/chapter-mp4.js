/* DASH byte indexing and MP4 sample tables for chapter downloads. */
(function (root) {
  'use strict';

  const INDEX_ERROR = '片源没有可用的章节媒体索引';
  const MEDIA_ERROR = '无法验证章节的音视频边界';

  function requireValid(condition, message = MEDIA_ERROR) {
    if (!condition) throw new Error(message);
  }

  function view(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  function uint64(data, offset) {
    const value = Number(data.getBigUint64(offset));
    requireValid(Number.isSafeInteger(value));
    return value;
  }

  function boxHeader(data, offset, limit) {
    requireValid(offset + 8 <= limit);
    const type = String.fromCharCode(...Array.from({ length: 4 }, (_, i) => data.getUint8(offset + 4 + i)));
    const shortSize = data.getUint32(offset);
    const header = shortSize === 1 ? 16 : 8;
    requireValid(offset + header <= limit);
    const size = shortSize === 1 ? uint64(data, offset + 8) : shortSize || limit - offset;
    requireValid(size >= header && size <= limit - offset);
    return { type, header, size };
  }

  function boxes(bytes) {
    const data = view(bytes);
    const result = [];
    for (let offset = 0; offset < bytes.length;) {
      const { type, header, size } = boxHeader(data, offset, bytes.length);
      result.push({ type, bytes: bytes.subarray(offset, offset + size), body: bytes.subarray(offset + header, offset + size) });
      offset += size;
    }
    return result;
  }

  function child(parent, type) {
    const box = boxes(parent.body).find((value) => value.type === type);
    requireValid(box);
    return box;
  }

  function chapterRange(bytes, indexStart, fileSize, start, end, video) {
    try {
      const list = boxes(bytes);
      const index = list.findIndex((box) => box.type === 'sidx');
      requireValid(index >= 0);
      const data = view(list[index].body);
      const version = data.getUint8(0);
      const timescale = data.getUint32(8);
      requireValid(version <= 1 && timescale > 0);
      let time = version ? uint64(data, 12) : data.getUint32(12);
      const firstOffset = version ? uint64(data, 20) : data.getUint32(16);
      let offset = indexStart + list.slice(0, index + 1).reduce((size, box) => size + box.bytes.length, 0) + firstOffset;
      const countOffset = version ? 30 : 22;
      const count = data.getUint16(countOffset);
      requireValid(count > 0 && countOffset + 2 + 12 * count === data.byteLength);
      const entries = [];
      for (let i = 0; i < count; i++) {
        const pos = countOffset + 2 + 12 * i;
        const size = data.getUint32(pos);
        const duration = data.getUint32(pos + 4);
        const sap = data.getUint32(pos + 8);
        requireValid(size > 0 && size < 0x80000000 && duration > 0 && offset + size <= fileSize);
        entries.push({ byte: offset, last: offset + size - 1, start: time / timescale,
          end: (time + duration) / timescale, sync: sap === 0x80000000 || sap === 0x90000000 || sap === 0xa0000000 });
        offset += size;
        time += duration;
      }
      let first = entries.findIndex((item) => item.end > start);
      const last = entries.findLastIndex((item) => item.start < end);
      requireValid(first >= 0 && last >= first);
      while (video && first > 0 && !entries[first].sync) first--;
      requireValid(!video || entries[first].sync);
      return { start: entries[first].byte, end: entries[last].last };
    } catch {
      throw new Error(INDEX_ERROR);
    }
  }

  function fullBox(bytes) {
    const data = view(bytes);
    const header = data.getUint32(0);
    return { data, version: header >>> 24, flags: header & 0xffffff };
  }

  function clock(box, track = false) {
    const { version, data } = fullBox(box.body);
    requireValid(version <= 1);
    const field = version ? 20 : 12;
    return { data, version, field, duration: field + (track ? 8 : 4) };
  }

  function sourceEdit(trak) {
    const edts = boxes(trak.body).find((box) => box.type === 'edts');
    if (!edts) return 0;
    const { data, version } = fullBox(child(edts, 'elst').body);
    const offset = version ? 16 : 12;
    requireValid(version <= 1 && data.getUint32(4) === 1 && data.getUint32(offset + (version ? 8 : 4)) === 0x10000);
    const mediaTime = version ? Number(data.getBigInt64(offset)) : data.getInt32(offset);
    requireValid(Number.isSafeInteger(mediaTime) && mediaTime >= 0);
    return mediaTime;
  }

  async function readSampleTrack(blob, video, options) {
    let init;
    let pending;
    let decodeStart;
    let decodeEnd;
    let minPts = Infinity;
    let maxPts = -Infinity;
    let sampleTolerance = 0;
    const durations = [], compositionOffsets = [], sizes = [], keyframes = [], payload = [];

    for (let offset = 0; offset < blob.size;) {
      if (options.shouldCancel?.()) throw new Error('下载已取消');
      const header = view(new Uint8Array(await blob.slice(offset, offset + 16).arrayBuffer()));
      options.onActivity?.();
      const { type, size, header: headerSize } = boxHeader(header, 0, blob.size - offset);
      const end = offset + size;
      if (type === 'moov') {
        requireValid(!init && size <= 4 * 1024 * 1024);
        const moov = { body: new Uint8Array(await blob.slice(offset + headerSize, end).arrayBuffer()) };
        const trak = child(moov, 'trak');
        const mdia = child(trak, 'mdia');
        const trex = view(child(child(moov, 'mvex'), 'trex').body);
        const handler = child(mdia, 'hdlr');
        const kind = String.fromCharCode(...handler.body.subarray(8, 12));
        requireValid(kind === (video ? 'vide' : 'soun'));
        init = { moov, trak, mdia, trex, edit: sourceEdit(trak) };
      } else if (type === 'moof') {
        requireValid(init && !pending && size <= 4 * 1024 * 1024);
        const moof = { body: new Uint8Array(await blob.slice(offset + headerSize, end).arrayBuffer()) };
        const traf = child(moof, 'traf');
        requireValid(boxes(moof.body).filter((box) => box.type === 'traf').length === 1);
        const { data: tfhd, flags } = fullBox(child(traf, 'tfhd').body);
        const tfdt = fullBox(child(traf, 'tfdt').body);
        const trex = init.trex;
        requireValid(tfhd.getUint32(4) === trex.getUint32(4) && !(flags & 1) && tfdt.version <= 1);
        let field = 8;
        requireValid((flags & 2 ? tfhd.getUint32(field) : trex.getUint32(8)) === 1);
        if (flags & 2) field += 4;
        const defaultDuration = flags & 8 ? tfhd.getUint32(field) : trex.getUint32(12);
        if (flags & 8) field += 4;
        const defaultSize = flags & 16 ? tfhd.getUint32(field) : trex.getUint32(16);
        if (flags & 16) field += 4;
        const defaultFlags = flags & 32 ? tfhd.getUint32(field) : trex.getUint32(20);
        let dts = tfdt.version ? uint64(tfdt.data, 4) : tfdt.data.getUint32(4);
        if (decodeStart === undefined) decodeStart = dts;
        else requireValid(decodeEnd === dts);
        pending = [];
        for (const run of boxes(traf.body).filter((box) => box.type === 'trun')) {
          const { data, flags: runFlags, version } = fullBox(run.body);
          const count = data.getUint32(4);
          requireValid(count > 0 && count <= 100000 && version <= 1 && !(runFlags & 4 && runFlags & 0x400));
          let cursor = 8;
          const start = runFlags & 1 ? offset + data.getInt32(cursor) : pending.at(-1)?.end;
          if (runFlags & 1) cursor += 4;
          requireValid(Number.isSafeInteger(start));
          const firstFlags = runFlags & 4 ? data.getUint32(cursor) : defaultFlags;
          if (runFlags & 4) cursor += 4;
          let runBytes = 0;
          for (let i = 0; i < count; i++) {
            const duration = runFlags & 0x100 ? data.getUint32(cursor) : defaultDuration;
            if (runFlags & 0x100) cursor += 4;
            const sampleSize = runFlags & 0x200 ? data.getUint32(cursor) : defaultSize;
            if (runFlags & 0x200) cursor += 4;
            const sampleFlags = runFlags & 0x400 ? data.getUint32(cursor) : i === 0 ? firstFlags : defaultFlags;
            if (runFlags & 0x400) cursor += 4;
            const composition = runFlags & 0x800 ? (version ? data.getInt32(cursor) : data.getUint32(cursor)) : 0;
            if (runFlags & 0x800) cursor += 4;
            requireValid(duration > 0 && sampleSize > 0 && Number.isSafeInteger(dts + composition + duration));
            requireValid(composition <= 0x7fffffff);
            durations.push(duration);
            compositionOffsets.push(composition);
            sizes.push(sampleSize);
            if (video && !(sampleFlags & 0x10000) && ((sampleFlags >>> 24) & 3) !== 1) keyframes.push(sizes.length);
            minPts = Math.min(minPts, dts + composition);
            maxPts = Math.max(maxPts, dts + composition + duration);
            sampleTolerance = Math.max(sampleTolerance, duration);
            runBytes += sampleSize;
            dts += duration;
          }
          pending.push({ start, end: start + runBytes });
        }
        requireValid(pending.length > 0);
        decodeEnd = dts;
      } else if (type === 'mdat') {
        requireValid(pending);
        let next = offset + headerSize;
        for (const run of pending) {
          requireValid(run.start >= next && run.end <= end);
          payload.push(blob.slice(run.start, run.end));
          next = run.end;
        }
        pending = null;
        options.onChunk?.(size);
      }
      offset = end;
    }
    requireValid(init && !pending && sizes.length && (!video || keyframes[0] === 1));
    return { ...init, durations, compositionOffsets, sizes, keyframes, payload,
      decodeStart, minPts, maxPts, sampleTolerance };
  }

  function integers(values, signed = false) {
    const bytes = new Uint8Array(values.length * 4);
    const data = view(bytes);
    values.forEach((value, i) => signed ? data.setInt32(i * 4, value) : data.setUint32(i * 4, value));
    return bytes;
  }

  function bigInteger(value) {
    const bytes = new Uint8Array(8);
    view(bytes).setBigUint64(0, BigInt(value));
    return bytes;
  }

  function header(type, size) {
    const bytes = new Uint8Array(size > 0xffffffff ? 16 : 8);
    const data = view(bytes);
    data.setUint32(0, bytes.length === 16 ? 1 : size);
    for (let i = 0; i < 4; i++) bytes[4 + i] = type.charCodeAt(i);
    if (bytes.length === 16) data.setBigUint64(8, BigInt(size + 8));
    return bytes;
  }

  function makeBox(type, ...parts) {
    const size = 8 + parts.reduce((sum, part) => sum + part.length, 0);
    const bytes = new Uint8Array(size);
    bytes.set(header(type, size));
    let cursor = 8;
    for (const part of parts) {
      bytes.set(part, cursor);
      cursor += part.length;
    }
    return bytes;
  }

  function runs(values, signed = false) {
    const pairs = [];
    let previous;
    for (const value of values) {
      if (value === previous) pairs[pairs.length - 2]++;
      else pairs.push(1, value);
      previous = value;
    }
    return [integers([signed ? 0x01000000 : 0, pairs.length / 2]), integers(pairs, signed)];
  }

  function patchClock(box, duration, trackId = null) {
    const body = box.body.slice();
    const { data, version, field, duration: offset } = clock({ body }, trackId !== null);
    if (trackId !== null) data.setUint32(field, trackId);
    if (version) data.setBigUint64(offset, BigInt(duration));
    else {
      requireValid(duration <= 0xffffffff);
      data.setUint32(offset, duration);
    }
    return makeBox(box.type, body);
  }

  function trimTrackTail(track, inPoint, outPoint, video) {
    let count = 0;
    let bytes = 0;
    let keptBytes = 0;
    let dts = track.decodeStart;
    for (let i = 0; i < track.sizes.length; i++) {
      const pts = dts + track.compositionOffsets[i];
      bytes += track.sizes[i];
      if (pts < outPoint && pts + track.durations[i] > inPoint) {
        count = i + 1;
        keptBytes = bytes;
      }
      dts += track.durations[i];
    }
    requireValid(count > 0);
    track.sizes.length = count;
    track.durations.length = count;
    track.compositionOffsets.length = count;
    track.keyframes = track.keyframes.filter((index) => index <= count);
    dts = track.decodeStart;
    for (let i = 0; i < count; i++) {
      const pts = dts + track.compositionOffsets[i];
      if (video && pts >= outPoint) {
        // A B-frame near the end may still need a reference frame whose
        // presentation time is outside the clip. Decode it within the preroll.
        track.compositionOffsets[i] = inPoint - track.durations[i] - dts;
      } else if (video && pts < inPoint && pts + track.durations[i] > inPoint) {
        track.compositionOffsets[i] = inPoint - dts;
      }
      if (i === count - 1) {
        // The last retained sample overlaps the edit in presentation order.
        // With a signed composition offset its DTS can be past the edit end.
        track.durations[i] = Math.min(track.durations[i], outPoint - pts);
      }
      dts += track.durations[i];
    }
    let remaining = keptBytes;
    const payload = [];
    for (const part of track.payload) {
      if (!remaining) break;
      const size = Math.min(remaining, part.size);
      payload.push(size === part.size ? part : part.slice(0, size));
      remaining -= size;
    }
    requireValid(remaining === 0);
    track.payload = payload;
    track.payloadBytes = keptBytes;
  }

  function prepareTrack(track, start, end, video) {
    const mdhd = child(track.mdia, 'mdhd');
    const { data, field } = clock(mdhd);
    const scale = data.getUint32(field);
    requireValid(scale > 0);
    const inPoint = Math.round(start * scale) + track.edit;
    const outPoint = Math.round(end * scale) + track.edit;
    // The final audio sample can end slightly before the video's nominal end.
    const tailTolerance = video ? track.sampleTolerance : Math.max(track.sampleTolerance, Math.ceil(scale * 0.05));
    requireValid(inPoint >= track.minPts - 1 && outPoint <= track.maxPts + tailTolerance &&
      inPoint < track.maxPts && inPoint >= track.decodeStart && outPoint > inPoint);
    trimTrackTail(track, inPoint, outPoint, video);
    return { ...track, mdhd, mediaTime: inPoint - track.decodeStart, mediaDuration: outPoint - track.decodeStart };
  }

  function writeTrack(track, trackId, duration, offset) {
    const edit = makeBox('elst', integers([0x01000000, 1]), bigInteger(duration), bigInteger(track.mediaTime), integers([0x10000]));

    const minf = child(track.mdia, 'minf');
    const stsd = child(child(minf, 'stbl'), 'stsd');
    requireValid(view(stsd.body).getUint32(4) === 1);
    const entries = boxes(stsd.body.subarray(8));
    requireValid(entries.length === 1 && !['encv', 'enca'].includes(entries[0].type));
    const table = [
      stsd.bytes, makeBox('stts', ...runs(track.durations)),
      makeBox('stsc', integers([0, 1, 1, track.sizes.length, 1])),
      makeBox('stsz', integers([0, 0, track.sizes.length]), integers(track.sizes)),
      makeBox('co64', integers([0, 1]), bigInteger(offset))
    ];
    if (track.compositionOffsets.some(Boolean)) {
      table.push(makeBox('ctts', ...runs(track.compositionOffsets, track.compositionOffsets.some((value) => value < 0))));
    }
    if (track.keyframes.length) table.push(makeBox('stss', integers([0, track.keyframes.length]), integers(track.keyframes)));
    const media = makeBox('mdia',
      patchClock(track.mdhd, track.mediaDuration),
      child(track.mdia, 'hdlr').bytes,
      makeBox('minf', ...boxes(minf.body).filter((box) => box.type !== 'stbl').map((box) => box.bytes), makeBox('stbl', ...table)));
    return makeBox('trak', patchClock(child(track.trak, 'tkhd'), duration, trackId), makeBox('edts', edit), media);
  }

  async function muxChapter(videoBlob, audioBlob, chapter, options = {}) {
    const { start, end } = chapter;
    requireValid(Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start);
    const video = prepareTrack(await readSampleTrack(videoBlob, true, options), start, end, true);
    const audio = prepareTrack(await readSampleTrack(audioBlob, false, options), start, end, false);
    const mvhd = child(video.moov, 'mvhd');
    const { data, field } = clock(mvhd);
    const duration = Math.round((end - start) * data.getUint32(field));
    requireValid(duration > 0);
    const movieHeader = patchClock(mvhd, duration);
    view(movieHeader).setUint32(movieHeader.length - 4, 3);
    const ftyp = makeBox('ftyp', Uint8Array.from('isom\0\0\x02\0isomiso2mp41', (char) => char.charCodeAt(0)));
    const mdat = header('mdat', 8 + video.payloadBytes + audio.payloadBytes);
    // Place moov after mdat so chunk offsets do not depend on the size of sample tables.
    const videoStart = ftyp.length + mdat.length;
    const moov = makeBox('moov', movieHeader,
      writeTrack(video, 1, duration, videoStart),
      writeTrack(audio, 2, duration, videoStart + video.payloadBytes));
    return new Blob([ftyp, mdat, ...video.payload, ...audio.payload, moov], { type: 'video/mp4' });
  }

  root.BiliChapterMp4 = { chapterRange, muxChapter };
})(globalThis);
