const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const mime = require('mime-types');
const archiver = require('archiver');
const auth = require('../utils/auth');
const { collectMedia } = require('../utils/media');
const { resolveSafePath } = require('../utils/paths');

// The address the client actually reached us on. Using the connected interface's IP
// (instead of the Host header) means VLC never has to resolve a .local name, and the
// link is always correct for *right now*, even if the phone's IP changed since the page loaded.
function reachableOrigin(req) {
  let addr = (req.socket && req.socket.localAddress) || '';
  if (addr.startsWith('::ffff:')) addr = addr.slice(7);
  const port = (req.socket && req.socket.localPort) || '';
  const isV4 = /^\d+\.\d+\.\d+\.\d+$/.test(addr) && !addr.startsWith('127.');
  const protocol = req.protocol;
  if (isV4 && port) return { protocol, host: `${addr}:${port}`, ip: addr, port };
  return { protocol, host: req.get('host'), ip: null, port };
}

// GET /files/list?path=<subpath>
router.get('/list', async (req, res) => {
  const base = global.serverState.sharedDir;
  const rawSubPath = req.query.path || '/';
  const fullPath = resolveSafePath(base, rawSubPath);

  if (!fullPath) return res.status(403).json({ error: 'Access denied' });
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Not found' });

  let stat;
  try {
    stat = await fs.promises.stat(fullPath);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to access directory' });
  }

  if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a directory' });

  try {
    const entries = await fs.promises.readdir(fullPath, { withFileTypes: true });
    const subPath = rawSubPath.startsWith('/') ? rawSubPath : '/' + rawSubPath;

    let items = await Promise.all(entries.map(async entry => {
      const name = entry.name || entry;
      const entryPath = path.join(fullPath, name);
      let size = 0;
      let mtime = null;
      let isDir = typeof entry.isDirectory === 'function' ? entry.isDirectory() : false;
      let isFile = typeof entry.isFile === 'function' ? entry.isFile() : false;

      try {
        const s = await fs.promises.stat(entryPath);
        size = s.size;
        mtime = s.mtime ? s.mtime.toISOString() : null;
        isDir = s.isDirectory();
        isFile = s.isFile();
      } catch (_) {}

      const itemRelativePath = path.posix.join(subPath.replace(/\\/g, '/'), name);

      return {
        name,
        type: isDir ? 'dir' : 'file',
        size,
        mtime,
        mimeType: isFile ? (mime.lookup(name) || 'application/octet-stream') : null,
        path: itemRelativePath,
      };
    }));
    
    items = items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ path: subPath, items, total: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /files/download?path=<file>
router.get('/download', (req, res) => {
  const base = global.serverState.sharedDir;
  const filePath = resolveSafePath(base, req.query.path || '');

  if (!filePath) return res.status(403).json({ error: 'Access denied' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) return res.status(400).json({ error: 'Cannot download directory directly. Use /zip' });

  const mimeType = mime.lookup(filePath) || 'application/octet-stream';
  const fileName = path.basename(filePath);
  const fileSize = stat.size;

  const safeFileName = fileName.replace(/\"/g, '');
  const disposition = `attachment; filename="${safeFileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;

  // HTTP Range support for ALL file types (enables resume on disconnect for any download)
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = (end - start) + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': mimeType,
      'Content-Disposition': disposition,
    });

    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('data', chunk => { global.serverState.bytesServed += chunk.length; });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': mimeType,
      'Content-Disposition': disposition,
      'Accept-Ranges': 'bytes',
    });
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => { global.serverState.bytesServed += chunk.length; });
    stream.pipe(res);
  }
});

// GET /files/playlist.m3u?path=<file|folder>[&recursive=1] — in-memory M3U (nothing written to disk).
// A folder becomes a playlist of its audio/video files in natural order (01, 02, … 10).
// When a PIN is enabled every entry carries its own short-lived, path-bound token — never the PIN.
router.get('/playlist.m3u', (req, res) => {
  const base = global.serverState.sharedDir;
  const target = resolveSafePath(base, req.query.path || '');
  if (!target || !fs.existsSync(target)) return res.status(404).end();

  const rel = auth.normPath(req.query.path || '');
  const entries = [];
  if (fs.statSync(target).isDirectory()) {
    collectMedia(target, rel, req.query.recursive === '1', 0, entries);
  } else {
    entries.push({ rel, title: path.basename(target).replace(/\.[^.]+$/, '') });
  }
  if (!entries.length) return res.status(404).type('text/plain').send('No audio or video files here.');

  const { protocol, host } = reachableOrigin(req);
  const pinOn = global.serverState.pinEnabled && global.serverState.pin;
  const lines = ['#EXTM3U'];
  for (const e of entries) {
    const tok = pinOn ? `&t=${auth.signToken('media', auth.MEDIA_TTL, e.rel)}` : '';
    lines.push(`#EXTINF:-1,${e.title.replace(/[\r\n]/g, ' ')}`);
    lines.push(`${protocol}://${host}/files/stream?path=${encodeURIComponent(e.rel)}${tok}`);
  }
  const m3u = lines.join('\n') + '\n';

  res.writeHead(200, {
    'Content-Type': 'audio/x-mpegurl; charset=utf-8',
    'Content-Disposition': 'inline',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(m3u)
  });
  res.end(m3u);
});

// GET /files/addr[?path=<p>] — where VLC should connect right now (used by the client at click time).
// With a path (and a PIN enabled) it also returns path-bound tokens: t → stream that file,
// pt → fetch the playlist for that file/folder. The PIN itself never goes into a VLC link.
router.get('/addr', (req, res) => {
  const o = reachableOrigin(req);
  const out = { protocol: o.protocol, host: o.host };
  if (req.query.path !== undefined && global.serverState.pinEnabled && global.serverState.pin) {
    const rel = auth.normPath(req.query.path);
    out.t = auth.signToken('media', auth.MEDIA_TTL, rel);
    out.pt = auth.signToken('playlist', auth.MEDIA_TTL, rel);
  }
  res.set('Cache-Control', 'no-store');
  res.json(out);
});

// GET /files/setup-vlc.bat — ONE-TIME Windows setup that registers the vlc:// link handler.
// (VLC doesn't register vlc:// itself on desktop.) Not related to media: nothing is saved per song.
router.get('/setup-vlc.bat', (req, res) => {
  const ps1 = [
    'param([string]$u)',
    "$u = $u -replace '^vlc://',''",
    "$u = $u -replace '^(https?)//','$1://'",
    "if ($u -notmatch '^https?://[A-Za-z0-9.\\-:\\[\\]]+/files/stream\\?[^\\s\"]+$') { exit 1 }",
    "$vlc = @(\"$env:ProgramFiles\\VideoLAN\\VLC\\vlc.exe\", \"${env:ProgramFiles(x86)}\\VideoLAN\\VLC\\vlc.exe\") | Where-Object { Test-Path $_ } | Select-Object -First 1",
    "if (-not $vlc) { $d = (Get-ItemProperty 'HKLM:\\Software\\VideoLAN\\VLC' -ErrorAction SilentlyContinue).InstallDir; if ($d) { $vlc = Join-Path $d 'vlc.exe' } }",
    "if (-not $vlc) { exit 2 }",
    "Start-Process -FilePath $vlc -ArgumentList ('\"' + $u + '\"')"
  ].join('\r\n');
  const b64 = Buffer.from(ps1, 'utf16le').toString('base64');
  const bat = [
    '@echo off',
    'setlocal',
    'set "DIR=%LOCALAPPDATA%\\HosterVLC"',
    'if not exist "%DIR%" mkdir "%DIR%"',
    `powershell -NoProfile -Command "$b=[Convert]::FromBase64String('${b64}'); [IO.File]::WriteAllText('%DIR%\\open.ps1',[Text.Encoding]::Unicode.GetString($b),[Text.Encoding]::UTF8)"`,
    'reg add "HKCU\\Software\\Classes\\vlc" /ve /d "URL:VLC Protocol" /f >nul',
    'reg add "HKCU\\Software\\Classes\\vlc" /v "URL Protocol" /d "" /f >nul',
    'reg add "HKCU\\Software\\Classes\\vlc\\shell\\open\\command" /ve /d "\\"powershell.exe\\" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \\"%DIR%\\open.ps1\\" \\"%%1\\"" /f >nul',
    'echo.',
    'echo Done! "Play in VLC" buttons now open VLC directly on this PC.',
    'echo (If your browser asks "Open powershell.exe?", tick "Always allow".)',
    'pause'
  ].join('\r\n');
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': 'attachment; filename="Hoster-VLC-Setup.bat"',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(bat)
  });
  res.end(bat);
});

// GET /files/stream?path=<file> — inline streaming (no download dialog)
router.get('/stream', (req, res) => {
  const base = global.serverState.sharedDir;
  const filePath = resolveSafePath(base, req.query.path || '');

  if (!filePath || !fs.existsSync(filePath)) return res.status(404).end();
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) return res.status(400).end();

  const mimeType = mime.lookup(filePath) || 'application/octet-stream';
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = (end - start) + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': mimeType,
    });
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('data', chunk => { global.serverState.bytesServed += chunk.length; });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
    });
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => { global.serverState.bytesServed += chunk.length; });
    stream.pipe(res);
  }
});

// GET /files/zip?path=<dir> — download directory as zip
router.get('/zip', (req, res) => {
  const base = global.serverState.sharedDir;
  const dirPath = resolveSafePath(base, req.query.path || '/');

  if (!dirPath || !fs.existsSync(dirPath)) return res.status(404).json({ error: 'Not found' });
  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a directory' });

  const isRootDir = (path.resolve(dirPath) === path.resolve(base));
  const dirName = isRootDir ? (path.basename(dirPath) || 'files') : (path.basename(dirPath) || 'folder');
  const safeDirName = dirName.replace(/"/g, '');
  const disposition = `attachment; filename="${safeDirName}.zip"; filename*=UTF-8''${encodeURIComponent(dirName)}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', disposition);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('data', chunk => { global.serverState.bytesServed += chunk.length; });
  archive.on('warning', err => {
    if (err.code === 'ENOENT') {
      console.warn('Archiver warning:', err);
    } else {
      console.error('Archiver warning:', err);
    }
  });
  archive.on('error', err => {
    console.error('Archiver error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.end();
    }
  });

  archive.pipe(res);
  archive.directory(dirPath, isRootDir ? false : dirName);
  archive.finalize();
});

module.exports = router;
