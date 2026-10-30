'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startHoster, writeWav, sleep } = require('./helpers');
const Sync = require('../public/js/radio-sync.js');

describe('sync math', () => {
  test('clockOffset recovers a known skew from symmetric samples', () => {
    const skew = 4200; // server clock is 4.2 s ahead of ours
    const samples = [20, 35, 18, 50, 22].map((rtt, i) => {
      const t0 = 1000 + i * 500, t1 = t0 + rtt;
      return { t0, t1, serverNow: (t0 + t1) / 2 + skew };
    });
    assert.ok(Math.abs(Sync.clockOffset(samples) - skew) < 1);
  });
  test('clockOffset trusts low-latency samples over a laggy one (a Wi-Fi hiccup does not move the clock)', () => {
    const skew = -1500;
    const good = [10, 12, 11, 13].map((rtt, i) => ({ t0: i * 100, t1: i * 100 + rtt, serverNow: i * 100 + rtt / 2 + skew }));
    // one reply that spent 800 ms stuck on the way back: the server stamped early, we received late
    const laggy = { t0: 500, t1: 1300, serverNow: 500 + 5 + skew };
    assert.ok(Math.abs(Sync.clockOffset([...good, laggy]) - skew) < 5);
  });
  test('clockOffset needs at least one sample', () => {
    assert.equal(Sync.clockOffset([]), null);
    assert.equal(Sync.clockOffset(undefined), null);
    assert.equal(typeof Sync.clockOffset([{ t0: 0, t1: 10, serverNow: 5 }]), 'number');
  });
  test('targetMs advances with the clock while playing and holds while paused', () => {
    const snap = { status: 'playing', positionMs: 10_000, serverNow: 50_000 };
    assert.equal(Sync.targetMs(snap, 1_000, 49_000 + 0), 10_000 + (1_000 + 49_000 - 50_000)); // exactly at serverNow
    assert.equal(Sync.targetMs(snap, 3_000, 49_000), 12_000); // 2 s later
    assert.equal(Sync.targetMs({ ...snap, status: 'paused' }, 99_999, 0), 10_000);
  });
  test('correction: leave it alone, nudge the rate, or seek', () => {
    assert.deepEqual(Sync.correction(10_000, 10_020), { action: 'none', rate: 1 });
    const slow = Sync.correction(10_300, 10_000); // 300 ms ahead → slow down a little
    assert.equal(slow.action, 'rate'); assert.ok(slow.rate < 1 && slow.rate >= 0.95);
    const fast = Sync.correction(10_000, 10_300); // 300 ms behind → speed up a little
    assert.equal(fast.action, 'rate'); assert.ok(fast.rate > 1 && fast.rate <= 1.05);
    assert.deepEqual(Sync.correction(10_000, 12_000), { action: 'seek', rate: 1, seekToMs: 12_000 });
    assert.equal(Sync.correction(5_000, -300).seekToMs, 0, 'never seeks before the start');
  });
  test('rate nudges are inaudible-small and symmetric around 1', () => {
    for (let d = Sync.DEAD_ZONE_MS + 1; d <= Sync.SEEK_THRESHOLD_MS; d += 10) {
      const a = Sync.correction(1000 + d, 1000).rate, b = Sync.correction(1000 - d, 1000).rate;
      assert.ok(Math.abs(1 - a) <= 0.05 + 1e-9 && Math.abs(1 - b) <= 0.05 + 1e-9); // 1 - 0.95 is 0.05000000000000004 in floating point
      assert.ok(Math.abs((1 - a) + (1 - b)) < 1e-9);
    }
  });
  test('a drifting listener converges: applying the correction repeatedly pulls drift to ~0', () => {
    // simulate 60 s of a listener whose audio plays 0.3 % too fast, polled every 2 s
    let played = 0, target = 0, rate = 1, maxDrift = 0;
    for (let tick = 0; tick < 30; tick++) {
      for (let ms = 0; ms < 2000; ms += 100) { played += 100 * rate * 1.003; target += 100; }
      const c = Sync.correction(played, target);
      if (c.action === 'seek') played = c.seekToMs; rate = c.rate;
      maxDrift = Math.max(maxDrift, Math.abs(played - target));
    }
    assert.ok(maxDrift < Sync.SEEK_THRESHOLD_MS, 'drift stayed small: ' + maxDrift);
    assert.ok(Math.abs(played - target) < 100, 'final drift ' + (played - target));
  });
});

describe('several devices with wrong clocks hear the same moment (real HTTP)', () => {
  let h;
  before(async () => {
    h = await startHoster();
    fs.mkdirSync(path.join(h.shareDir, 'long'));
    writeWav(path.join(h.shareDir, 'long', 'one.wav'), 90);
    await h.start();
    await h.api('POST', '/api/radio/enqueue', { path: '/long' });
  });
  after(() => h.stop());

  // A virtual phone: its clock is real time + skew; replies reach it after a random extra delay (Wi-Fi jitter).
  const phone = (skew, jitterMs) => ({
    skew, jitterMs, samples: [], snap: null, snapAtLocal: 0,
    local() { return Date.now() + this.skew; },
    async poll() {
      const t0 = this.local();
      const snap = await (await fetch(`${h.ownerShare}/radio/state`)).json();
      await sleep(Math.random() * this.jitterMs); // asymmetric delay on the way back
      const t1 = this.local();
      this.samples = Sync.addSample(this.samples, { t0, t1, serverNow: snap.serverNow });
      this.snap = snap;
    },
    // where this phone believes the station is, right now
    believes() { return Sync.targetMs(this.snap, this.local(), Sync.clockOffset(this.samples)); },
    // a phone that ignores clock differences and just trusts the position it was given
    naive() { return this.snap.positionMs + (this.local() - this.snapAtLocal0); },
  });

  test('phones 6 s fast, 4 s slow, 0.3 s fast and exact agree within 80 ms; a naive phone is seconds off', async () => {
    const phones = [phone(6000, 40), phone(-4000, 40), phone(300, 40), phone(0, 40)];
    for (let round = 0; round < 8; round++) {
      await Promise.all(phones.map(p => p.poll()));
      await sleep(120);
    }
    // all phones evaluate "where is the station" at the same real instant
    const believed = phones.map(p => p.believes());
    const spread = Math.max(...believed) - Math.min(...believed);
    assert.ok(spread < 80, `phones disagree by ${spread.toFixed(1)} ms: ${believed.map(b => b.toFixed(0)).join(', ')}`);

    // control experiment — the test must be able to fail: without offset correction the skew shows up directly
    const naive = phones.map(p => Sync.targetMs(p.snap, p.local(), 0));
    const naiveSpread = Math.max(...naive) - Math.min(...naive);
    assert.ok(naiveSpread > 5000, `control: naive spread should be seconds, was ${naiveSpread.toFixed(0)} ms`);
  });

  test('a phone that joins late lands on the same moment as the veterans', async () => {
    const veteran = phone(-2500, 30), newcomer = phone(7000, 30);
    for (let i = 0; i < 6; i++) { await veteran.poll(); await sleep(100); }
    await sleep(700);
    for (let i = 0; i < 6; i++) { await newcomer.poll(); await sleep(60); }
    const diff = Math.abs(veteran.believes() - newcomer.believes());
    assert.ok(diff < 80, `newcomer is off by ${diff.toFixed(1)} ms`);
  });

  test('after the host pauses, every phone holds the same spot regardless of its clock', async () => {
    await h.api('POST', '/api/radio/pause');
    const a = phone(5000, 20), b = phone(-5000, 20);
    for (let i = 0; i < 4; i++) { await Promise.all([a.poll(), b.poll()]); await sleep(50); }
    assert.equal(a.snap.status, 'paused');
    assert.equal(a.believes(), b.believes());
    await sleep(300);
    assert.equal(a.believes(), a.snap.positionMs, 'time passing does not move a paused station');
  });
});
