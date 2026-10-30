'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startHoster } = require('./helpers');
const { resolveSafePath } = require('../src/utils/paths');

describe('resolveSafePath', () => {
  const base = path.resolve('/srv/share');
  test('keeps legitimate paths inside the share', () => {
    assert.equal(resolveSafePath(base, '/a/b.mp3'), path.join(base, 'a', 'b.mp3'));
    assert.equal(resolveSafePath(base, 'a/b.mp3'), path.join(base, 'a', 'b.mp3'));
    assert.equal(resolveSafePath(base, ''), base);
  });
  test('refuses anything that climbs out', () => {
    for (const p of ['../x', '/../x', 'a/../../x', '..\\x', '/a/../../../etc/passwd']) assert.equal(resolveSafePath(base, p), null, p);
  });
  test('a literal % is just a character (no second decoding)', () => {
    assert.equal(resolveSafePath(base, '/100% real.pdf'), path.join(base, '100% real.pdf'));
    assert.equal(resolveSafePath(base, '/%2e%2e/x'), path.join(base, '%2e%2e', 'x'), 'already-decoded input is not decoded again');
  });
  test('no share configured -> null', () => assert.equal(resolveSafePath(null, '/a'), null));
});

describe('files whose names contain %, #, & and spaces work on every route', () => {
  let h; const dir = '50% off & more #1';
  before(async () => {
    h = await startHoster();
    fs.mkdirSync(path.join(h.shareDir, dir));
    fs.writeFileSync(path.join(h.shareDir, dir, '100% real.pdf'), '%PDF-1.4\n');
    fs.writeFileSync(path.join(h.shareDir, dir, 'page one.html'), '<h1>x</h1>');
    await h.start({ uploadEnabled: true });
  });
  after(() => h.stop());
  const q = s => encodeURIComponent(s);

  test('/pdf serves "100% real.pdf" (it used to throw URIError)', async () => {
    const r = await fetch(`${h.ownerShare}/pdf?path=${q('/' + dir + '/100% real.pdf')}`);
    assert.equal(r.status, 200);
  });
  test('/files/list and /view work inside the odd folder', async () => {
    assert.equal((await fetch(`${h.ownerShare}/files/list?path=${q('/' + dir)}`)).status, 200);
    assert.equal((await fetch(`${h.ownerShare}/view?path=${q('/' + dir + '/page one.html')}`)).status, 200);
  });
  test('upload into the odd folder lands there (it used to crash on the second decode)', async () => {
    const fd = new FormData(); fd.append('files', new Blob(['hello']), 'new.txt');
    const r = await fetch(`${h.ownerShare}/upload?path=${q('/' + dir)}`, { method: 'POST', body: fd });
    assert.equal(r.status, 200);
    assert.ok(fs.existsSync(path.join(h.shareDir, dir, 'new.txt')));
  });
  test('a malformed % sequence is refused cleanly, never a crash or 500', async () => {
    for (const bad of ['/%E0%A4%A', '/%']) {
      const r = await fetch(`${h.ownerShare}/pdf?path=${bad}`);
      assert.ok(r.status < 500, `${bad} -> ${r.status}`);
    }
    assert.equal((await fetch(`${h.ownerShare}/files/list?path=%2F`)).status, 200, 'server still alive');
  });
});
