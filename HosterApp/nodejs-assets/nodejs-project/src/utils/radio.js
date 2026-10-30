'use strict';
/*
 * Hoster Radio — the station's brain.
 *
 * One shared queue and one shared playback clock. Every listener derives "where are we in the song"
 * from the same two numbers (startedAt / pausedPos) plus the server's clock, so everybody hears the
 * same moment of the same song at the same time.
 *
 * Pure logic: no HTTP, no timers. The clock and RNG are injected, so it is deterministic to test.
 * Track changes are evaluated lazily whenever somebody asks for the state (_sync), so nothing can
 * drift because a timer fired late.
 */

const MAX_QUEUE = 500;
const HISTORY_MAX = 100;
const LATE_JOIN_MS = 5000; // if we notice a track ended up to 5 s ago, chain the next one gaplessly

class Radio {
  constructor({ now = Date.now, rng = Math.random } = {}) {
    this.now = now;
    this.rng = rng;
    this.allowGuestAdd = false; // owner's setting; survives reset()
    this.reset();
  }

  reset() {
    this.queue = []; // { id, path, title, durationMs|null }
    // Ids are never reused, even after reset(): a slow background lookup for an old track must not
    // be able to land on a new track that happens to get the same number.
    this.nextId = this.nextId || 1;
    this.index = -1;
    this.status = 'stopped'; // 'stopped' | 'playing' | 'paused'
    this.startedAt = 0; // server-epoch ms at which position 0 of the current track (virtually) was
    this.pausedPos = 0;
    this.shuffle = false;
    this.repeat = 'off'; // 'off' | 'all' | 'one'
    this.history = []; // ids played before the current one
    this.played = new Set(); // ids already played in this shuffle cycle
    this.version = 0;
  }

  // ── reading ────────────────────────────────────────────────────────────
  current() { return this.index >= 0 ? this.queue[this.index] || null : null; }

  positionMs() {
    if (this.status === 'playing') return Math.max(0, this.now() - this.startedAt);
    if (this.status === 'paused') return this.pausedPos;
    return 0;
  }

  snapshot() {
    this._sync();
    const cur = this.current();
    return {
      version: this.version,
      serverNow: this.now(),
      status: this.status,
      shuffle: this.shuffle,
      repeat: this.repeat,
      allowGuestAdd: this.allowGuestAdd,
      positionMs: this.positionMs(),
      index: this.index,
      track: cur ? { id: cur.id, path: cur.path, title: cur.title, durationMs: cur.durationMs } : null,
      queue: this.queue.map(t => ({ id: t.id, title: t.title, durationMs: t.durationMs })),
    };
  }

  // ── queue ──────────────────────────────────────────────────────────────
  /** @returns the entries that were added (may be fewer than requested if the queue is full) */
  add(items, { next = false, autoplay = false } = {}) {
    this._sync();
    const room = MAX_QUEUE - this.queue.length;
    const entries = [];
    for (const it of items.slice(0, Math.max(0, room))) {
      if (!it || typeof it.path !== 'string' || !it.path) continue;
      entries.push({
        id: this.nextId++,
        path: it.path,
        title: String(it.title || it.path.split('/').pop() || 'Untitled').slice(0, 200),
        durationMs: Number.isFinite(it.durationMs) && it.durationMs > 0 ? Math.round(it.durationMs) : null,
      });
    }
    if (!entries.length) return [];
    const at = next && this.index >= 0 ? this.index + 1 : this.queue.length;
    this.queue.splice(at, 0, ...entries);
    this.version++;
    if (autoplay && this.status === 'stopped') this._start(this.queue.findIndex(t => t.id === entries[0].id), this.now());
    return entries;
  }

  remove(id) {
    this._sync();
    const i = this.queue.findIndex(t => t.id === id);
    if (i < 0) return false;
    const wasCurrent = i === this.index;
    this.queue.splice(i, 1);
    this.history = this.history.filter(h => h !== id);
    this.played.delete(id);
    this.version++;
    if (wasCurrent) {
      if (this.status === 'stopped') { this.index = -1; return true; }
      if (i < this.queue.length) this._start(i, this.now(), false); // the track that slid into this slot
      else this._stop();
    } else if (i < this.index) {
      this.index--;
    }
    return true;
  }

  clear() {
    this._sync();
    const keep = { shuffle: this.shuffle, repeat: this.repeat, version: this.version + 1 };
    this.reset();
    Object.assign(this, keep);
    return true;
  }

  // ── transport ──────────────────────────────────────────────────────────
  /** play(id) starts that track; play() resumes if paused, else starts at the top (or a random track when shuffling). */
  play(id) {
    this._sync();
    if (id !== undefined) {
      const i = this.queue.findIndex(t => t.id === id);
      if (i < 0) return false;
      this._start(i, this.now());
      return true;
    }
    if (this.status === 'paused') return this.resume();
    if (this.status === 'playing') return true;
    if (!this.queue.length) return false;
    const i = this.shuffle ? Math.floor(this.rng() * this.queue.length) : 0;
    this._start(i, this.now());
    return true;
  }

  pause() {
    this._sync();
    if (this.status !== 'playing') return false;
    this.pausedPos = this.positionMs();
    this.status = 'paused';
    this.version++;
    return true;
  }

  resume() {
    this._sync();
    if (this.status !== 'paused') return false;
    this.startedAt = this.now() - this.pausedPos;
    this.status = 'playing';
    this.version++;
    return true;
  }

  next() {
    this._sync();
    if (this.index < 0 || this.status === 'stopped') return false;
    this._gotoNext(false, this.now());
    return true;
  }

  prev() {
    this._sync();
    if (this.index < 0 || this.status === 'stopped') return false;
    if (this.positionMs() > 3000 || !this.history.length) { this._start(this.index, this.now(), false); return true; }
    while (this.history.length) {
      const id = this.history.pop();
      const i = this.queue.findIndex(t => t.id === id);
      if (i >= 0) { this._start(i, this.now(), false); return true; }
    }
    this._start(this.index, this.now(), false);
    return true;
  }

  seek(ms) {
    this._sync();
    if (this.status === 'stopped' || !Number.isFinite(ms)) return false;
    ms = Math.max(0, ms);
    if (this.status === 'playing') this.startedAt = this.now() - ms; else this.pausedPos = ms;
    this.version++;
    return true;
  }

  setShuffle(on) { this.shuffle = !!on; this.played = new Set(this.current() ? [this.current().id] : []); this.version++; return true; }
  setRepeat(mode) {
    if (!['off', 'all', 'one'].includes(mode)) return false;
    this.repeat = mode; this.version++; return true;
  }
  setAllowGuestAdd(on) { this.allowGuestAdd = !!on; this.version++; return true; }

  /** A better title is known (from the file's tags). */
  setTitle(id, title) {
    const t = this.queue.find(x => x.id === id);
    if (!t || typeof title !== 'string' || !title.trim() || t.title === title.trim().slice(0, 200)) return false;
    t.title = title.trim().slice(0, 200);
    this.version++;
    return true;
  }

  /** The queue entry with this id (including its path), or undefined. */
  find(id) { return this.queue.find(x => x.id === id); }

  /** The duration of a track becomes known (parsed from the file, or reported by a listener). */
  setDuration(id, ms) {
    const t = this.queue.find(x => x.id === id);
    if (!t || t.durationMs != null || !Number.isFinite(ms) || ms <= 0) return false;
    t.durationMs = Math.round(ms);
    this.version++;
    this._sync();
    return true;
  }

  // ── internals ──────────────────────────────────────────────────────────
  _start(i, at, recordHistory = true) {
    const prev = this.current();
    if (recordHistory && prev && this.queue[i] && prev.id !== this.queue[i].id) {
      this.history.push(prev.id);
      if (this.history.length > HISTORY_MAX) this.history.shift();
    }
    this.index = i;
    this.status = 'playing';
    this.startedAt = at;
    this.pausedPos = 0;
    this.played.add(this.queue[i].id);
    this.version++;
  }

  _stop() {
    this.status = 'stopped';
    this.index = -1;
    this.startedAt = 0;
    this.pausedPos = 0;
    this.played = new Set();
    this.version++;
  }

  _gotoNext(auto, startAt) {
    const cur = this.current();
    let nextIndex = -1;
    if (auto && this.repeat === 'one') {
      nextIndex = this.index;
    } else if (this.shuffle) {
      let pool = this.queue.filter(t => !this.played.has(t.id) && (!cur || t.id !== cur.id));
      if (!pool.length && this.repeat === 'all') {
        this.played = new Set(cur ? [cur.id] : []);
        pool = this.queue.filter(t => !cur || t.id !== cur.id);
        if (!pool.length && cur) pool = [cur]; // single-track queue
      }
      if (pool.length) nextIndex = this.queue.indexOf(pool[Math.floor(this.rng() * pool.length)]);
    } else if (this.index + 1 < this.queue.length) {
      nextIndex = this.index + 1;
    } else if (this.repeat === 'all' && this.queue.length) {
      nextIndex = 0;
    }
    if (nextIndex < 0) { this._stop(); return; }
    this._start(nextIndex, startAt);
  }

  _due() {
    const cur = this.current();
    return this.status === 'playing' && cur && cur.durationMs != null && this.positionMs() >= cur.durationMs;
  }

  _sync() {
    for (let guard = 0; guard <= this.queue.length && this._due(); guard++) {
      const endAt = this.startedAt + this.current().durationMs;
      const late = this.now() - endAt;
      // Just crossed the boundary → chain gaplessly. Long overdue (nobody asked for ages) → start fresh now.
      this._gotoNext(true, late <= LATE_JOIN_MS ? endAt : this.now());
    }
  }
}

module.exports = { Radio, MAX_QUEUE };
