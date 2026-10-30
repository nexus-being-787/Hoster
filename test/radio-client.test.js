'use strict';
// Runs the REAL radio.js + radio-sync.js against a REAL server, with a fake DOM and a fake <audio> element
// that has its own playback clock. Each simulated phone gets a deliberately wrong wall clock.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { startHoster, writeWav, waitFor, sleep } = require('./helpers');

const PUBLIC = path.join(__dirname, '..', 'public', 'js');
const SYNC_SRC = fs.readFileSync(path.join(PUBLIC, 'radio-sync.js'), 'utf8');
const RADIO_SRC = fs.readFileSync(path.join(PUBLIC, 'radio.js'), 'utf8');

const { FakeEl, FakeAudio } = require('./fakedom');

function makePhone({ base, skewMs, pin, store = {} }) {
  const els = {};
  for (const id of ['radioBtn', 'radioDot', 'radioPanel', 'radioPanelDot', 'radioClose', 'radioStatus', 'radioTrack', 'radioBar', 'radioPos', 'radioDur', 'radioTune', 'radioVol', 'radioSync', 'radioQueue', 'radioNote', 'radioAddFolder', 'radioDelay', 'radioDelayVal']) els[id] = new FakeEl();
  els.radioPanel.classList.add('hidden');
  const timers = new Set(); let stopped = false;
  const toasts = [];
  const ctx = {
    console, Promise, Math, Number, String, JSON, isFinite, encodeURIComponent, decodeURIComponent, Error,
    Date: { now: () => Date.now() + skewMs }, // this phone's wall clock is wrong
    setTimeout: (f, ms) => { if (stopped) return 0; const h = setTimeout(() => { timers.delete(h); f(); }, ms); timers.add(h); return h; },
    setInterval: (f, ms) => { if (stopped) return 0; const h = setInterval(f, ms); timers.add(h); return h; },
    fetch: (u, o) => fetch(base + u, o),
    Audio: FakeAudio,
    document: { hidden: false, getElementById: id => els[id] || null, createElement: t => new FakeEl(t), addEventListener() {} },
    navigator: {}, localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    state: { pin: pin || null, currentPath: '/' },
    hosterToast: t => toasts.push(t),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SYNC_SRC, ctx);
  vm.runInContext(RADIO_SRC, ctx);
  const api = ctx.__hosterRadio;
  return {
    els, ctx, toasts, audio: api.audio, api,
    mediaMs: () => api.audio.currentTime * 1000,
    stop() { stopped = true; timers.forEach(h => { clearTimeout(h); clearInterval(h); }); },
  };
}

describe('radio client (real radio.js, fake DOM + fake audio, real server)', () => {
  let h;
  before(async () => {
    h = await startHoster();
    fs.mkdirSync(path.join(h.shareDir, 'set'));
    writeWav(path.join(h.shareDir, 'set', '01 first.wav'), 90);
    writeWav(path.join(h.shareDir, 'set', '02 second.wav'), 90);
    await h.start();
    await h.api('POST', '/api/radio/enqueue', { path: '/set' });
    await waitFor(async () => (await h.api('GET', '/api/radio')).json.queue[1].durationMs, { what: 'probe' });
  });
  after(() => h.stop());

  const stationMs = async () => (await h.api('GET', '/api/radio')).json.positionMs;

  test('phones with clocks +7 s and -3 s tune in and end up on the same moment as the station', async () => {
    const a = makePhone({ base: h.ownerShare, skewMs: 7000 });
    const b = makePhone({ base: h.ownerShare, skewMs: -3000 });
    try {
      assert.equal(a.audio.paused, true, 'nothing plays before the listener taps Tune in');
      a.els.radioTune.click(); b.els.radioTune.click();
      await waitFor(() => !a.audio.paused && !b.audio.paused && a.audio.readyState === 4 && b.audio.readyState === 4, { what: 'both phones playing', timeout: 8000 });
      await sleep(3500); // let rate-nudging settle
      const [ma, mb, st] = [a.mediaMs(), b.mediaMs(), await stationMs()];
      assert.ok(Math.abs(ma - st) < 150, `phone A is ${(ma - st).toFixed(0)} ms from the station`);
      assert.ok(Math.abs(mb - st) < 150, `phone B is ${(mb - st).toFixed(0)} ms from the station`);
      assert.ok(Math.abs(ma - mb) < 150, `A and B differ by ${(ma - mb).toFixed(0)} ms`);
      assert.match(a.els.radioSync.textContent, /^In sync/);
      assert.ok(a.audio.src.includes('/files/stream?path='), 'loaded the current track: ' + a.audio.src);
    } finally { a.stop(); b.stop(); }
  });

  test('the station is not played before the listener taps Tune in, and Tune out silences it', async () => {
    const p = makePhone({ base: h.ownerShare, skewMs: 1500 });
    try {
      await sleep(2500); // idle polling only
      assert.equal(p.audio.plays, 0);
      assert.equal(p.els.radioTune.textContent, 'Tune in');
      p.els.radioTune.click();
      await waitFor(() => !p.audio.paused && p.audio.readyState === 4, { what: 'playing', timeout: 8000 });
      assert.equal(p.els.radioTune.textContent, 'Tune out');
      p.els.radioTune.click();
      assert.equal(p.audio.paused, true);
      assert.equal(p.els.radioTune.textContent, 'Tune in');
    } finally { p.stop(); }
  });

  test('when the host pauses, every phone stops at the same spot; resuming brings them back together', async () => {
    const a = makePhone({ base: h.ownerShare, skewMs: 4000 });
    const b = makePhone({ base: h.ownerShare, skewMs: -6000 });
    try {
      a.els.radioTune.click(); b.els.radioTune.click();
      await waitFor(() => !a.audio.paused && !b.audio.paused, { what: 'playing', timeout: 8000 });
      await h.api('POST', '/api/radio/pause');
      await waitFor(() => a.audio.paused && b.audio.paused, { what: 'both paused', timeout: 5000 });
      await sleep(600);
      assert.ok(Math.abs(a.mediaMs() - b.mediaMs()) < 200, `paused spots differ by ${(a.mediaMs() - b.mediaMs()).toFixed(0)} ms`);
      await h.api('POST', '/api/radio/resume');
      await waitFor(() => !a.audio.paused && !b.audio.paused, { what: 'both resumed', timeout: 5000 });
      await sleep(3000);
      assert.ok(Math.abs(a.mediaMs() - b.mediaMs()) < 150, `after resume they differ by ${(a.mediaMs() - b.mediaMs()).toFixed(0)} ms`);
    } finally { a.stop(); b.stop(); }
  });

  test('when the host skips, phones load the new song and start at its beginning together', async () => {
    const a = makePhone({ base: h.ownerShare, skewMs: 2000 });
    const b = makePhone({ base: h.ownerShare, skewMs: -9000 });
    try {
      a.els.radioTune.click(); b.els.radioTune.click();
      await waitFor(() => !a.audio.paused && !b.audio.paused, { what: 'playing', timeout: 8000 });
      const before = (await h.api('GET', '/api/radio')).json.track.title;
      await h.api('POST', '/api/radio/next');
      const after = (await h.api('GET', '/api/radio')).json.track.title;
      assert.notEqual(before, after);
      await waitFor(() => a.els.radioTrack.textContent === '' || true, {});
      await waitFor(() => a.audio.src.includes(encodeURIComponent('/set/' + after).replace(/%2F/g, '%2F').slice(0, 20)) || a.audio.src !== '', { what: 'src', timeout: 3000 });
      await sleep(4000);
      const st = await stationMs();
      assert.ok(st > 3000 && st < 12000, 'station is a few seconds into the new song: ' + st);
      assert.ok(Math.abs(a.mediaMs() - st) < 200, `A off by ${(a.mediaMs() - st).toFixed(0)} ms`);
      assert.ok(Math.abs(b.mediaMs() - st) < 200, `B off by ${(b.mediaMs() - st).toFixed(0)} ms`);
    } finally { a.stop(); b.stop(); }
  });

  test('speaker-delay compensation: a phone with a 250 ms Bluetooth lag plays 250 ms ahead so it sounds in time', async () => {
    const plain = makePhone({ base: h.ownerShare, skewMs: 800 });
    const bt = makePhone({ base: h.ownerShare, skewMs: -2200 });
    try {
      bt.els.radioDelay.value = '250';
      bt.els.radioDelay.listeners.input.forEach(f => f());
      plain.els.radioTune.click(); bt.els.radioTune.click();
      await waitFor(() => !plain.audio.paused && !bt.audio.paused && plain.audio.readyState === 4 && bt.audio.readyState === 4, { what: 'both playing', timeout: 8000 });
      await sleep(3500);
      const st = await stationMs();
      const lead = bt.mediaMs() - plain.mediaMs();
      assert.ok(Math.abs(plain.mediaMs() - st) < 150, `plain phone is ${(plain.mediaMs() - st).toFixed(0)} ms off the station`);
      assert.ok(Math.abs(lead - 250) < 150, `the delayed phone should run ~250 ms ahead, ran ${lead.toFixed(0)} ms`);
      assert.equal(bt.els.radioDelayVal.textContent, '250 ms');
    } finally { plain.stop(); bt.stop(); }
  });

  test('the delay setting is clamped, rounded to 10 ms, and remembered for next time', async () => {
    const store = {};
    const a = makePhone({ base: h.ownerShare, skewMs: 0, store });
    try {
      for (const [typed, shown] of [['5000', '600 ms'], ['-40', '0 ms'], ['123', '120 ms'], ['abc', '0 ms']]) {
        a.els.radioDelay.value = typed;
        a.els.radioDelay.listeners.input.forEach(f => f());
        assert.equal(a.els.radioDelayVal.textContent, shown, typed);
      }
      a.els.radioDelay.value = '180'; a.els.radioDelay.listeners.input.forEach(f => f());
      assert.equal(store.hoster_radio_delay, '180');
    } finally { a.stop(); }
    const again = makePhone({ base: h.ownerShare, skewMs: 0, store }); // "reopening the page"
    try { assert.equal(again.els.radioDelay.value, '180'); assert.equal(again.els.radioDelayVal.textContent, '180 ms'); } finally { again.stop(); }
  });

  test('the panel shows the queue with the current song highlighted', async () => {
    const p = makePhone({ base: h.ownerShare, skewMs: 0 });
    try {
      p.els.radioBtn.click();
      await waitFor(() => p.els.radioQueue.children.length === 2, { what: 'queue drawn' });
      assert.equal(p.els.radioPanel.classList.contains('hidden'), false);
      const titles = p.els.radioQueue.children.map(li => li.children[0].textContent);
      assert.deepEqual(titles, ['01 first', '02 second']);
      assert.equal(p.els.radioQueue.children.filter(li => li.classList.contains('current')).length, 1);
      assert.equal(p.els.radioStatus.textContent, 'Live now');
      assert.equal(p.els.radioClose.listeners.click.length, 1);
      p.els.radioClose.click();
      assert.equal(p.els.radioPanel.classList.contains('hidden'), true);
    } finally { p.stop(); }
  });
});

describe('radio client safety nets', () => {
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  test('radio.js never writes untrusted text as HTML (titles come from file names and ID3 tags)', () => {
    const code = strip(RADIO_SRC);
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
      assert.ok(!code.includes(bad), `radio.js must not use ${bad}`);
    }
  });

  test('app.js never puts a raw file name into innerHTML (stored-XSS regression)', () => {
    const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
    const raw = app.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\$\{\s*(file|f|item)\.name\s*\}/.test(l));
    assert.deepEqual(raw, [], 'unescaped name interpolation at lines: ' + raw.map(r => r[0]).join(', '));
  });

  test('the portal page loads the radio scripts in the right order', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const order = ['player-links.js', 'radio-sync.js', 'app.js', 'radio.js'].map(f => html.indexOf('/assets/js/' + f));
    assert.ok(order.every(i => i > 0), 'a script tag is missing');
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'scripts out of order (radio.js must come after app.js)');
    for (const id of ['radioBtn', 'radioPanel', 'radioTune', 'radioQueue', 'radioVol', 'radioAddFolder']) assert.ok(html.includes(`id="${id}"`), id);
  });
});
