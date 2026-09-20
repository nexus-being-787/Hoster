const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const mime = require('mime-types');
const archiver = require('archiver');

function resolveSafePath(base, reqPath) {
  const decoded = decodeURIComponent(reqPath || '');
  const resolved = path.resolve(base, '.' + decoded);
  if (!resolved.startsWith(path.resolve(base))) {
    return null; // Path traversal attempt
  }
  return resolved;
}

// GET /files/list?path=<subpath>
router.get('/list', (req, res) => {
  const base = global.serverState.sharedDir;
  const subPath = req.query.path || '/';
  const fullPath = resolveSafePath(base, subPath);

  if (!fullPath) return res.status(403).json({ error: 'Access denied' });
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Not found' });

  const stat = fs.statSync(fullPath);
  if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a directory' });

  try {
    const entries = fs.readdirSync(fullPath, { withFileTypes: true });
    const items = entries
      .map(entry => {
        const entryPath = path.join(fullPath, entry.name);
        let size = 0;
        let mtime = null;
        try {
          const s = fs.statSync(entryPath);
          size = s.size;
          mtime = s.mtime.toISOString();
        } catch (_) {}
        return {
          name: entry.name,
          type: entry.isDirectory() ? 'dir' : 'file',
          size,
          mtime,
          mimeType: entry.isFile() ? (mime.lookup(entry.name) || 'application/octet-stream') : null,
          path: path.join(subPath, entry.name).replace(/\\/g, '/'),
        };
      })
      .sort((a, b) => {
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

  // HTTP Range support for media streaming
  const range = req.headers.range;
  if (range && mimeType.startsWith('video/') || (range && mimeType.startsWith('audio/'))) {
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
      'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
      'Accept-Ranges': 'bytes',
    });
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => { global.serverState.bytesServed += chunk.length; });
    stream.pipe(res);
  }
});

// GET /files/stream?path=<file>  — inline streaming (no download dialog)
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

// GET /files/zip?path=<dir>  — download directory as zip
router.get('/zip', (req, res) => {
  const base = global.serverState.sharedDir;
  const dirPath = resolveSafePath(base, req.query.path || '/');

  if (!dirPath || !fs.existsSync(dirPath)) return res.status(404).json({ error: 'Not found' });
  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a directory' });

  const dirName = path.basename(dirPath);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(dirName)}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('data', chunk => { global.serverState.bytesServed += chunk.length; });
  archive.on('error', err => res.status(500).end());
  archive.pipe(res);
  archive.directory(dirPath, dirName);
  archive.finalize();
});

module.exports = router;
