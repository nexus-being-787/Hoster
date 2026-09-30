// ─────────────────────────────────────────────
// PDF Viewer Route
// GET /pdf?path=<relative_pdf_path>[&pin=<pin>]
// ─────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { validatePin } = require('../utils/security');

function resolveSafePath(base, reqPath) {
  if (!base) return null;
  const safeBase = path.resolve(base);
  const decoded = decodeURIComponent(reqPath || '');
  const relativePath = decoded.replace(/^[\/\\]+/, '');
  const resolved = path.resolve(safeBase, relativePath);
  const rel = path.relative(safeBase, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

// GET /pdf?path=<file>[&pin=<pin>]
// Serves an embedded PDF reader using the browser's native PDF rendering.
// Uses <embed> so the browser's built-in PDF engine handles rendering, zoom,
// scroll, text selection etc. — no external libraries needed.
router.get('/', (req, res) => {
  const { sharedDir, pinEnabled, pin: serverPin } = global.serverState;

  // PIN check
  if (pinEnabled) {
    const clientPin = req.query.pin || req.headers['x-pin'];
    if (!validatePin(clientPin, serverPin)) {
      return res.status(403).send(`<!DOCTYPE html>
<html><head><title>PIN Required</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { margin:0; display:flex; align-items:center; justify-content:center; min-height:100vh;
         background:#0a0a12; color:#e0e0f0; font-family:sans-serif; }
  .card { background:#12121e; border:1px solid #1e1e3a; border-radius:16px; padding:32px;
           text-align:center; max-width:280px; width:90%; }
  input { width:100%; padding:10px; margin:12px 0; border-radius:8px; background:#1a1a2e;
          border:1px solid #2a2a4a; color:#e0e0f0; font-size:1rem; box-sizing:border-box; }
  button { width:100%; padding:12px; background:#4f46e5; color:#fff; border:none;
           border-radius:8px; cursor:pointer; font-size:1rem; }
</style></head><body>
<div class="card">
  <div style="font-size:2rem">🔐</div>
  <h2>PIN Required</h2>
  <input type="password" id="pinInput" placeholder="Enter PIN" maxlength="6" inputmode="numeric"/>
  <button onclick="submitPin()">Unlock</button>
</div>
<script>
function submitPin() {
  const pin = document.getElementById('pinInput').value;
  const url = new URL(window.location.href);
  url.searchParams.set('pin', pin);
  window.location.href = url.toString();
}
document.getElementById('pinInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitPin();
});
</script></body></html>`);
    }
  }

  const filePath = resolveSafePath(sharedDir, req.query.path || '');
  if (!filePath) return res.status(403).send('Access denied');
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');

  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) return res.status(400).send('Not a file');

  const fileName = path.basename(filePath);
  const pinParam = req.query.pin ? `&pin=${encodeURIComponent(req.query.pin)}` : '';

  // The PDF is served via /view-dir/* (the existing transparent file server)
  // We just build the relative path from sharedDir to the file
  const rel = path.relative(sharedDir, filePath).replace(/\\/g, '/');
  const pdfSrc = `/view-dir/${encodeURIComponent(rel)}${pinParam ? '?pin=' + encodeURIComponent(req.query.pin) : ''}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
  <title>${fileName.replace(/</g,'&lt;')} — PDF Viewer</title>
  <style>
    *,*::before,*::after { box-sizing:border-box; margin:0; padding:0; }
    html,body { height:100%; background:#1a1a1a; color:#e0e0e0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }

    /* ── Toolbar ── */
    .toolbar {
      position: fixed; top: 0; left: 0; right: 0; z-index: 100;
      height: 52px;
      background: rgba(12,12,20,0.97);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid rgba(255,255,255,0.08);
      display: flex; align-items: center; gap: 12px; padding: 0 16px;
      transition: transform 0.25s ease;
    }
    .toolbar.collapsed { transform: translateY(-100%); }

    .back-btn {
      display: flex; align-items: center; gap: 8px;
      background: rgba(79,70,229,0.15); border: 1px solid rgba(79,70,229,0.3);
      color: #a5b4fc; border-radius: 8px; padding: 6px 14px;
      font-size: 0.85rem; font-weight: 500; cursor: pointer;
      text-decoration: none; transition: background 0.15s;
    }
    .back-btn:hover { background: rgba(79,70,229,0.25); }
    .back-btn svg { width: 16px; height: 16px; }

    .file-name-label {
      flex: 1; font-size: 0.82rem; color: rgba(240,240,255,0.5);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    .collapse-btn {
      background: none; border: 1px solid rgba(255,255,255,0.1);
      color: rgba(255,255,255,0.4); border-radius: 6px;
      padding: 4px 10px; font-size: 0.75rem; cursor: pointer;
      transition: border-color 0.15s, color 0.15s;
    }
    .collapse-btn:hover { border-color: rgba(255,255,255,0.3); color: rgba(255,255,255,0.7); }

    /* Peek tab — shows when toolbar is collapsed */
    .peek-tab {
      position: fixed; top: 0; left: 50%; transform: translateX(-50%);
      z-index: 101; background: rgba(12,12,20,0.92);
      border: 1px solid rgba(255,255,255,0.1); border-top: none;
      border-radius: 0 0 10px 10px; padding: 4px 16px;
      font-size: 0.72rem; color: rgba(240,240,255,0.45); cursor: pointer;
      display: none;
    }
    .toolbar.collapsed ~ .peek-tab { display: block; }

    /* ── PDF embed ── */
    .pdf-wrapper {
      position: fixed; top: 52px; left: 0; right: 0; bottom: 0;
      background: #1a1a1a;
      transition: top 0.25s ease;
    }
    .pdf-wrapper.fullscreen { top: 0; }

    embed, iframe {
      width: 100%; height: 100%;
      border: none; display: block;
    }

    /* Fallback message */
    .fallback {
      display: none; flex-direction: column; align-items: center; justify-content: center;
      height: 100%; text-align: center; padding: 32px; gap: 16px;
    }
    .fallback svg { opacity: 0.3; }
    .fallback p { color: rgba(240,240,255,0.5); font-size: 0.9rem; }
    .fallback a { color: #818cf8; text-decoration: none; font-weight: 500; }
  </style>
</head>
<body>
  <div class="toolbar" id="toolbar">
    <a class="back-btn" href="javascript:history.length>1?history.back():window.location='/'">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="15 18 9 12 15 6"/>
      </svg>
      Back
    </a>
    <span class="file-name-label" title="${fileName.replace(/"/g,'&quot;')}">${fileName.replace(/</g,'&lt;')}</span>
    <button class="collapse-btn" id="collapseBtn" title="Hide toolbar">Hide</button>
  </div>
  <div class="peek-tab" id="peekTab" title="Show toolbar">▲ Menu</div>

  <div class="pdf-wrapper" id="pdfWrapper">
    <embed
      id="pdfEmbed"
      src="${pdfSrc}"
      type="application/pdf"
      onerror="showFallback()"
    />
    <div class="fallback" id="fallback">
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <p>Your browser couldn't render the PDF inline.</p>
      <p><a href="${pdfSrc}" download="${fileName.replace(/"/g,'&quot;')}">Download PDF</a> and open with your PDF app.</p>
    </div>
  </div>

  <script>
    const toolbar = document.getElementById('toolbar');
    const pdfWrapper = document.getElementById('pdfWrapper');
    const collapseBtn = document.getElementById('collapseBtn');
    const peekTab = document.getElementById('peekTab');

    collapseBtn.addEventListener('click', () => {
      toolbar.classList.add('collapsed');
      pdfWrapper.classList.add('fullscreen');
    });
    peekTab.addEventListener('click', () => {
      toolbar.classList.remove('collapsed');
      pdfWrapper.classList.remove('fullscreen');
    });

    function showFallback() {
      document.getElementById('pdfEmbed').style.display = 'none';
      document.getElementById('fallback').style.display = 'flex';
    }

    // Some browsers fire onerror inconsistently on embed — also check after load
    setTimeout(() => {
      const embed = document.getElementById('pdfEmbed');
      if (embed && (embed.clientHeight === 0 || embed.clientWidth === 0)) showFallback();
    }, 2000);
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
});

module.exports = router;
