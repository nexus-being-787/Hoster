'use strict';
// Tiny stand-ins for the browser pieces the front-end scripts touch, so they can run for real under Node.

class FakeEl {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this._cls = new Set(); this.style = {}; this.dataset = {}; this.listeners = {}; this.textContent = ''; this.value = '1'; this.disabled = false; }
  get className() { return [...this._cls].join(' '); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() {
    const self = this;
    return { add: c => self._cls.add(c), remove: c => self._cls.delete(c), contains: c => self._cls.has(c), toggle(c, on) { (on === undefined ? !self._cls.has(c) : on) ? self._cls.add(c) : self._cls.delete(c); } };
  }
  get firstChild() { return this.children[0] || null; }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); return c; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  click() { (this.listeners.click || []).forEach(f => f({ target: this })); }
}

/** Plays like a browser <audio>: media time advances with REAL time × playbackRate, independent of the phone's wall clock. */
class FakeAudio {
  constructor() { this._ms = 0; this._at = Date.now(); this.paused = true; this.playbackRate = 1; this.volume = 1; this.readyState = 0; this.duration = NaN; this._src = ''; this._l = {}; this.plays = 0; this.seeks = 0; }
  _tick() { if (!this.paused) this._ms += (Date.now() - this._at) * this.playbackRate; this._at = Date.now(); }
  get currentTime() { this._tick(); return this._ms / 1000; }
  set currentTime(v) { this._tick(); this._ms = v * 1000; this.seeks++; }
  get src() { return this._src; }
  set src(v) {
    this._tick(); this._src = v; this._ms = 0; this.paused = true; this.readyState = 0;
    if (!v || v.startsWith('data:')) return; // the silent "unlock" clip never becomes a real track
    setTimeout(() => { this.readyState = 4; this.duration = 90; (this._l.loadedmetadata || []).forEach(f => f()); }, 40); // fetch + decode latency
  }
  addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); }
  removeAttribute() { this._src = ''; this.readyState = 0; }
  load() {}
  play() { this._tick(); this.paused = false; this.plays++; return Promise.resolve(); }
  pause() { this._tick(); this.paused = true; }
}

module.exports = { FakeEl, FakeAudio };
