const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const mime = require('mime-types');
const archiver = require('archiver');

function resolveSafePath(base, reqPath) {
  if (!base) return null;
  const safeBase = path.resolve(base);
  const relativePath = (reqPath || '').replace(/^[\/\\]+/, '');
  const resolved = path.resolve(safeBase, relativePath);

  const rel = path.relative(safeBase, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return null; // Path traversal attempt
  }
  return resolved;
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

// GET /files/playlist.m3u?path=<file> — generates an M3U playlist for external players (VLC desktop)
router.get('/playlist.m3u', (req, res) => {
  const base = global.serverState.sharedDir;
  const filePath = resolveSafePath(base, req.query.path || '');

  if (!filePath || !fs.existsSync(filePath)) return res.status(404).end();
  
  const fileName = path.basename(filePath);
  const safeFileName = fileName.replace(/"/g, '');
  const host = req.get('host');
  const protocol = req.protocol;
  const streamUrl = `${protocol}://${host}/files/stream?path=${encodeURIComponent(req.query.path || '')}`;
  
  const m3u = `#EXTM3U\n#EXTINF:-1,${fileName}\n${streamUrl}\n`;
  
  res.writeHead(200, {
    'Content-Type': 'audio/x-mpegurl',
    'Content-Disposition': `attachment; filename="${safeFileName}.m3u"`,
    'Content-Length': Buffer.byteLength(m3u)
  });
  res.end(m3u);
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
