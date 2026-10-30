'use strict';
// Remembers the owner's settings between runs (folder, port, toggles, PIN).
// It deliberately does NOT remember "is sharing" — Hoster never starts sharing by itself.
//
// Stored in <data dir>/config.json (mode 0600) where <data dir> is, in order:
//   $HOSTER_DATA_DIR → the app-private folder on Android (nodejs-mobile) → ~/.hoster
// The file is read defensively: a missing, corrupt or tampered file just yields defaults.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CHECKS = {
  sharedDir: v => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !v.includes('\0'),
  port: v => Number.isInteger(v) && v >= 1 && v <= 65535,
  pinEnabled: v => typeof v === 'boolean',
  pin: v => v === null || (typeof v === 'string' && /^\d{4,8}$/.test(v)),
  uploadEnabled: v => typeof v === 'boolean',
  webdavEnabled: v => typeof v === 'boolean',
  useHttps: v => typeof v === 'boolean',
  preferHostname: v => typeof v === 'boolean',
  customDomain: v => typeof v === 'string' && v.length <= 100 && /^[A-Za-z0-9.-]*$/.test(v),
};

function sanitize(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of Object.keys(CHECKS)) if (k in obj && CHECKS[k](obj[k])) out[k] = obj[k];
  return out;
}

function resolveDir(rnBridge) {
  if (process.env.HOSTER_DATA_DIR) return process.env.HOSTER_DATA_DIR;
  try {
    if (rnBridge && rnBridge.app && typeof rnBridge.app.datadir === 'function') {
      return path.join(rnBridge.app.datadir(), 'hoster');
    }
  } catch (e) { /* fall through */ }
  return path.join(os.homedir(), '.hoster');
}

function create(dir) {
  const file = path.join(dir, 'config.json');
  return {
    file,
    load() {
      try { return sanitize(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { return {}; }
    },
    /** Merge `patch` into the stored settings. Never throws: losing a setting must not crash the server. */
    save(patch) {
      try {
        const merged = sanitize({ ...this.load(), ...patch });
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, file); // atomic: a crash mid-write can't leave a half file
        return merged;
      } catch (e) {
        console.warn('Could not save settings:', e.message);
        return null;
      }
    },
  };
}

module.exports = { create, resolveDir, sanitize };
