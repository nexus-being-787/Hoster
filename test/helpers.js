'use strict';
// Test helpers: spin up a real Hoster server on free ports, with a temp shared folder.
const { spawn } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// HOSTER_TEST_ROOT lets CI run the very same tests against a shipped copy (linux/, windows/, the Android project).
const ROOT = process.env.HOSTER_TEST_ROOT ? path.resolve(process.env.HOSTER_TEST_ROOT) : path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '0.0.0.0', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

// First non-loopback IPv4. Requests to it come from a non-loopback source, which is how a
// "different device on the Wi-Fi" looks to the server.
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function startHoster(settings = {}) {
  const hostPort = await freePort();
  const sharePort = await freePort();
  const shareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoster-share-'));
  const ownsData = !settings.__dataDir;
  const dataDir = settings.__dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'hoster-data-'));
  delete settings.__dataDir;

  fs.mkdirSync(path.join(shareDir, 'docs'));
  fs.mkdirSync(path.join(shareDir, 'album'));
  fs.writeFileSync(path.join(shareDir, 'song.flac'), 'x'.repeat(2048));
  fs.writeFileSync(path.join(shareDir, 'docs', 'page.html'), '<h1>hello</h1>');
  fs.writeFileSync(path.join(shareDir, 'a.pdf'), '%PDF-1.4\n');
  fs.writeFileSync(path.join(shareDir, 'album', '01 one.mp3'), 'a'.repeat(100));
  fs.writeFileSync(path.join(shareDir, 'album', '02 two.mp3'), 'b'.repeat(100));
  fs.writeFileSync(path.join(shareDir, 'album', 'cover.jpg'), 'jpg');
  fs.writeFileSync(path.join(shareDir, 'secret.txt'), 'top secret');

  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, HOST_PORT: String(hostPort), HOSTER_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => (log += d));
  child.stderr.on('data', d => (log += d));

  const hostBase = `http://127.0.0.1:${hostPort}`;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${hostBase}/api/status`); if (r.ok) break; } catch (e) { /* not up yet */ }
    await sleep(100);
    if (i === 79) throw new Error('server did not start:\n' + log);
  }

  const api = async (method, p, body) => {
    const r = await fetch(hostBase + p, {
      method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch (e) { json = null; }
    return { status: r.status, json, text };
  };

  const start = async (extra = {}) => {
    const r = await api('POST', '/api/start', { dir: shareDir, port: sharePort, ...settings, ...extra });
    if (r.status !== 200) throw new Error('start failed: ' + r.text + '\n' + log);
    return r;
  };

  const lan = lanIp();
  return {
    hostPort, sharePort, shareDir, dataDir, hostBase, lan, api, start,
    ownerShare: `http://127.0.0.1:${sharePort}`, // loopback = the phone itself
    lanShare: lan ? `http://${lan}:${sharePort}` : null, // another device
    lanHost: lan ? `http://${lan}:${hostPort}` : null,
    log: () => log,
    async stop() {
      try { await fetch(`${hostBase}/api/stop`, { method: 'POST' }); } catch (e) { /* ignore */ }
      child.kill();
      await sleep(100);
      fs.rmSync(shareDir, { recursive: true, force: true });
      if (ownsData) fs.rmSync(dataDir, { recursive: true, force: true });
    },
    restart: null,
  };
}

/** Write a silent mono 8 kHz 16-bit WAV of exactly `seconds` — a real audio file with an exactly known length. */
function writeWav(file, seconds) {
  const rate = 8000, bytes = Math.round(seconds * rate) * 2;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + bytes, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(bytes, 40);
  fs.writeFileSync(file, Buffer.concat([h, Buffer.alloc(bytes)]));
}

/** Poll until `fn` returns a truthy value (or time out with a useful message). */
async function waitFor(fn, { timeout = 6000, every = 80, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await sleep(every);
  }
}

module.exports = { writeWav, waitFor, startHoster, lanIp, sleep, freePort, ROOT };
