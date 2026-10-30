'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startHoster, writeWav, waitFor, lanIp } = require('./helpers');

const PIN = '4321';
const pinH = { 'x-hoster-pin': PIN };
const json = { 'content-type': 'application/json' };

async function withStation(opts, fn) {
  const h = await startHoster();
  fs.mkdirSync(path.join(h.shareDir, 'radio'));
  writeWav(path.join(h.shareDir, 'radio', '01 one.wav'), 1.0);
  writeWav(path.join(h.shareDir, 'radio', '02 two.wav'), 1.0);
  writeWav(path.join(h.shareDir, 'radio', '03 three.wav'), 2.5);
  fs.writeFileSync(path.join(h.shareDir, 'radio', '04 broken.mp3'), 'not really audio '.repeat(500)); // 8.5 kB, unparsable
  await h.start(opts);
  try { await fn(h); } finally { await h.stop(); }
}
const owner = (h, m, p, body) => h.api(m, '/api/radio' + p, body);
const state = async (h, headers = {}) => (await fetch(`${h.ownerShare}/radio/state`, { headers })).json();

describe('radio — owner controls', () => {
  test('enqueue a folder: order, instant start, then real durations are probed from the files', async () => {
    await withStation({}, async h => {
      const r = await owner(h, 'POST', '/enqueue', { path: '/radio' });
      assert.equal(r.json.ok, true);
      assert.equal(r.json.added, 4);
      assert.deepEqual(r.json.state.queue.map(q => q.title), ['01 one', '02 two', '03 three', '04 broken']);
      assert.equal(r.json.state.status, 'playing', 'starts right away');

      const s = await waitFor(async () => { const x = await state(h); return x.queue[0].durationMs && x.queue[2].durationMs && x; }, { what: 'durations' });
      assert.equal(s.queue[0].durationMs, 1000);
      assert.equal(s.queue[2].durationMs, 2500);
      assert.equal(s.queue[3].durationMs, null, 'unparsable file stays unknown');
    });
  });

  test('plays through in real time and stops at the end (repeat off)', async () => {
    await withStation({}, async h => {
      fs.rmSync(path.join(h.shareDir, 'radio', '03 three.wav')); fs.rmSync(path.join(h.shareDir, 'radio', '04 broken.mp3'));
      await owner(h, 'POST', '/enqueue', { path: '/radio' });
      await waitFor(async () => (await state(h)).queue[1].durationMs, { what: 'probe' });
      await waitFor(async () => (await state(h)).track?.title === '02 two', { what: 'auto-advance to track two', timeout: 4000 });
      await waitFor(async () => (await state(h)).status === 'stopped', { what: 'stop after the last track', timeout: 4000 });
    });
  });

  test('transport: pause / resume / next / prev / seek / remove / shuffle / repeat / clear', async () => {
    await withStation({}, async h => {
      await owner(h, 'POST', '/enqueue', { path: '/radio' });
      assert.equal((await owner(h, 'POST', '/pause')).json.state.status, 'paused');
      assert.equal((await owner(h, 'POST', '/resume')).json.state.status, 'playing');
      assert.equal((await owner(h, 'POST', '/next')).json.state.track.title, '02 two');
      assert.equal((await owner(h, 'POST', '/prev')).json.state.track.title, '01 one');
      const seeked = (await owner(h, 'POST', '/seek', { ms: 500 })).json.state.positionMs;
      assert.ok(seeked >= 500 && seeked < 900, 'seek position ' + seeked);
      const id = (await state(h)).queue[3].id;
      assert.equal((await owner(h, 'POST', '/remove', { id })).json.state.queue.length, 3);
      const st = (await owner(h, 'POST', '/settings', { shuffle: true, repeat: 'all' })).json.state;
      assert.deepEqual([st.shuffle, st.repeat], [true, 'all']);
      assert.equal((await owner(h, 'POST', '/settings', { repeat: 'bogus' })).json.ok, false);
      const cleared = (await owner(h, 'POST', '/clear')).json.state;
      assert.deepEqual([cleared.status, cleared.queue.length], ['stopped', 0]);
    });
  });

  test('bad input is refused, not crashed on', async () => {
    await withStation({}, async h => {
      assert.equal((await owner(h, 'POST', '/enqueue', {})).status, 400);
      assert.equal((await owner(h, 'POST', '/enqueue', { path: '/nope' })).status, 404);
      assert.equal((await owner(h, 'POST', '/enqueue', { path: '/docs/page.html' })).status, 415, 'html is not media');
      assert.equal((await owner(h, 'POST', '/enqueue', { path: '/docs' })).status, 404, 'folder without media');
      for (const evil of ['../../etc/passwd', '/../x', '%2e%2e/%2e%2e/etc/passwd']) {
        const r = await owner(h, 'POST', '/enqueue', { path: evil });
        assert.ok([404, 415].includes(r.status), `${evil} -> ${r.status}`);
      }
      assert.equal((await owner(h, 'POST', '/play', { id: 424242 })).json.ok, false);
    });
  });

  test('the station is wiped when sharing stops (paths belong to one shared folder)', async () => {
    await withStation({}, async h => {
      await owner(h, 'POST', '/enqueue', { path: '/radio' });
      await h.api('POST', '/api/stop');
      assert.equal((await h.api('GET', '/api/radio')).json.queue.length, 0);
    });
  });
});

describe('radio — guests and the PIN', () => {
  test('state needs the PIN; the track carries a signed link, never the PIN', async () => {
    await withStation({ pinEnabled: true, pin: PIN }, async h => {
      await owner(h, 'POST', '/enqueue', { path: '/radio/01 one.wav' });
      assert.equal((await fetch(`${h.ownerShare}/radio/state`)).status, 401);
      const s = await state(h, pinH);
      assert.match(s.track.stream, /^\/files\/stream\?path=.*&t=/);
      assert.ok(!JSON.stringify(s).includes(PIN));
      assert.equal(s.track.path, undefined, 'internal path not exposed');
      // the signed link plays without any PIN
      const r = await fetch(h.ownerShare + s.track.stream, { headers: { Range: 'bytes=0-9' } });
      assert.equal(r.status, 206);
    });
  });

  test('guests cannot add songs until the host allows it; the host can always add', async () => {
    await withStation({}, async h => {
      // the guest-add route sees the owner as loopback, so test the refusal from "another device" when there is one
      if (h.lanShare) {
        const refused = await fetch(`${h.lanShare}/radio/add`, { method: 'POST', headers: json, body: JSON.stringify({ path: '/radio/01 one.wav' }) });
        assert.equal(refused.status, 403);
        await owner(h, 'POST', '/settings', { allowGuestAdd: true });
        assert.equal((await state(h)).allowGuestAdd, true);
        const ok = await fetch(`${h.lanShare}/radio/add`, { method: 'POST', headers: json, body: JSON.stringify({ path: '/radio/01 one.wav' }) });
        assert.equal(ok.status, 200);
        assert.equal((await state(h)).queue.length, 1);
        assert.equal((await state(h)).status, 'playing', 'an idle station starts when the first song arrives');
      }
      const mine = await fetch(`${h.ownerShare}/radio/add`, { method: 'POST', headers: json, body: JSON.stringify({ path: '/radio/02 two.wav' }) });
      assert.equal(mine.status, 200);
    });
  });

  test('guest adds are validated like everything else (traversal, non-media, missing, malformed)', async () => {
    await withStation({}, async h => {
      await owner(h, 'POST', '/settings', { allowGuestAdd: true });
      const add = body => fetch(`${h.ownerShare}/radio/add`, { method: 'POST', headers: json, body: JSON.stringify(body) });
      assert.equal((await add({})).status, 400);
      assert.equal((await add({ path: 5 })).status, 400);
      assert.equal((await add({ path: '/missing.mp3' })).status, 404);
      assert.equal((await add({ path: '/docs/page.html' })).status, 415);
      for (const evil of ['../../etc/passwd', '/../../etc/passwd']) assert.ok([404, 415].includes((await add({ path: evil })).status));
      const bad = await fetch(`${h.ownerShare}/radio/add`, { method: 'POST', headers: json, body: '{not json' });
      assert.ok(bad.status >= 400 && bad.status < 500);
    });
  });

  test('a guest-added folder is non-recursive and capped', async () => {
    await withStation({}, async h => {
      fs.mkdirSync(path.join(h.shareDir, 'big'));
      for (let i = 0; i < 130; i++) fs.writeFileSync(path.join(h.shareDir, 'big', `t${String(i).padStart(3, '0')}.mp3`), 'x');
      fs.mkdirSync(path.join(h.shareDir, 'big', 'sub')); fs.writeFileSync(path.join(h.shareDir, 'big', 'sub', 'deep.mp3'), 'x');
      await owner(h, 'POST', '/settings', { allowGuestAdd: true });
      const r = await fetch(`${h.ownerShare}/radio/add`, { method: 'POST', headers: json, body: JSON.stringify({ path: '/big' }) });
      // loopback is treated as the host, who may add up to 2000 — so the cap is exercised via the LAN address when present
      assert.equal(r.status, 200);
      if (h.lanShare) {
        await owner(h, 'POST', '/clear');
        const g = await fetch(`${h.lanShare}/radio/add`, { method: 'POST', headers: json, body: JSON.stringify({ path: '/big' }) });
        assert.deepEqual((await g.json()), { added: 100 });
        assert.ok(!(await state(h)).queue.some(q => q.title === 'deep'));
      }
    });
  });

  test('duration reports: only for unreadable files, only plausible, first one wins', async () => {
    await withStation({}, async h => {
      await owner(h, 'POST', '/enqueue', { path: '/radio' });
      const s = await waitFor(async () => { const x = await state(h); return x.queue[0].durationMs && x; }, { what: 'probe' });
      const broken = s.queue[3].id, known = s.queue[0].id;
      const report = (id, seconds) => fetch(`${h.ownerShare}/radio/duration`, { method: 'POST', headers: json, body: JSON.stringify({ id, seconds }) }).then(r => r.json());
      assert.deepEqual(await report(known, 5), { accepted: false }, 'a readable file keeps the server-read length');
      assert.deepEqual(await report(broken, 0.001), { accepted: false }, 'out of range (< 1 s)');
      assert.deepEqual(await report(broken, 99999), { accepted: false }, 'out of range (> 24 h)');
      assert.deepEqual(await report(broken, 60), { accepted: false }, 'an 8.5 kB file cannot be 60 s long (< 8 kbit/s)');
      assert.deepEqual(await report(broken, 5), { accepted: true }, '8.5 kB over 5 s is a believable bitrate');
      assert.deepEqual(await report(broken, 10), { accepted: false }, 'first report wins');
      assert.equal((await state(h)).queue[3].durationMs, 5000);
      assert.deepEqual(await report('x', 5), { accepted: false });
    });
  });
});

describe('radio — access control', { skip: !lanIp() && 'no non-loopback interface' }, () => {
  test('other devices cannot touch the owner API (403 on both ports)', async () => {
    await withStation({}, async h => {
      for (const [m, p, b] of [['GET', ''], ['POST', '/enqueue', { path: '/radio' }], ['POST', '/play'], ['POST', '/next'], ['POST', '/clear'], ['POST', '/settings', { allowGuestAdd: true }], ['POST', '/remove', { id: 1 }]]) {
        for (const base of [h.lanHost, h.lanShare]) {
          const r = await fetch(`${base}/api/radio${p}`, { method: m, headers: json, body: b ? JSON.stringify(b) : undefined });
          assert.equal(r.status, 403, `${m} ${p} via ${base}`);
        }
      }
    });
  });

  test('wrong PINs on /radio count toward the shared lockout', async () => {
    await withStation({ pinEnabled: true, pin: PIN }, async h => {
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await fetch(`${h.lanShare}/radio/state`, { headers: { 'x-hoster-pin': '000' + i } })).status);
      assert.deepEqual(codes, [401, 401, 401, 401, 429]);
      assert.equal((await fetch(`${h.lanShare}/radio/state`, { headers: pinH })).status, 429);
    });
  });

  test('a stopped server answers 503, not a stale station', async () => {
    const h = await startHoster();
    try {
      const r = await fetch(`${h.hostBase}/radio/state`);
      assert.equal(r.status, 503);
    } finally { await h.stop(); }
  });
});
