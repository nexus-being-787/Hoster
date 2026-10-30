'use strict';
// Reads the length (and title/artist, when present) of an audio/video file from the file itself.
// The server — not a listener's browser — is the authority on how long a song is, otherwise any guest
// could make the radio skip tracks by claiming a bogus duration.
//
// music-metadata is optional at runtime: if it can't load (or a file is unreadable) we return nulls and
// the radio falls back to a listener-reported duration (see routes/radio.js).

let mm = null;
try { mm = require('music-metadata'); } catch (e) { mm = null; }

const PROBE_TIMEOUT_MS = 8000;
const EMPTY = Object.freeze({ durationMs: null, title: null, artist: null });

function withTimeout(promise, ms) {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

/** @returns {Promise<{durationMs:number|null, title:string|null, artist:string|null}>} never rejects */
async function probe(file, mimeType) {
  if (!mm) return { ...EMPTY };
  try {
    const meta = await withTimeout(
      mm.parseFile(file, {
        // MP3 without a VBR header is only estimated unless we scan; a full scan of a song is milliseconds.
        duration: mimeType === 'audio/mpeg',
        skipCovers: true,
        skipPostHeaders: true,
      }),
      PROBE_TIMEOUT_MS,
    );
    const d = meta.format && meta.format.duration;
    const clean = v => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);
    return {
      durationMs: Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : null,
      title: clean(meta.common && meta.common.title),
      artist: clean(meta.common && meta.common.artist),
    };
  } catch (e) {
    return { ...EMPTY };
  }
}

module.exports = { probe, available: () => !!mm };
