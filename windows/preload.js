/**
 * Hoster Desktop — Preload Script
 *
 * Runs in the renderer (host-ui) context with access to Node.js APIs.
 * Exposes a safe IPC bridge and intercepts the browse button to use
 * the native OS folder picker dialog.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe API to the renderer (host-ui page)
contextBridge.exposeInMainWorld('electronAPI', {
  /** Opens the native OS folder picker and returns the selected path or null */
  pickFolder: function() {
    return ipcRenderer.invoke('pick-folder');
  },
  /** Platform string: 'win32' | 'linux' | 'darwin' */
  platform: process.platform,
});

// ── Intercept Browse Button ────────────────────────────────────────────
// The host-ui has a "Browse" button (#browseBtn) that opens an in-app
// folder modal. On desktop, we replace it with the native OS dialog.
window.addEventListener('load', function() {
  function patchBrowseButton() {
    var browseBtn = document.getElementById('browseBtn');
    var dirPathInput = document.getElementById('dirPath');
    if (!browseBtn || !dirPathInput) return false;

    browseBtn.addEventListener('click', async function(e) {
      e.stopImmediatePropagation();
      e.preventDefault();

      var result = await window.electronAPI.pickFolder();
      if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
        dirPathInput.value = result.filePaths[0];
        // Fire input event so the host-ui updates its state
        dirPathInput.dispatchEvent(new Event('input', { bubbles: true }));
        // Also fire change event for any change listeners
        dirPathInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, true); // capture phase — runs before host-ui's own listener

    return true;
  }

  // Try immediately; if the button isn't rendered yet, wait for DOM mutation
  if (!patchBrowseButton()) {
    var observer = new MutationObserver(function() {
      if (patchBrowseButton()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // Fallback: give up after 10s
    setTimeout(function() { observer.disconnect(); }, 10000);
  }

  // ── Desktop tweaks ─────────────────────────────────────────────────
  // Show a small "Desktop" badge in the header so users know it's not mobile
  window.addEventListener('DOMContentLoaded', function() {
    var logo = document.querySelector('.logo-text');
    if (logo && !logo.querySelector('.desktop-badge')) {
      var badge = document.createElement('span');
      badge.className = 'desktop-badge';
      badge.textContent = 'Desktop';
      badge.style.cssText = [
        'font-size:0.6rem',
        'background:rgba(79,70,229,0.25)',
        'color:#a5b4fc',
        'border:1px solid rgba(79,70,229,0.4)',
        'border-radius:4px',
        'padding:2px 6px',
        'margin-left:8px',
        'vertical-align:middle',
        'font-weight:500',
        'letter-spacing:0.05em',
      ].join(';');
      logo.appendChild(badge);
    }
  });
});
