'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mime = require('mime-types');
const { probe, available } = require('../src/utils/duration');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe('duration probe', () => {
  test('the metadata library is available', () => assert.equal(available(), true));

  describe('real files made with ffmpeg', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
    let dir;
    const gen = (name, args) => {
      const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', ...args, path.join(dir, name)]);
      assert.equal(r.status, 0, `ffmpeg failed for ${name}: ${r.stderr}`);
    };
    before(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoster-aud-'));
      const sine = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3.0'];
      gen('a.mp3', [...sine, '-c:a', 'libmp3lame', '-metadata', 'title=Test Song', '-metadata', 'artist=The Sines']);
      gen('a.flac', [...sine, '-c:a', 'flac']);
      gen('a.ogg', [...sine, '-c:a', 'libvorbis']);
      gen('a.opus', [...sine, '-c:a', 'libopus']);
      gen('a.m4a', [...sine, '-c:a', 'aac']);
      gen('a.wav', [...sine, '-c:a', 'pcm_s16le']);
      gen('v.mp4', ['-f', 'lavfi', '-i', 'testsrc=duration=2.0:size=160x120:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2.0',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    for (const [name, want] of [['a.mp3', 3000], ['a.flac', 3000], ['a.ogg', 3000], ['a.opus', 3000], ['a.m4a', 3000], ['a.wav', 3000], ['v.mp4', 2000]]) {
      test(`${name}: duration within 100 ms of the real length`, async () => {
        const r = await probe(path.join(dir, name), mime.lookup(name));
        assert.ok(r.durationMs !== null, 'no duration returned');
        assert.ok(Math.abs(r.durationMs - want) <= 100, `got ${r.durationMs} ms, want ~${want} ms`);
      });
    }
    test('reads title and artist tags', async () => {
      const r = await probe(path.join(dir, 'a.mp3'), 'audio/mpeg');
      assert.equal(r.title, 'Test Song');
      assert.equal(r.artist, 'The Sines');
    });
  });

  test('garbage, empty and missing files give nulls instead of throwing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoster-bad-'));
    try {
      fs.writeFileSync(path.join(dir, 'junk.mp3'), 'this is not audio'.repeat(100));
      fs.writeFileSync(path.join(dir, 'empty.flac'), '');
      for (const f of ['junk.mp3', 'empty.flac', 'missing.ogg']) {
        assert.deepEqual(await probe(path.join(dir, f), mime.lookup(f)), { durationMs: null, title: null, artist: null }, f);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
