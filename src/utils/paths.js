'use strict';
const path = require('path');

/**
 * Resolve a client-supplied path inside the shared folder `base`.
 * Returns null for anything that would escape it (`..`, absolute paths, encoded variants — those are
 * decoded by Express before they get here).
 * Note: this is a lexical check; a symlink *inside* the share that points elsewhere is followed.
 */
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

module.exports = { resolveSafePath };
