'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHoster } = require('./helpers');
const { build } = require('../public/js/player-links.js');

const base = { protocol: 'http', host: '192.168.1.5:8080' };

describe('player link builder', () => {
  test('single file: vlc:// deep link wraps the full http stream URL', () => {
    const l = build({ ...base, path: '/Music/a.flac', t: 'TOK' });
    assert.equal(l.httpUrl, 'http://192.168.1.5:8080/files/stream?path=%2FMusic%2Fa.flac&t=TOK');
    assert.equal(l.vlcUrl, 'vlc://' + l.httpUrl);
  });
  test('folder: points at the playlist endpoint with the playlist token', () => {
    const l = build({ ...base, path: '/Music/Album', folder: true, t: 'FILE', pt: 'LIST' });
    assert.equal(l.httpUrl, 'http://192.168.1.5:8080/files/playlist.m3u?path=%2FMusic%2FAlbum&t=LIST');
  });
  test('the PIN is never used when a token is available', () => {
    for (const folder of [false, true]) {
      const l = build({ ...base, path: '/a.mp3', folder, t: 'T', pt: 'P', pin: '4321' });
      assert.ok(!/4321|pin=/.test(l.httpUrl + l.vlcUrl + l.intentUrl));
    }
  });
  test('PIN is only a last-resort fallback when no token could be fetched', () => {
    assert.match(build({ ...base, path: '/a.mp3', pin: '4321' }).httpUrl, /&pin=4321$/);
  });
  test('no auth query at all when there is no PIN', () => {
    assert.equal(build({ ...base, path: '/a.mp3' }).httpUrl, 'http://192.168.1.5:8080/files/stream?path=%2Fa.mp3');
  });
  test('awkward file names survive a round trip (spaces, &, #, ?, %, unicode)', () => {
    for (const name of ['/My Music/Tom & Jerry #1?.mp3', '/100% real.flac', '/日本語/曲.mp3', "/it's.mp3"]) {
      const u = new URL(build({ ...base, path: name, t: 'T' }).httpUrl);
      assert.equal(u.searchParams.get('path'), name);
      assert.equal(u.searchParams.get('t'), 'T');
    }
  });
  test('Android intents target VLC (or MX Player) with the right MIME type', () => {
    const v = build({ ...base, path: '/a.mp4', kind: 'video', t: 'T' }).intentUrl;
    assert.match(v, /^intent:\/\/192\.168\.1\.5:8080\/files\/stream\?path=%2Fa\.mp4&t=T#Intent;package=org\.videolan\.vlc;type=video\/\*;scheme=http;end$/);
    assert.match(build({ ...base, path: '/a.mp4', kind: 'video', player: 'mx', t: 'T' }).intentUrl, /package=com\.mxtech\.videoplayer\.ad/);
    assert.match(build({ ...base, path: '/Album', folder: true, pt: 'P' }).intentUrl, /type=audio\/x-mpegurl/);
  });
  test('https is preserved', () => {
    assert.match(build({ protocol: 'https', host: 'h:1', path: '/a', t: 'T' }).vlcUrl, /^vlc:\/\/https:\/\/h:1\//);
  });
});

describe('end to end: what the portal does when you tap "Play in VLC"', () => {
  let h;
  before(async () => { h = await startHoster(); await h.start({ pinEnabled: true, pin: '4321' }); });
  after(() => h.stop());

  // Mirrors openInExternalPlayer(): ask /files/addr (with the PIN header), build the link, fetch it like VLC.
  async function asVlc({ path, folder }) {
    const j = await (await fetch(`${h.ownerShare}/files/addr?path=${encodeURIComponent(path)}`, { headers: { 'x-hoster-pin': '4321' } })).json();
    const l = build({ path, folder, kind: 'audio', protocol: j.protocol, host: j.host, t: j.t, pt: j.pt, pin: '4321' });
    assert.ok(!l.vlcUrl.includes('pin='), 'PIN leaked into the link');
    const toLoopback = u => u.replace(/^https?:\/\/[^/]+/, h.ownerShare);
    return { l, toLoopback };
  }

  test('file link streams with Range requests (seeking) and no PIN', async () => {
    const { l, toLoopback } = await asVlc({ path: '/song.flac' });
    const r = await fetch(toLoopback(l.httpUrl), { headers: { Range: 'bytes=100-199' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 100-199/2048');
  });

  test('folder link yields a playlist whose entries all stream', async () => {
    const { l, toLoopback } = await asVlc({ path: '/album', folder: true });
    const body = await (await fetch(toLoopback(l.httpUrl))).text();
    const urls = body.split('\n').filter(x => x.startsWith('http'));
    assert.equal(urls.length, 2);
    for (const u of urls) assert.equal((await fetch(toLoopback(u), { headers: { Range: 'bytes=0-1' } })).status, 206);
  });
});
