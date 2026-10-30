'use strict';
// Hoster Radio — HTTP layer.
//   guest  → /radio/*       (behind the PIN like every share route): state, add a song, report a duration
//   admin  → /api/radio/*   (owner only — the loopback guard in server.js already refuses everyone else)
const express = require('express');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const auth = require('../utils/auth');
const { collectMedia, isMediaName } = require('../utils/media');
const { resolveSafePath } = require('../utils/paths');
const { probe } = require('../utils/duration');

const MAX_GUEST_FOLDER = 100; // songs a guest can add from one folder
const station = () => global.serverState.radio;

// ── background metadata lookup ─────────────────────────────────────────────────────────────
// Adding songs must feel instant, so entries go in with the file name as title and no duration; durations
// and tags are filled in a few at a time, in queue order (the song that plays first is probed first).
const probeQueue = [];
const probeFailed = new Set(); // ids whose duration could not be read from the file itself
let probing = false;

function enqueueProbes(items) {
  probeQueue.push(...items);
  if (!probing) runProbes();
}

async function runProbes() {
  probing = true;
  try {
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (probeQueue.length) {
        const it = probeQueue.shift();
        const r = await probe(it.full, it.mime);
        const radio = station();
        if (!radio) continue;
        if (r.durationMs) radio.setDuration(it.id, r.durationMs);
        else probeFailed.add(it.id);
        if (r.title) radio.setTitle(it.id, r.artist ? `${r.artist} – ${r.title}` : r.title);
      }
    }));
  } finally {
    probing = false;
    if (probeQueue.length) runProbes();
  }
}

function resetProbes() { probeQueue.length = 0; probeFailed.clear(); }

// ── helpers ────────────────────────────────────────────────────────────────────────────────
function streamPath(rel) {
  const s = global.serverState;
  const tok = s.pinEnabled && s.pin ? `&t=${auth.signToken('media', auth.MEDIA_TTL, auth.normPath(rel))}` : '';
  return `/files/stream?path=${encodeURIComponent(rel)}${tok}`;
}

function publicSnapshot() {
  const snap = station().snapshot();
  if (snap.track) {
    snap.track.stream = streamPath(snap.track.path); // short-lived token instead of the PIN
    delete snap.track.path;
  }
  return snap;
}

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

/** Resolve `rel` (a file or a folder in the share) into queue entries and add them. */
function addFromPath({ rel, recursive, next, limit }) {
  const base = global.serverState.sharedDir;
  const target = resolveSafePath(base, rel);
  if (!target || !fs.existsSync(target)) throw new HttpError(404, 'Not found');
  const norm = auth.normPath(rel);

  let entries = [];
  if (fs.statSync(target).isDirectory()) {
    collectMedia(target, norm, !!recursive, 0, entries, limit);
  } else if (isMediaName(path.basename(target))) {
    entries = [{ rel: norm, title: path.basename(target).replace(/\.[^.]+$/, '') }];
  } else {
    throw new HttpError(415, 'Only audio and video files can go on the radio');
  }
  if (!entries.length) throw new HttpError(404, 'No audio or video files here');

  const added = station().add(entries.map(e => ({ path: e.rel, title: e.title })), { next: !!next, autoplay: true });
  if (!added.length) throw new HttpError(409, 'The queue is full');
  enqueueProbes(added.map(a => ({ id: a.id, full: resolveSafePath(base, a.path), mime: mime.lookup(a.path) })));
  return added.length;
}

const wrap = fn => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    console.error('radio error:', e);
    res.status(500).json({ error: 'Radio error' });
  }
};

// ── guest routes ───────────────────────────────────────────────────────────────────────────
const guest = express.Router();

guest.use((req, res, next) => {
  if (!global.serverState.running) return res.status(503).json({ error: 'Not sharing' });
  res.set('Cache-Control', 'no-store');
  next();
});

guest.get('/state', (req, res) => res.json(publicSnapshot()));

guest.post('/add', wrap(async (req, res) => {
  const owner = auth.isLoopback(auth.ipOf(req));
  if (!owner && !station().allowGuestAdd) throw new HttpError(403, 'The host has not allowed guests to add songs');
  const rel = req.body && req.body.path;
  if (typeof rel !== 'string') throw new HttpError(400, 'path is required');
  const added = addFromPath({ rel, recursive: false, next: !!(req.body && req.body.next), limit: owner ? 2000 : MAX_GUEST_FOLDER });
  res.json({ added });
}));

// Only for files whose length the server could not read itself. First report wins, and it must be plausible
// for the file's size, so a guest can't make the station skip songs by lying.
guest.post('/duration', wrap(async (req, res) => {
  const id = Number(req.body && req.body.id);
  const sec = Number(req.body && req.body.seconds);
  const t = Number.isInteger(id) ? station().find(id) : null;
  if (!t || t.durationMs != null || !probeFailed.has(id) || !Number.isFinite(sec) || sec < 1 || sec > 86400) {
    return res.json({ accepted: false });
  }
  const full = resolveSafePath(global.serverState.sharedDir, t.path);
  let size = 0;
  try { size = fs.statSync(full).size; } catch (e) { return res.json({ accepted: false }); }
  const bitsPerSec = (size * 8) / sec;
  if (bitsPerSec < 8000 || bitsPerSec > 200e6) return res.json({ accepted: false });
  res.json({ accepted: station().setDuration(id, sec * 1000) });
}));

// ── owner routes ───────────────────────────────────────────────────────────────────────────
const admin = express.Router();
const reply = (res, ok) => res.json({ ok: !!ok, state: publicSnapshot() });

admin.get('/', (req, res) => res.json(publicSnapshot()));

admin.post('/enqueue', wrap(async (req, res) => {
  const b = req.body || {};
  if (typeof b.path !== 'string') throw new HttpError(400, 'path is required');
  if (b.replace) { station().clear(); resetProbes(); }
  const added = addFromPath({ rel: b.path, recursive: b.recursive !== false, next: !!b.next, limit: 2000 });
  res.json({ ok: true, added, state: publicSnapshot() });
}));

admin.post('/play', (req, res) => reply(res, station().play(req.body && req.body.id !== undefined ? Number(req.body.id) : undefined)));
admin.post('/pause', (req, res) => reply(res, station().pause()));
admin.post('/resume', (req, res) => reply(res, station().resume()));
admin.post('/next', (req, res) => reply(res, station().next()));
admin.post('/prev', (req, res) => reply(res, station().prev()));
admin.post('/seek', (req, res) => reply(res, station().seek(Number(req.body && req.body.ms))));
admin.post('/remove', (req, res) => reply(res, station().remove(Number(req.body && req.body.id))));
admin.post('/clear', (req, res) => { resetProbes(); reply(res, station().clear()); });
admin.post('/settings', (req, res) => {
  const b = req.body || {};
  let ok = true;
  if (b.shuffle !== undefined) ok = station().setShuffle(!!b.shuffle) && ok;
  if (b.repeat !== undefined) ok = station().setRepeat(b.repeat) && ok;
  if (b.allowGuestAdd !== undefined) ok = station().setAllowGuestAdd(!!b.allowGuestAdd) && ok;
  reply(res, ok);
});

module.exports = { guest, admin, resetProbes };
