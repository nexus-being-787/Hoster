'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHoster } = require('./helpers');

const PIN = '4321';

describe('PIN protection (PIN enabled, request has NO pin)', () => {
  let h;
  before(async () => {
    h = await startHoster();
    await h.start({ pinEnabled: true, pin: PIN, uploadEnabled: true });
  });
  after(() => h.stop());

  // Every one of these must be refused when no PIN is supplied.
  const protectedGets = [
    '/files/list?path=%2F',
    '/files/stream?path=%2Fsong.flac',
    '/files/playlist.m3u?path=%2Fsong.flac',
    '/files/zip?path=%2F',
    '/view?path=%2Fdocs%2Fpage.html',
    '/view-dir/secret.txt',
    '/view-dir/docs/page.html',
    '/view-asset?path=secret.txt',
    '/pdf?path=%2Fa.pdf',
  ];
  for (const p of protectedGets) {
    // /pdf answers 403 with its own PIN form; everything else is a JSON 401
    const want = p.startsWith('/pdf') ? 403 : 401;
    test(`GET ${p} -> ${want} without PIN`, async () => {
      const r = await fetch(h.ownerShare + p); // even the owner must not bypass the PIN on the share
      assert.equal(r.status, want, `expected ${want}, got ${r.status}`);
    });
  }

  test('POST /upload -> 401 without PIN', async () => {
    const fd = new FormData();
    fd.append('files', new Blob(['evil']), 'evil.txt');
    const r = await fetch(h.ownerShare + '/upload', { method: 'POST', body: fd });
    assert.equal(r.status, 401);
  });

  test('right PIN works', async () => {
    const r = await fetch(`${h.ownerShare}/files/list?path=%2F&pin=${PIN}`);
    assert.equal(r.status, 200);
    const r2 = await fetch(`${h.ownerShare}/files/list?path=%2F`, { headers: { 'x-hoster-pin': PIN } });
    assert.equal(r2.status, 200);
  });

  test('wrong PIN is refused', async () => {
    const r = await fetch(`${h.ownerShare}/files/list?path=%2F&pin=0000`);
    assert.equal(r.status, 401);
  });
});

describe('path traversal', () => {
  let h;
  before(async () => { h = await startHoster(); await h.start(); });
  after(() => h.stop());

  const evil = ['..%2F..%2F..%2Fetc%2Fpasswd', '%2E%2E%2F%2E%2E%2Fetc%2Fpasswd', '..%5C..%5Cetc%5Cpasswd', '%2Fetc%2Fpasswd'];
  for (const e of evil) {
    for (const route of ['/files/stream?path=', '/files/list?path=', '/files/playlist.m3u?path=', '/pdf?path=', '/view?path=', '/view-asset?path=']) {
      test(`${route}${e} does not escape the shared folder`, async () => {
        const r = await fetch(h.ownerShare + route + e);
        const body = await r.text();
        assert.ok(!/root:.*:0:0:/.test(body), 'leaked /etc/passwd');
        assert.notEqual(r.status, 500, 'server error');
      });
    }
  }

  test('/view-dir cannot climb out of the shared folder', async () => {
    const r = await fetch(`${h.ownerShare}/view-dir/..%2F..%2F..%2Fetc%2Fpasswd`);
    const body = await r.text();
    assert.ok(!/root:.*:0:0:/.test(body));
  });
});

describe('host controls are owner-only', { skip: !require('./helpers').lanIp() && 'no non-loopback interface' }, () => {
  let h;
  before(async () => { h = await startHoster(); await h.start(); });
  after(() => h.stop());

  for (const p of ['/host/', '/host/host.js', '/api/filesystem?path=%2Ftmp', '/api/qrcode', '/api/logs', '/api/devices']) {
    test(`other device: GET ${p} on host port -> 403`, async () => {
      assert.equal((await fetch(h.lanHost + p)).status, 403);
    });
    test(`other device: GET ${p} on share port -> 403`, async () => {
      assert.equal((await fetch(h.lanShare + p)).status, 403);
    });
  }
  for (const p of ['/api/stop', '/api/start', '/api/settings']) {
    test(`other device: POST ${p} -> 403`, async () => {
      const r = await fetch(h.lanHost + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 403);
    });
  }
  test('other device sees only a reduced /api/status', async () => {
    const j = await (await fetch(h.lanShare + '/api/status')).json();
    assert.deepEqual(Object.keys(j).sort(), ['running', 'uploadEnabled']);
  });
  test('owner still has the full status', async () => {
    const r = await h.api('GET', '/api/status');
    assert.ok('sharedDir' in r.json && 'devices' in r.json);
  });
  test('client portal still works for other devices', async () => {
    assert.equal((await fetch(h.lanShare + '/')).status, 200);
    assert.equal((await fetch(h.lanShare + '/files/list?path=%2F')).status, 200);
    assert.equal((await fetch(h.lanShare + '/assets/fonts/outfit-latin.woff2')).status, 200);
  });
});

describe('WebDAV obeys the PIN and the uploads setting', () => {
  const basic = pw => ({ Authorization: 'Basic ' + Buffer.from('anyone:' + pw).toString('base64') });
  const dav = (h, method, p, headers = {}, body) => fetch(h.ownerShare + '/webdav' + p, { method, headers: { Depth: '1', ...headers }, body });

  describe('PIN on, uploads off', () => {
    let h;
    before(async () => { h = await startHoster(); await h.start({ pinEnabled: true, pin: PIN, webdavEnabled: true, uploadEnabled: false }); });
    after(() => h.stop());

    test('no credentials -> 401 with a Basic challenge (so file managers prompt for the PIN)', async () => {
      const r = await dav(h, 'PROPFIND', '/');
      assert.equal(r.status, 401);
      assert.match(r.headers.get('www-authenticate') || '', /^Basic /);
    });
    test('reading a file without credentials is refused (it used to be served)', async () => {
      assert.equal((await dav(h, 'GET', '/secret.txt')).status, 401);
    });
    test('wrong PIN -> 401; right PIN (any username) -> works', async () => {
      assert.equal((await dav(h, 'PROPFIND', '/', basic('0000'))).status, 401);
      assert.equal((await dav(h, 'PROPFIND', '/', basic(PIN))).status, 207);
      const r = await dav(h, 'GET', '/secret.txt', basic(PIN));
      assert.equal(r.status, 200);
      assert.equal(await r.text(), 'top secret');
    });
    test('uploads off => read-only, even with the right PIN', async () => {
      for (const [m, p] of [['PUT', '/evil.txt'], ['MKCOL', '/newdir'], ['DELETE', '/secret.txt'], ['MOVE', '/secret.txt'], ['COPY', '/secret.txt'], ['PROPPATCH', '/secret.txt'], ['LOCK', '/secret.txt']]) {
        const r = await dav(h, m, p, { ...basic(PIN), Destination: '/moved.txt' }, m === 'PUT' ? 'x' : undefined);
        assert.equal(r.status, 403, `${m} should be refused`);
      }
      assert.ok(!require('node:fs').existsSync(require('node:path').join(h.shareDir, 'evil.txt')));
      assert.ok(require('node:fs').existsSync(require('node:path').join(h.shareDir, 'secret.txt')));
    });
    test('a browser navigating to /webdav/ is still sent to the portal (which enforces the PIN itself)', async () => {
      const r = await fetch(h.ownerShare + '/webdav/', { headers: { Accept: 'text/html' }, redirect: 'manual' });
      assert.equal(r.status, 302);
    });
  });

  describe('PIN on, uploads on', () => {
    let h;
    before(async () => { h = await startHoster(); await h.start({ pinEnabled: true, pin: PIN, webdavEnabled: true, uploadEnabled: true }); });
    after(() => h.stop());
    test('PUT needs the PIN; with it the file is written', async () => {
      assert.equal((await dav(h, 'PUT', '/up.txt', {}, 'hi')).status, 401);
      assert.equal((await dav(h, 'PUT', '/up.txt', basic(PIN), 'hi')).status, 201);
      assert.equal(require('node:fs').readFileSync(require('node:path').join(h.shareDir, 'up.txt'), 'utf8'), 'hi');
    });
  });

  describe('lockout', { skip: !require('./helpers').lanIp() && 'no non-loopback interface' }, () => {
    let h;
    before(async () => { h = await startHoster(); await h.start({ pinEnabled: true, pin: PIN, webdavEnabled: true }); });
    after(() => h.stop());
    test('5 wrong PINs over WebDAV lock the address out of the whole share', async () => {
      const bad = () => fetch(h.lanShare + '/webdav/', { method: 'PROPFIND', headers: { Depth: '1', ...basic('1111') } });
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await bad()).status);
      assert.deepEqual(codes, [401, 401, 401, 401, 429]);
      assert.equal((await fetch(`${h.lanShare}/files/list?path=%2F`, { headers: pinH2 })).status, 429);
    });
  });

  describe('no PIN set: behaves as before', () => {
    let h;
    before(async () => { h = await startHoster(); await h.start({ webdavEnabled: true, uploadEnabled: true }); });
    after(() => h.stop());
    test('open access, as the owner chose', async () => {
      assert.equal((await dav(h, 'PROPFIND', '/')).status, 207);
    });
  });
});
const pinH2 = { 'x-hoster-pin': PIN };
