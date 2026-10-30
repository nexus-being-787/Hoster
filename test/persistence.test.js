'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startHoster } = require('./helpers');
const config = require('../src/utils/config');

describe('config store', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hoster-cfg-'));

  test('round-trips valid settings and writes the file owner-only', () => {
    const dir = tmp(); const c = config.create(dir);
    c.save({ sharedDir: '/storage/emulated/0/Music', port: 8081, pinEnabled: true, pin: '4821', uploadEnabled: false, customDomain: 'music' });
    assert.deepEqual(c.load(), { sharedDir: '/storage/emulated/0/Music', port: 8081, pinEnabled: true, pin: '4821', uploadEnabled: false, customDomain: 'music' });
    if (process.platform !== 'win32') assert.equal(fs.statSync(c.file).mode & 0o777, 0o600);
  });
  test('merges patches instead of replacing', () => {
    const c = config.create(tmp());
    c.save({ port: 8080, uploadEnabled: true });
    c.save({ uploadEnabled: false });
    assert.deepEqual(c.load(), { port: 8080, uploadEnabled: false });
  });
  test('rejects invalid values and unknown keys (a hand-edited file can not inject anything)', () => {
    const c = config.create(tmp());
    c.save({ port: 70000, pin: 'abcd', pinEnabled: 'yes', customDomain: 'a b;rm -rf', sharedDir: '', evil: 'x', __proto__: { polluted: 1 } });
    assert.deepEqual(c.load(), {});
    assert.equal({}.polluted, undefined);
  });
  test('a corrupt or missing file yields defaults instead of crashing', () => {
    const dir = tmp(); const c = config.create(dir);
    assert.deepEqual(c.load(), {});
    fs.writeFileSync(c.file, '{ not json');
    assert.deepEqual(c.load(), {});
    fs.writeFileSync(c.file, '[1,2,3]');
    assert.deepEqual(c.load(), {});
  });
  test('saving into an unwritable place never throws', () => {
    const c = config.create('/dev/null/not-a-directory');
    assert.doesNotThrow(() => c.save({ port: 8080 }));
  });
});

describe('settings survive a restart — but sharing never auto-starts', () => {
  test('folder, port, toggles, PIN and hostname come back; the server is NOT running', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoster-persist-'));
    try {
      const a = await startHoster({ __dataDir: dataDir });
      await a.start({ pinEnabled: true, pin: '4821', uploadEnabled: true, webdavEnabled: true, customDomain: 'My-Music' });
      await a.api('POST', '/api/settings', { uploadEnabled: false, preferHostname: false });
      await a.stop();

      const b = await startHoster({ __dataDir: dataDir });
      const s = (await b.api('GET', '/api/status')).json;
      assert.equal(s.running, false, 'must not auto-start sharing');
      assert.equal(s.sharedDir, a.shareDir);
      assert.equal(s.port, a.sharePort);
      assert.equal(s.pinEnabled, true);
      assert.equal(s.pin, '4821');
      assert.equal(s.uploadEnabled, false, 'later /api/settings change is remembered');
      assert.equal(s.webdavEnabled, true);
      assert.equal(s.preferHostname, false);
      assert.equal(s.customDomain, 'my-music');
      // and nothing is reachable on the share port
      await assert.rejects(fetch(`http://127.0.0.1:${a.sharePort}/files/list?path=%2F`));
      await b.stop();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('a corrupt config file does not stop the server from starting', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoster-corrupt-'));
    fs.writeFileSync(path.join(dataDir, 'config.json'), '\u0000garbage{');
    try {
      const h = await startHoster({ __dataDir: dataDir });
      const s = (await h.api('GET', '/api/status')).json;
      assert.equal(s.running, false);
      assert.equal(s.pinEnabled, false);
      await h.stop();
    } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  });

  test('stopping sharing does not erase remembered settings', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoster-stop-'));
    try {
      const a = await startHoster({ __dataDir: dataDir });
      await a.start({ pinEnabled: true, pin: '1357' });
      await a.api('POST', '/api/stop');
      const s = (await a.api('GET', '/api/status')).json;
      assert.equal(s.pin, '1357');
      await a.stop();
      assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).pin, '1357');
    } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  });
});
