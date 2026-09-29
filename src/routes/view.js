const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const mime = require('mime-types');

function resolveSafePath(base, reqPath) {
  if (!base) return null;
  const safeBase = path.resolve(base);
  const relativePath = (reqPath || '').replace(/^[\/\\]+/, '');
  const resolved = path.resolve(safeBase, relativePath);
  const rel = path.relative(safeBase, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

// ─────────────────────────────────────────────
// GET /view?path=<relative_html_path>
//
// Renders an HTML file from the shared directory.
// Uses a <base> tag so that ALL relative URLs resolve correctly:
//   - script src, link href, img src, etc.
//   - ES module imports (import * as THREE from './three.module.js')
//   - fetch() calls, new Worker(), new URL(import.meta.url), etc.
//   - CSS url() references
// Everything is served through /view-dir/<subpath> which acts as a
// transparent file server rooted at the shared directory.
// ─────────────────────────────────────────────
router.get('/', (req, res) => {
  if (!global.serverState.running || !global.serverState.sharedDir) {
    return res.status(503).send('Server not running or no directory selected.');
  }

  // PIN protection
  if (global.serverState.pinEnabled && global.serverState.pin) {
    const { validatePin } = require('../utils/security');
    const token = req.headers['x-hoster-pin'] || req.query.pin;
    if (!validatePin(token, global.serverState.pin)) {
      return res.status(401).send('PIN required. Please go back and enter the PIN in the file browser first.');
    }
  }

  const reqPath = (req.query.path || '').replace(/^[\/\\]+/, ''); // strip leading slash
  const filePath = resolveSafePath(global.serverState.sharedDir, reqPath);
  if (!filePath) return res.status(403).send('Access denied.');
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found.');

  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) return res.status(400).send('Path is a directory, not an HTML file.');

  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.html' && ext !== '.htm') {
    return res.status(400).send('Only .html and .htm files can be viewed.');
  }

  let html;
  try {
    html = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return res.status(500).send('Failed to read file: ' + err.message);
  }

  // ── Build <base> href ──────────────────────────────────────────────────────
  // The base href points to the directory containing the HTML file, served
  // through /view-dir/, so ALL relative URLs (including JS module imports,
  // fetch calls, Workers, etc.) resolve correctly without any regex rewriting.
  //
  // Example:
  //   HTML file: games/threejs-game/index.html
  //   fileDir:   games/threejs-game/
  //   base href: /view-dir/games/threejs-game/
  //
  //   import * as THREE from './three.module.js'
  //   → resolves to /view-dir/games/threejs-game/three.module.js  ✓
  //
  //   fetch('../assets/texture.png')
  //   → resolves to /view-dir/games/assets/texture.png             ✓
  const fileDir = path.dirname(reqPath).replace(/\\/g, '/');
  const basePath = fileDir === '.' || fileDir === ''
    ? '/view-dir/'
    : `/view-dir/${fileDir}/`;

  const baseTag = `<base href="${basePath}">`;

  // ── Inject <base> tag ──────────────────────────────────────────────────────
  // Must be the FIRST element inside <head> (before any other link/script).
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/(<head[^>]*>)/i, `$1\n  ${baseTag}`);
  } else if (/<html[^>]*>/i.test(html)) {
    html = html.replace(/(<html[^>]*>)/i, `$1\n<head>${baseTag}</head>`);
  } else {
    html = `<head>${baseTag}</head>\n` + html;
  }

  // ── Inject floating "Back to Files" toolbar ────────────────────────────────
  const toolbar = `
<style>
  #__hoster_toolbar {
    position: fixed;
    top: 0; left: 0; right: 0;
    z-index: 2147483647;
    background: rgba(8,9,15,0.88);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border-bottom: 1px solid rgba(0,229,255,0.18);
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    box-shadow: 0 2px 20px rgba(0,0,0,0.5);
    font-family: system-ui, sans-serif;
    transition: transform 0.3s ease;
    box-sizing: border-box;
  }
  #__hoster_toolbar.collapsed { transform: translateY(-100%); }
  #__hoster_back_btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: rgba(0,229,255,0.12);
    border: 1px solid rgba(0,229,255,0.35);
    color: #00e5ff;
    font-size: 0.85rem;
    font-weight: 600;
    padding: 7px 14px;
    border-radius: 10px;
    cursor: pointer;
    text-decoration: none;
    white-space: nowrap;
    font-family: inherit;
  }
  #__hoster_filename {
    flex: 1;
    color: rgba(240,240,255,0.55);
    font-size: 0.78rem;
    font-family: monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  #__hoster_toggle {
    background: transparent;
    border: 1px solid rgba(255,255,255,0.12);
    color: rgba(255,255,255,0.4);
    width: 28px; height: 28px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    padding: 0;
  }
  /* Peek tab shown when toolbar is collapsed */
  #__hoster_peek {
    position: fixed;
    top: 0; left: 16px;
    z-index: 2147483647;
    background: rgba(8,9,15,0.88);
    border: 1px solid rgba(0,229,255,0.25);
    border-top: none;
    border-radius: 0 0 8px 8px;
    padding: 4px 10px;
    color: #00e5ff;
    font-size: 0.75rem;
    font-family: system-ui, sans-serif;
    cursor: pointer;
    display: none;
    backdrop-filter: blur(10px);
  }
  body { padding-top: 52px !important; box-sizing: border-box; }
  body.toolbar-hidden { padding-top: 0 !important; }
</style>

<div id="__hoster_toolbar">
  <a id="__hoster_back_btn" href="/">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
    </svg>
    Back to Files
  </a>
  <span id="__hoster_filename">${path.basename(filePath)}</span>
  <button id="__hoster_toggle" title="Hide toolbar">▲</button>
</div>
<div id="__hoster_peek" onclick="__hosterShowToolbar()">▼ Hoster</div>

<script>
(function() {
  var toolbar = document.getElementById('__hoster_toolbar');
  var peek = document.getElementById('__hoster_peek');
  var toggle = document.getElementById('__hoster_toggle');
  var body = document.body;

  toggle.onclick = function() {
    toolbar.classList.add('collapsed');
    peek.style.display = 'block';
    body.classList.add('toolbar-hidden');
  };

  window.__hosterShowToolbar = function() {
    toolbar.classList.remove('collapsed');
    peek.style.display = 'none';
    body.classList.remove('toolbar-hidden');
  };
})();
</script>`;

  if (/<body[^>]*>/i.test(html)) {
    html = html.replace(/(<body[^>]*>)/i, '$1\n' + toolbar);
  } else {
    html = toolbar + html;
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.send(html);
});

// ─────────────────────────────────────────────
// GET /view-dir/*
//
// Transparent file server for the shared directory.
// This is what the <base> tag points to, so all relative URLs from a
// viewed HTML file (including JS module imports, fetch, Workers, textures,
// audio, etc.) resolve here automatically.
//
// e.g. /view-dir/games/threejs-game/three.module.js
//   → serves sharedDir/games/threejs-game/three.module.js
// ─────────────────────────────────────────────
router.get('/dir/*', (req, res) => {
  if (!global.serverState.running || !global.serverState.sharedDir) {
    return res.status(503).end();
  }

  // req.params[0] is everything after /view-dir/
  const subPath = req.params[0] || '';
  const filePath = resolveSafePath(global.serverState.sharedDir, subPath);

  if (!filePath) return res.status(403).end();
  if (!fs.existsSync(filePath)) return res.status(404).end();

  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) return res.status(400).end();

  const mimeType = mime.lookup(filePath) || 'application/octet-stream';

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', stat.size);
  // Allow SharedArrayBuffer (needed by some Three.js features like Draco decoder)
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'public, max-age=60');

  const stream = fs.createReadStream(filePath);
  stream.on('data', chunk => { global.serverState.bytesServed += chunk.length; });
  stream.pipe(res);
});

// ─────────────────────────────────────────────
// GET /view-asset?path=<relative_path>  (kept for backward compat)
// ─────────────────────────────────────────────
router.get('/asset', (req, res) => {
  if (!global.serverState.running || !global.serverState.sharedDir) {
    return res.status(503).end();
  }

  const filePath = resolveSafePath(global.serverState.sharedDir, req.query.path || '');
  if (!filePath) return res.status(403).end();
  if (!fs.existsSync(filePath)) return res.status(404).end();

  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) return res.status(400).end();

  const mimeType = mime.lookup(filePath) || 'application/octet-stream';

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'public, max-age=60');

  const stream = fs.createReadStream(filePath);
  stream.on('data', chunk => { global.serverState.bytesServed += chunk.length; });
  stream.pipe(res);
});

module.exports = router;
