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
// Renders an HTML file from the shared directory with:
//   - relative asset URLs rewritten to /view-asset?path=...
//   - relative HTML links rewritten to /view?path=...
//   - an injected floating "Back" toolbar
// ─────────────────────────────────────────────
router.get('/', (req, res) => {
  if (!global.serverState.running || !global.serverState.sharedDir) {
    return res.status(503).send('Server not running or no directory selected.');
  }

  // PIN protection — same as file routes
  if (global.serverState.pinEnabled && global.serverState.pin) {
    const { validatePin } = require('../utils/security');
    const token = req.headers['x-hoster-pin'] || req.query.pin;
    if (!validatePin(token, global.serverState.pin)) {
      return res.status(401).send('PIN required. Please go back and enter the PIN in the file browser first.');
    }
  }

  const filePath = resolveSafePath(global.serverState.sharedDir, req.query.path || '');
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

  // The directory of the HTML file (relative to shared root), used to resolve relative asset paths
  const fileDir = path.dirname(req.query.path || '').replace(/\\/g, '/');
  const safeFileDir = fileDir === '.' ? '' : fileDir;

  // ── Rewrite relative URLs inside the HTML ──────────────────────────────────
  // We handle: src="...", href="...", url('...') in inline styles
  // Rules:
  //   - absolute URLs (http://, https://, //, data:, #) → leave alone
  //   - URLs starting with / (root-relative) → rewrite to /view-asset?path=<stripped>
  //   - relative URLs → resolve against the HTML file's directory, rewrite to /view-asset?path=<resolved>
  //   - Exception: href on <a> tags pointing to .html/.htm → rewrite to /view?path=...

  function resolveAssetPath(url, forLink) {
    if (!url) return url;
    const trimmed = url.trim();
    // Leave absolute / data / hash URLs as-is
    if (/^(https?:|\/\/|data:|#|mailto:|tel:)/i.test(trimmed)) return trimmed;

    let relPath;
    if (trimmed.startsWith('/')) {
      // Root-relative → strip leading slash
      relPath = trimmed.replace(/^\/+/, '');
    } else {
      // Relative → resolve against file directory
      relPath = safeFileDir ? safeFileDir + '/' + trimmed : trimmed;
      // Normalize: remove ./ and handle simple ../
      relPath = relPath.split('/').reduce((acc, part) => {
        if (part === '.' || part === '') return acc;
        if (part === '..') { acc.pop(); return acc; }
        acc.push(part);
        return acc;
      }, []).join('/');
    }

    // Detect if this is an HTML link (for <a href>)
    const isHtml = forLink && /\.(html|htm)(\?.*)?$/i.test(relPath.split('?')[0]);
    if (isHtml) {
      return '/view?path=' + encodeURIComponent(relPath);
    }

    return '/view-asset?path=' + encodeURIComponent(relPath);
  }

  // Rewrite src="..." and href="..." attributes
  html = html.replace(/(\s(?:src|href))\s*=\s*(['"])(.*?)\2/gi, (match, attr, quote, url) => {
    const isHref = attr.trim().toLowerCase() === 'href';
    const rewritten = resolveAssetPath(url, isHref);
    return `${attr}=${quote}${rewritten}${quote}`;
  });

  // Rewrite url(...) in inline styles
  html = html.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, url) => {
    const rewritten = resolveAssetPath(url, false);
    return `url(${quote}${rewritten}${quote})`;
  });

  // ── Inject back-button toolbar ─────────────────────────────────────────────
  const backPath = '/?_t=' + Date.now(); // forces the file browser to re-render
  const toolbar = `
<style>
  #__hoster_toolbar {
    position: fixed;
    top: 0; left: 0; right: 0;
    z-index: 2147483647;
    background: rgba(8,9,15,0.92);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border-bottom: 1px solid rgba(0,229,255,0.18);
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    box-shadow: 0 2px 20px rgba(0,0,0,0.5);
    font-family: 'Outfit', system-ui, sans-serif;
    transition: transform 0.3s ease;
  }
  #__hoster_toolbar.hidden { transform: translateY(-100%); }
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
    transition: all 0.2s;
    white-space: nowrap;
    font-family: inherit;
  }
  #__hoster_back_btn:hover {
    background: rgba(0,229,255,0.22);
    box-shadow: 0 0 14px rgba(0,229,255,0.3);
    color: #fff;
  }
  #__hoster_back_btn svg { flex-shrink: 0; }
  #__hoster_filename {
    flex: 1;
    color: rgba(240,240,255,0.6);
    font-size: 0.82rem;
    font-family: 'JetBrains Mono', monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  #__hoster_toggle_btn {
    background: transparent;
    border: 1px solid rgba(255,255,255,0.12);
    color: rgba(255,255,255,0.4);
    width: 28px; height: 28px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 1rem;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    transition: all 0.2s;
  }
  #__hoster_toggle_btn:hover { color: #fff; border-color: rgba(255,255,255,0.3); }
  body { padding-top: 52px !important; }
</style>
<div id="__hoster_toolbar">
  <a id="__hoster_back_btn" href="${backPath}">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
    </svg>
    Back to Files
  </a>
  <span id="__hoster_filename">${path.basename(filePath)}</span>
  <button id="__hoster_toggle_btn" title="Hide toolbar" onclick="(function(){var t=document.getElementById('__hoster_toolbar');t.classList.toggle('hidden');this.textContent=t.classList.contains('hidden')?'▼':'▲';}).call(this)">▲</button>
</div>`;

  // Insert toolbar just after <body> tag (or prepend to html)
  if (/<body[^>]*>/i.test(html)) {
    html = html.replace(/(<body[^>]*>)/i, '$1\n' + toolbar);
  } else {
    html = toolbar + html;
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.send(html);
});

// ─────────────────────────────────────────────
// GET /view-asset?path=<relative_path>
// Serves any static asset from the shared directory that's referenced by a viewed HTML file.
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
  res.setHeader('Cache-Control', 'public, max-age=60');

  const stream = fs.createReadStream(filePath);
  stream.on('data', chunk => { global.serverState.bytesServed += chunk.length; });
  stream.pipe(res);
});

module.exports = router;
