const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

function resolveSafePath(base, reqPath) {
  const decoded = decodeURIComponent(reqPath || '');
  const resolved = path.resolve(base, '.' + decoded);
  if (!resolved.startsWith(path.resolve(base))) return null;
  return resolved;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const base = global.serverState.sharedDir;
    const targetDir = resolveSafePath(base, req.query.path || '/');
    if (!targetDir || !fs.existsSync(targetDir)) {
      return cb(new Error('Invalid upload directory'));
    }
    cb(null, targetDir);
  },
  filename: (req, file, cb) => {
    // Sanitize filename
    const safe = file.originalname.replace(/[^a-zA-Z0-9._\-\s]/g, '_');
    cb(null, safe);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB max
});

// POST /upload?path=<dir>
router.post('/', upload.array('files', 50), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files received' });
  }
  const uploaded = req.files.map(f => ({
    name: f.filename,
    size: f.size,
    path: path.join(req.query.path || '/', f.filename),
  }));

  // Broadcast upload event
  if (global.broadcast) {
    global.broadcast({
      type: 'upload',
      data: { files: uploaded, dir: req.query.path || '/' }
    });
  }
  res.json({ success: true, uploaded });
});

module.exports = router;
