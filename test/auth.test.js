'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startHoster, lanIp } = require('./helpers');
const auth = require('../src/utils/auth');

const PIN = '4321';
const pinH = { 'x-hoster-pin': PIN };

describe('token primitives', () => {
  test('valid, expired, tampered, wrong-path and wrong-scope tokens', () => {
    const t = auth.signToken('media', 60, '/song.flac');
    assert.equal(auth.verifyToken('media', t, '/song.flac'), true);
    assert.equal(auth.verifyToken('media', auth.signToken('media', -5, '/song.flac'), '/song.flac'), false, 'expired');
    assert.equal(auth.verifyToken('media', t.slice(0, -2) + 'xx', '/song.flac'), false, 'tampered');
    assert.equal(auth.verifyToken('media', t, '/other.flac'), false, 'other path');
    assert.equal(auth.verifyToken('playlist', t, '/song.flac'), false, 'other scope');
    assert.equal(auth.verifyToken('media', undefined, '/x'), false);
    assert.equal(auth.verifyToken('media', 'garbage', '/x'), false);
  });
  test('normPath canonicalises spellings of the same path', () => {
    assert.equal(auth.normPath('album/01.mp3'), '/album/01.mp3');
    assert.equal(auth.normPath('/album//01.mp3'), '/album/01.mp3');
    assert.equal(auth.normPath('\\album\\01.mp3'), '/album/01.mp3');
    assert.equal(auth.normPath(''), '/');
  });
});

describe('signed links: VLC never needs the PIN', () => {
  let h;
  before(async () => { h = await startHoster(); await h.start({ pinEnabled: true, pin: PIN }); });
  after(() => h.stop());

  const addr = async p => (await fetch(`${h.ownerShare}/files/addr?path=${encodeURIComponent(p)}`, { headers: pinH })).json();

  test('/files/addr needs the PIN and returns tokens, never the PIN', async () => {
    assert.equal((await fetch(`${h.ownerShare}/files/addr?path=%2Fsong.flac`)).status, 401);
    const j = await addr('/song.flac');
    assert.ok(j.t && j.pt && j.host);
    assert.ok(!JSON.stringify(j).includes(PIN));
  });

  test('a file token streams that file (206) without any PIN', async () => {
    const { t } = await addr('/song.flac');
    const r = await fetch(`${h.ownerShare}/files/stream?path=%2Fsong.flac&t=${t}`, { headers: { Range: 'bytes=0-9' } });
    assert.equal(r.status, 206);
  });
  test('the same token works however the path is spelled', async () => {
    const { t } = await addr('/song.flac');
    const r = await fetch(`${h.ownerShare}/files/stream?path=song.flac&t=${t}`, { headers: { Range: 'bytes=0-9' } });
    assert.equal(r.status, 206);
  });
  test('a token is bound to its file', async () => {
    const { t } = await addr('/song.flac');
    const r = await fetch(`${h.ownerShare}/files/stream?path=%2Fsecret.txt&t=${t}`);
    assert.equal(r.status, 401);
  });
  test('a tampered token is refused', async () => {
    const { t } = await addr('/song.flac');
    const r = await fetch(`${h.ownerShare}/files/stream?path=%2Fsong.flac&t=${t.slice(0, -3)}abc`);
    assert.equal(r.status, 401);
  });
  test('tokens do not unlock other endpoints (zip, list, upload, view)', async () => {
    const { t, pt } = await addr('/song.flac');
    for (const p of [`/files/zip?path=%2F&t=${t}`, `/files/list?path=%2F&t=${t}`, `/files/download?path=%2Fsong.flac&t=${t}`, `/view?path=%2Fdocs%2Fpage.html&t=${t}`]) {
      assert.equal((await fetch(h.ownerShare + p)).status, 401, p);
    }
    // a playlist token cannot stream, a media token cannot fetch a playlist
    assert.equal((await fetch(`${h.ownerShare}/files/stream?path=%2Fsong.flac&t=${pt}`)).status, 401);
    assert.equal((await fetch(`${h.ownerShare}/files/playlist.m3u?path=%2Fsong.flac&t=${t}`)).status, 401);
  });

  test('folder playlist: natural order, media only, per-entry tokens, no PIN anywhere', async () => {
    const { pt } = await addr('/album');
    const r = await fetch(`${h.ownerShare}/files/playlist.m3u?path=%2Falbum&t=${pt}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /mpegurl/);
    const body = await r.text();
    const urls = body.split('\n').filter(l => l.startsWith('http'));
    assert.equal(urls.length, 2, 'cover.jpg must be left out');
    assert.ok(body.indexOf('01%20one') < body.indexOf('02%20two'));
    assert.ok(urls.every(u => /[?&]t=/.test(u)) && !body.includes('pin='));
    assert.ok(!body.includes(PIN));
    for (const u of urls) { // every entry actually plays, using only its own token
      const sr = await fetch(u.replace(/^http:\/\/[^/]+/, h.ownerShare), { headers: { Range: 'bytes=0-1' } });
      assert.equal(sr.status, 206, u);
    }
  });
  test('playlist token is bound to its folder', async () => {
    const { pt } = await addr('/album');
    assert.equal((await fetch(`${h.ownerShare}/files/playlist.m3u?path=%2F&t=${pt}`)).status, 401);
  });
  test('empty folder -> 404 with a clear message', async () => {
    const { pt } = await addr('/docs');
    const r = await fetch(`${h.ownerShare}/files/playlist.m3u?path=%2Fdocs&t=${pt}`);
    assert.equal(r.status, 404);
  });
});

describe('folder playlists (no PIN, recursion, symlinks)', () => {
  let h;
  before(async () => {
    h = await startHoster();
    fs.mkdirSync(path.join(h.shareDir, 'album', 'disc2'));
    fs.writeFileSync(path.join(h.shareDir, 'album', 'disc2', '03 three.mp3'), 'c');
    fs.writeFileSync(path.join(h.shareDir, 'album', '10 ten.mp3'), 'd');
    fs.writeFileSync(path.join(h.shareDir, 'album', '.hidden.mp3'), 'e');
    try { fs.symlinkSync(os.tmpdir(), path.join(h.shareDir, 'album', 'linkdir')); } catch (e) { /* no symlink support */ }
    await h.start();
  });
  after(() => h.stop());
  const names = async q => (await (await fetch(`${h.ownerShare}/files/playlist.m3u?${q}`)).text()).split('\n').filter(l => l.startsWith('#EXTINF')).map(l => l.split(',')[1]);

  test('natural sort (2 before 10), hidden files skipped, no tokens when PIN is off', async () => {
    const r = await fetch(`${h.ownerShare}/files/playlist.m3u?path=%2Falbum`);
    const body = await r.text();
    assert.deepEqual(await names('path=%2Falbum'), ['01 one', '02 two', '10 ten']);
    assert.ok(!/[?&]t=/.test(body));
  });
  test('recursive=1 includes sub-folders; symlinked folders are never followed', async () => {
    const all = await names('path=%2Falbum&recursive=1');
    assert.ok(all.includes('03 three'));
    assert.equal(all.length, 4);
  });
  test('a single file becomes a one-entry playlist', async () => {
    assert.deepEqual(await names('path=%2Fsong.flac'), ['song']);
  });
});

describe('PIN brute-force lockout', { skip: !lanIp() && 'no non-loopback interface' }, () => {
  let h;
  before(async () => { h = await startHoster(); await h.start({ pinEnabled: true, pin: PIN, uploadEnabled: true }); });
  after(() => h.stop());

  test('page loads without a PIN never count as guesses', async () => {
    for (let i = 0; i < 12; i++) assert.equal((await fetch(`${h.lanShare}/files/list?path=%2F`)).status, 401);
    assert.equal((await fetch(`${h.lanShare}/files/list?path=%2F`, { headers: pinH })).status, 200);
  });

  test('5 wrong PINs lock the guesser out — even the right PIN is then refused', async () => {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(`${h.lanShare}/files/list?path=%2F&pin=000${i}`)).status);
    assert.deepEqual(codes, [401, 401, 401, 401, 429]);
    const r = await fetch(`${h.lanShare}/files/list?path=%2F`, { headers: pinH });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
  });

  test('the lockout covers every PIN-checked route (/pdf, /view, /upload)', async () => {
    assert.equal((await fetch(`${h.lanShare}/pdf?path=%2Fa.pdf&pin=${PIN}`)).status, 429);
    assert.equal((await fetch(`${h.lanShare}/view?path=%2Fdocs%2Fpage.html&pin=${PIN}`)).status, 429);
    const fd = new FormData(); fd.append('files', new Blob(['x']), 'x.txt');
    assert.equal((await fetch(`${h.lanShare}/upload`, { method: 'POST', headers: pinH, body: fd })).status, 429);
  });

  test('signed links keep working for a locked-out guesser (they are not PIN guesses)', async () => {
    const j = await (await fetch(`${h.ownerShare}/files/addr?path=%2Fsong.flac`, { headers: pinH })).json();
    const r = await fetch(`${h.lanShare}/files/stream?path=%2Fsong.flac&t=${j.t}`, { headers: { Range: 'bytes=0-1' } });
    assert.equal(r.status, 206);
  });

  test("the owner's own phone is never locked out", async () => {
    for (let i = 0; i < 8; i++) await fetch(`${h.ownerShare}/files/list?path=%2F&pin=999${i}`);
    assert.equal((await fetch(`${h.ownerShare}/files/list?path=%2F`, { headers: pinH })).status, 200);
  });
});

describe('HTML viewer + upload behind the PIN', () => {
  let h;
  before(async () => { h = await startHoster(); await h.start({ pinEnabled: true, pin: PIN, uploadEnabled: true }); });
  after(() => h.stop());

  test('/view with the PIN sets a cookie that unlocks /view-dir sub-resources', async () => {
    assert.equal((await fetch(`${h.ownerShare}/view-dir/docs/page.html`)).status, 401);
    const r = await fetch(`${h.ownerShare}/view?path=%2Fdocs%2Fpage.html&pin=${PIN}`);
    assert.equal(r.status, 200);
    const cookies = r.headers.getSetCookie().filter(c => c.startsWith('hoster_view='));
    assert.ok(cookies.length >= 1 && cookies.every(c => /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c)));
    const cookie = cookies[0].split(';')[0];
    assert.equal((await fetch(`${h.ownerShare}/view-dir/docs/page.html`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${h.ownerShare}/view-dir/docs/page.html`, { headers: { cookie: cookie.slice(0, -2) + 'zz' } })).status, 401);
  });

  test('upload needs the PIN; with it the file lands in the share', async () => {
    const mk = () => { const fd = new FormData(); fd.append('files', new Blob(['hello']), 'up.txt'); return fd; };
    assert.equal((await fetch(`${h.ownerShare}/upload`, { method: 'POST', body: mk() })).status, 401);
    const ok = await fetch(`${h.ownerShare}/upload`, { method: 'POST', headers: pinH, body: mk() });
    assert.equal(ok.status, 200);
    assert.ok(fs.readdirSync(h.shareDir).some(f => f.includes('up')));
  });

  test('Referrer-Policy: no-referrer is sent', async () => {
    const r = await fetch(`${h.ownerShare}/`);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  });
});

describe('session cookie: the PIN never needs to be in a URL', () => {
  let h, cookie;
  const withCookie = (c = cookie) => ({ headers: { cookie: c } });
  before(async () => {
    h = await startHoster();
    await h.start({ pinEnabled: true, pin: PIN, uploadEnabled: true });
    const r = await fetch(`${h.ownerShare}/files/list?path=%2F`, { headers: pinH });
    cookie = (r.headers.getSetCookie().find(c => c.startsWith('hoster_session=')) || '').split(';')[0];
  });
  after(() => h.stop());

  test('a correct PIN (header) is answered with an HttpOnly, SameSite=Strict session cookie', async () => {
    const r = await fetch(`${h.ownerShare}/files/list?path=%2F`, { headers: pinH });
    const c = r.headers.getSetCookie().find(x => x.startsWith('hoster_session='));
    assert.ok(c, 'no session cookie issued');
    assert.match(c, /HttpOnly/i); assert.match(c, /SameSite=Strict/i); assert.match(c, /Path=\//); assert.match(c, /Max-Age=\d+/);
    assert.ok(!c.includes(PIN), 'the cookie must not contain the PIN');
  });

  test('a wrong PIN or no PIN never gets a cookie', async () => {
    for (const headers of [{ 'x-hoster-pin': '0000' }, {}]) {
      const r = await fetch(`${h.ownerShare}/files/list?path=%2F`, { headers });
      assert.equal(r.status, 401);
      assert.equal(r.headers.getSetCookie().length, 0);
    }
  });

  test('with only the cookie (no PIN anywhere) every guarded route works', async () => {
    const q = p => fetch(h.ownerShare + p, withCookie());
    const fd = () => { const f = new FormData(); f.append('files', new Blob(['hi']), 'cookie-upload.txt'); return f; };
    for (const [p, want] of [
      ['/files/list?path=%2F', 200], ['/files/zip?path=%2Falbum', 200], ['/files/download?path=%2Fsong.flac', 200],
      ['/files/playlist.m3u?path=%2Falbum', 200], ['/view?path=%2Fdocs%2Fpage.html', 200], ['/view-dir/docs/page.html', 200],
      ['/pdf?path=%2Fa.pdf', 200], ['/radio/state', 200],
    ]) assert.equal((await q(p)).status, want, p);
    assert.equal((await fetch(`${h.ownerShare}/files/stream?path=%2Fsong.flac`, { headers: { cookie, Range: 'bytes=0-9' } })).status, 206);
    assert.equal((await fetch(`${h.ownerShare}/upload`, { method: 'POST', headers: { cookie }, body: fd() })).status, 200);
  });

  test('forged, truncated, wrong-scope and empty cookies are refused', async () => {
    const view = (await fetch(`${h.ownerShare}/view?path=%2Fdocs%2Fpage.html&pin=${PIN}`)).headers.getSetCookie().find(c => c.startsWith('hoster_view='));
    const viewerToken = view.split(';')[0].split('=')[1];
    for (const bad of [cookie.slice(0, -3) + 'abc', 'hoster_session=', 'hoster_session=garbage', `hoster_session=${viewerToken}`, 'hoster_session=9999999999.AAAA']) {
      assert.equal((await fetch(`${h.ownerShare}/files/list?path=%2F`, { headers: { cookie: bad } })).status, 401, bad.slice(0, 30));
    }
  });

  test('the cookie value cannot be used as a path token, nor a path token as a session', async () => {
    const j = await (await fetch(`${h.ownerShare}/files/addr?path=%2Fsong.flac`, { headers: pinH })).json();
    const sessionVal = cookie.split('=')[1];
    assert.equal((await fetch(`${h.ownerShare}/files/stream?path=%2Fsong.flac&t=${sessionVal}`)).status, 401);
    assert.equal((await fetch(`${h.ownerShare}/files/list?path=%2F`, { headers: { cookie: `hoster_session=${j.t}` } })).status, 401);
  });

  test('PDF unlock form: ?pin= sets the cookie and redirects to a URL without the PIN', async () => {
    const r = await fetch(`${h.ownerShare}/pdf?path=%2Fa.pdf&pin=${PIN}`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.ok(!r.headers.get('location').includes('pin='), r.headers.get('location'));
    assert.ok(r.headers.getSetCookie().some(c => c.startsWith('hoster_session=')));
    const c = r.headers.getSetCookie().find(x => x.startsWith('hoster_session=')).split(';')[0];
    const page = await fetch(h.ownerShare + r.headers.get('location'), { headers: { cookie: c } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(!html.includes(PIN) && !/pin=/.test(html), 'the PDF page must not contain the PIN');
  });

  test('responses to cookie-authenticated pages do not echo the PIN anywhere', async () => {
    for (const p of ['/view?path=%2Fdocs%2Fpage.html', '/pdf?path=%2Fa.pdf', '/files/list?path=%2F', '/radio/state']) {
      const r = await fetch(h.ownerShare + p, withCookie());
      assert.ok(!(await r.text()).includes(PIN), p);
    }
  });
});

describe('session cookie vs the lockout', { skip: !lanIp() && 'no non-loopback interface' }, () => {
  test('a locked-out guesser is refused, but a legitimate session keeps working (cookies are not guesses)', async () => {
    const h = await startHoster();
    try {
      await h.start({ pinEnabled: true, pin: PIN });
      const ok = await fetch(`${h.lanShare}/files/list?path=%2F`, { headers: pinH });
      const cookie = ok.headers.getSetCookie().find(c => c.startsWith('hoster_session=')).split(';')[0];
      // someone else on the network hammers wrong PINs from the same address until it is locked
      for (let i = 0; i < 5; i++) await fetch(`${h.lanShare}/files/list?path=%2F&pin=000${i}`);
      assert.equal((await fetch(`${h.lanShare}/files/list?path=%2F`, { headers: pinH })).status, 429, 'PIN attempts are locked out');
      assert.equal((await fetch(`${h.lanShare}/files/list?path=%2F`, { headers: { cookie } })).status, 200, 'the session still works');
    } finally { await h.stop(); }
  });
});

describe('the portal never puts the PIN in a URL', () => {
  test('public/js/app.js contains no "pin=" URL construction', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
    const hits = app.split('\n').map((l, i) => [i + 1, l.trim().slice(0, 100)]).filter(([, l]) => /pin=/.test(l));
    assert.deepEqual(hits, []);
  });
});
