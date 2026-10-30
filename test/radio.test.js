'use strict';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Radio, MAX_QUEUE } = require('../src/utils/radio');

const S = 1000;
const song = (n, dur) => ({ path: `/m/${n}.mp3`, title: n, durationMs: dur });

describe('Radio station', () => {
  let t, r;
  const mk = (opts = {}) => new Radio({ now: () => t, rng: opts.rng || (() => 0), ...opts });
  beforeEach(() => { t = 1_000_000; r = mk(); });

  test('starts stopped and empty', () => {
    const s = r.snapshot();
    assert.equal(s.status, 'stopped');
    assert.equal(s.track, null);
    assert.equal(s.positionMs, 0);
    assert.deepEqual(s.queue, []);
  });

  test('play() starts the first track and position follows the clock', () => {
    r.add([song('a', 200 * S), song('b', 100 * S)]);
    assert.equal(r.play(), true);
    t += 12_345;
    const s = r.snapshot();
    assert.equal(s.status, 'playing');
    assert.equal(s.track.title, 'a');
    assert.equal(s.positionMs, 12_345);
  });

  test('every listener asking at the same instant gets the same position', () => {
    r.add([song('a', 200 * S)]); r.play();
    t += 7_000;
    assert.equal(r.snapshot().positionMs, r.snapshot().positionMs);
  });

  test('pause freezes the position; resume continues from it', () => {
    r.add([song('a', 200 * S)]); r.play();
    t += 30 * S; r.pause();
    t += 99 * S;
    assert.equal(r.snapshot().positionMs, 30 * S);
    assert.equal(r.snapshot().status, 'paused');
    r.resume(); t += 5 * S;
    assert.equal(r.snapshot().positionMs, 35 * S);
  });

  test('auto-advances at the exact end of a track and chains gaplessly', () => {
    r.add([song('a', 10 * S), song('b', 10 * S)]); r.play();
    t += 10 * S + 1_500; // somebody asks 1.5 s after "a" ended
    const s = r.snapshot();
    assert.equal(s.track.title, 'b');
    assert.equal(s.positionMs, 1_500, 'b started exactly when a ended, not when asked');
  });

  test('a long-overdue station restarts the next track from 0 instead of pretending', () => {
    r.add([song('a', 10 * S), song('b', 100 * S)]); r.play();
    t += 3600 * S; // nobody listened for an hour
    const s = r.snapshot();
    assert.equal(s.track.title, 'b');
    assert.equal(s.positionMs, 0);
  });

  test('reaching the end with repeat off stops the station', () => {
    r.add([song('a', 5 * S)]); r.play();
    t += 6 * S;
    const s = r.snapshot();
    assert.equal(s.status, 'stopped');
    assert.equal(s.track, null);
    assert.equal(s.queue.length, 1, 'the queue is kept');
  });

  test('repeat all wraps around; repeat one replays the same track', () => {
    // a listener polls every couple of seconds, like the real portal does
    const poll = (ms) => { for (let i = 0; i < ms / 2000; i++) { t += 2000; r.snapshot(); } return r.snapshot(); };
    r.add([song('a', 6 * S), song('b', 6 * S)]); r.setRepeat('all'); r.play();
    assert.equal(poll(8000).track.title, 'b');
    assert.equal(poll(6000).track.title, 'a', 'wrapped back to the start');
    r.setRepeat('one');
    assert.equal(poll(6000).track.title, 'a');
    assert.equal(poll(6000).track.title, 'a');
  });

  test('manual next ignores repeat-one, and stops at the end when repeat is off', () => {
    r.add([song('a', 50 * S), song('b', 50 * S)]); r.setRepeat('one'); r.play();
    r.next();
    assert.equal(r.snapshot().track.title, 'b');
    r.setRepeat('off'); r.next();
    assert.equal(r.snapshot().status, 'stopped');
  });

  test('unknown duration: plays on until the duration becomes known, then the boundary is honoured', () => {
    r.add([song('a', null), song('b', 100 * S)]); r.play();
    t += 500 * S;
    assert.equal(r.snapshot().track.title, 'a', 'cannot advance without a duration');
    r.setDuration(r.snapshot().track.id, 180 * S);
    assert.equal(r.snapshot().track.title, 'b', 'now we know a is long over');
  });

  test('duration can only be set once (first report wins)', () => {
    r.add([song('a', null)]);
    const id = r.snapshot().queue[0].id;
    assert.equal(r.setDuration(id, 100 * S), true);
    assert.equal(r.setDuration(id, 1 * S), false);
    assert.equal(r.snapshot().queue[0].durationMs, 100 * S);
    assert.equal(r.setDuration(id, -5), false);
    assert.equal(r.setDuration(999, 5), false);
  });

  test('prev: restarts after 3 s, otherwise goes back through history', () => {
    r.add([song('a', 100 * S), song('b', 100 * S), song('c', 100 * S)]); r.play();
    r.next(); r.next();
    assert.equal(r.snapshot().track.title, 'c');
    t += 10 * S; r.prev();
    assert.equal(r.snapshot().track.title, 'c');
    assert.equal(r.snapshot().positionMs, 0);
    t += 1 * S; r.prev();
    assert.equal(r.snapshot().track.title, 'b');
    t += 1 * S; r.prev();
    assert.equal(r.snapshot().track.title, 'a');
  });

  test('shuffle: every track plays once per cycle, and never the same track twice in a row', () => {
    let seed = 7; const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const r2 = mk({ rng });
    r2.add(['a', 'b', 'c', 'd', 'e', 'f'].map(n => song(n, 10 * S)));
    r2.setShuffle(true); r2.setRepeat('all'); r2.play();
    const order = [r2.snapshot().track.title];
    for (let i = 0; i < 17; i++) { t += 10 * S; order.push(r2.snapshot().track.title); }
    for (let i = 1; i < order.length; i++) assert.notEqual(order[i], order[i - 1], 'immediate repeat: ' + order);
    // The last track of a cycle is carried into the next one (that is what prevents an immediate repeat),
    // so cycles start at 0, 5, 10, … and each window of 6 from there contains every track exactly once.
    for (const start of [0, 5, 10]) {
      assert.equal(new Set(order.slice(start, start + 6)).size, 6, `cycle at ${start}: ${order.join(' ')}`);
    }
  });

  test('play(id) jumps to a track; unknown ids are refused', () => {
    r.add([song('a', 100 * S), song('b', 100 * S)]);
    const [, b] = r.snapshot().queue;
    assert.equal(r.play(b.id), true);
    assert.equal(r.snapshot().track.title, 'b');
    assert.equal(r.play(12345), false);
  });

  test('remove: current track slides the next one in; earlier removal keeps the same song playing', () => {
    r.add([song('a', 100 * S), song('b', 100 * S), song('c', 100 * S)]);
    const ids = r.snapshot().queue.map(q => q.id);
    r.play(ids[1]); t += 20 * S;
    r.remove(ids[0]); // before the current one
    let s = r.snapshot();
    assert.equal(s.track.title, 'b'); assert.equal(s.index, 0); assert.equal(s.positionMs, 20 * S);
    r.remove(ids[1]); // the current one
    s = r.snapshot();
    assert.equal(s.track.title, 'c'); assert.equal(s.positionMs, 0);
    r.remove(ids[2]); // the last one
    assert.equal(r.snapshot().status, 'stopped');
  });

  test('add(next:true) queues right after the current track; autoplay starts an idle station', () => {
    r.add([song('a', 100 * S), song('c', 100 * S)]); r.play();
    r.add([song('b', 100 * S)], { next: true });
    assert.deepEqual(r.snapshot().queue.map(q => q.title), ['a', 'b', 'c']);
    const idle = mk();
    idle.add([song('x', 10 * S)], { autoplay: true });
    assert.equal(idle.snapshot().status, 'playing');
  });

  test(`the queue is capped at ${MAX_QUEUE}`, () => {
    const many = Array.from({ length: MAX_QUEUE + 50 }, (_, i) => song('t' + i, S));
    assert.equal(r.add(many).length, MAX_QUEUE);
    assert.equal(r.add([song('overflow', S)]).length, 0);
  });

  test('bad input is ignored; titles are trimmed', () => {
    assert.deepEqual(r.add([null, {}, { path: 5 }, { path: '' }]), []);
    const [e] = r.add([{ path: '/x/' + 'y'.repeat(500) + '.mp3', title: 'z'.repeat(500) }]);
    assert.equal(e.title.length, 200);
  });

  test('version changes when the station changes — and only then', () => {
    r.add([song('a', 100 * S)]);
    const v0 = r.snapshot().version;
    assert.equal(r.snapshot().version, v0, 'reading never bumps the version');
    r.play(); assert.ok(r.snapshot().version > v0);
    const v1 = r.snapshot().version; t += 5 * S;
    assert.equal(r.snapshot().version, v1, 'time passing alone does not');
    r.pause(); assert.ok(r.snapshot().version > v1);
  });

  test('clear empties the queue but keeps shuffle/repeat and the guest-add setting', () => {
    r.setAllowGuestAdd(true); r.setShuffle(true); r.setRepeat('all');
    r.add([song('a', 100 * S)]); r.play(); r.clear();
    const s = r.snapshot();
    assert.deepEqual([s.status, s.queue.length, s.shuffle, s.repeat, s.allowGuestAdd], ['stopped', 0, true, 'all', true]);
  });

  test('ids are never reused after clear/reset, so late background results cannot hit the wrong track', () => {
    const [a] = r.add([song('a', 100 * S)]);
    r.clear();
    const [b] = r.add([song('b', null)]);
    assert.notEqual(a.id, b.id);
    assert.equal(r.setDuration(a.id, 5 * S), false, 'a stale result for the old id is ignored');
    assert.equal(r.snapshot().queue[0].durationMs, null);
  });

  test('setTitle renames a track once, trimmed, and ignores junk', () => {
    const [a] = r.add([song('file-name', 100 * S)]);
    assert.equal(r.setTitle(a.id, '  Artist – Song  '), true);
    assert.equal(r.snapshot().queue[0].title, 'Artist – Song');
    assert.equal(r.setTitle(a.id, 'Artist – Song'), false, 'unchanged');
    assert.equal(r.setTitle(a.id, '   '), false);
    assert.equal(r.setTitle(999, 'x'), false);
  });

  test('seek moves the playhead for playing and paused stations', () => {
    r.add([song('a', 300 * S)]); r.play(); t += 5 * S;
    r.seek(100 * S); assert.equal(r.snapshot().positionMs, 100 * S);
    r.pause(); r.seek(42 * S); assert.equal(r.snapshot().positionMs, 42 * S);
    assert.equal(r.seek(NaN), false);
  });
});
