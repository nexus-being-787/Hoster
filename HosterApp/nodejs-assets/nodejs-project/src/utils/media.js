'use strict';
// Shared helpers for finding audio/video inside the shared folder (folder playlists, radio queue).
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');

const MAX_ITEMS = 2000;
const naturalSort = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

function isMediaName(name) {
  const m = mime.lookup(name);
  return !!m && (m.startsWith('audio/') || m.startsWith('video/'));
}

/**
 * Collect audio/video files of `dir` in natural order.
 * `relDir` is the share-relative path of `dir` ('/' for the root); entries get share-relative `rel` paths.
 * Hidden files and symlinks are skipped (a symlink could point outside the share).
 */
function collectMedia(dir, relDir, recursive, depth, out, limit = MAX_ITEMS) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  ents.sort((x, y) => naturalSort(x.name, y.name));
  const folders = [];
  for (const ent of ents) {
    if (out.length >= limit) return;
    if (ent.name.startsWith('.') || ent.isSymbolicLink()) continue;
    const rel = relDir === '/' ? '/' + ent.name : relDir + '/' + ent.name;
    if (ent.isDirectory()) { if (recursive && depth < 5) folders.push([path.join(dir, ent.name), rel]); }
    else if (ent.isFile() && isMediaName(ent.name)) out.push({ rel, title: ent.name.replace(/\.[^.]+$/, '') });
  }
  for (const [d, r] of folders) collectMedia(d, r, recursive, depth + 1, out, limit);
}

module.exports = { MAX_ITEMS, naturalSort, isMediaName, collectMedia };
