'use strict';
// Runs the REAL Host UI radio section (src/host-ui/host.js) against a REAL server with a fake DOM.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { startHoster, writeWav, waitFor } = require('./helpers');
const { FakeEl } = require('./fakedom');

const HOST_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'host-ui', 'host.js'), 'utf8');
const MARKER = HOST_JS.indexOf('// Hoster Radio (owner controls)');
const SECTION = HOST_JS.slice(HOST_JS.lastIndexOf('// ─', MARKER)); // from the section's banner comment to the end of the file

function makeHostUi(base) {
  const els = {};
  const $ = id => (els[id] = els[id] || new FakeEl());
  const timers = [];
  const toasts = [];
  const ctx = {
    console, Promise, Math, Number, String, JSON, Array, encodeURIComponent,
    $, API: '', serverRunning: true,
    document: { createElement: t => new FakeEl(t) },
    fetch: (u, o) => fetch(base + u, o),
    showToast: (m, type) => toasts.push([m, type]),
    setInterval: (f, ms) => { const h = setInterval(f, ms); timers.push(h); return h; },
  };
  vm.createContext(ctx);
  vm.runInContext(SECTION, ctx);
  return { els, ctx, toasts, stop: () => timers.forEach(clearInterval), refresh: () => vm.runInContext('refreshRadio()', ctx) };
}

describe('Host UI radio card (real host.js, fake DOM, real server)', () => {
  let h, ui;
  before(async () => {
    h = await startHoster();
    // the helper's default share has other media (song.flac, album/…); keep only this test's songs
    fs.rmSync(path.join(h.shareDir, 'song.flac'));
    fs.rmSync(path.join(h.shareDir, 'album'), { recursive: true });
    fs.mkdirSync(path.join(h.shareDir, 'mix'));
    writeWav(path.join(h.shareDir, 'mix', '01 intro.wav'), 60);
    writeWav(path.join(h.shareDir, 'mix', '02 <img src=x onerror=alert(1)> & "q".wav'), 60);
    writeWav(path.join(h.shareDir, 'mix', '03 outro.wav'), 60);
    await h.start();
    ui = makeHostUi(h.hostBase);
  });
  after(() => { ui.stop(); return h.stop(); });

  const stateNow = async () => (await h.api('GET', '/api/radio')).json;
  const queueTitles = () => ui.els.hRadioQueue.children.map(li => (li.children[0] ? li.children[0].textContent : li.textContent));

  test('an empty station says so', async () => {
    await ui.refresh();
    assert.equal(ui.els.hRadioTrack.textContent, 'Nothing playing');
    assert.deepEqual(queueTitles(), ['The queue is empty']);
    assert.equal(ui.els.hRadioLive.classList.contains('hidden'), true);
  });

  test('"Queue shared folder" fills the queue, starts the station, and shows LIVE', async () => {
    ui.els.hRadioQueueAll.click();
    await waitFor(() => queueTitles().length === 3, { what: 'queue rendered' });
    assert.equal((await stateNow()).queue.length, 3);
    assert.equal(ui.els.hRadioLive.classList.contains('hidden'), false);
    assert.equal(ui.els.hRadioTrack.textContent, '01 intro');
    assert.equal(ui.els.hRadioPlay.textContent, '\u23F8');
    assert.ok(ui.toasts.some(([m]) => /Queued 3 songs/.test(m)), JSON.stringify(ui.toasts));
  });

  test('file names with HTML in them are shown as plain text', () => {
    assert.ok(queueTitles().includes('02 <img src=x onerror=alert(1)> & "q"'), queueTitles().join(' | '));
  });

  test('play/pause, next, prev drive the real station', async () => {
    ui.els.hRadioPlay.click();
    await waitFor(async () => (await stateNow()).status === 'paused', { what: 'paused' });
    await ui.refresh();
    assert.equal(ui.els.hRadioPlay.textContent, '\u25B6');
    assert.equal(ui.els.hRadioLive.classList.contains('hidden'), true);
    ui.els.hRadioPlay.click();
    await waitFor(async () => (await stateNow()).status === 'playing', { what: 'resumed' });
    ui.els.hRadioNext.click();
    await waitFor(async () => (await stateNow()).track.title.startsWith('02'), { what: 'next' });
    ui.els.hRadioPrev.click();
    await waitFor(async () => (await stateNow()).track.title === '01 intro', { what: 'prev' });
  });

  test('shuffle, repeat (off → all → one → off) and the guests switch', async () => {
    ui.els.hRadioShuffle.click();
    await waitFor(async () => (await stateNow()).shuffle === true, { what: 'shuffle' });
    await ui.refresh(); assert.equal(ui.els.hRadioShuffle.classList.contains('on'), true);

    for (const want of ['all', 'one', 'off']) {
      ui.els.hRadioRepeat.click();
      await waitFor(async () => (await stateNow()).repeat === want, { what: 'repeat ' + want });
      await ui.refresh();
    }
    assert.equal(ui.els.hRadioRepeat.classList.contains('on'), false);

    ui.els.hRadioGuests.checked = true;
    ui.els.hRadioGuests.listeners.change.forEach(f => f());
    await waitFor(async () => (await stateNow()).allowGuestAdd === true, { what: 'guest switch' });
  });

  test('clicking a song plays it; × removes it; Clear empties the station', async () => {
    await ui.refresh();
    ui.els.hRadioQueue.children[2].listeners.click[0]();
    await waitFor(async () => (await stateNow()).track.title === '03 outro', { what: 'play by click' });

    const rm = ui.els.hRadioQueue.children[0].children[2];
    rm.listeners.click[0]({ stopPropagation() {} });
    await waitFor(async () => (await stateNow()).queue.length === 2, { what: 'removed' });
    assert.equal((await stateNow()).track.title, '03 outro', 'removing another song does not interrupt the current one');

    ui.els.hRadioClear.click();
    await waitFor(async () => (await stateNow()).queue.length === 0, { what: 'cleared' });
    await ui.refresh();
    assert.deepEqual(queueTitles(), ['The queue is empty']);
  });

  test('errors from the server surface as a toast instead of failing silently', async () => {
    await vm.runInContext("radioCall('/enqueue', { path: '/does-not-exist' })", ui.ctx);
    assert.ok(ui.toasts.some(([m, t]) => t === 'error' && /Not found/.test(m)), JSON.stringify(ui.toasts.slice(-2)));
  });

  test('host.js radio section writes song titles with textContent only', () => {
    const code = SECTION.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(code), 'no HTML injection APIs in the radio section');
  });
});
