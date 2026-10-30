#!/usr/bin/env node
'use strict';
/*
 * Single source of truth: the root src/ and public/ folders.
 * The desktop (linux, windows) and Android (nodejs-mobile) builds each bundle their own copy,
 * so this script mirrors the root into them.
 *
 *   node scripts/sync-copies.js          copy root -> copies (adds, updates, removes stale files)
 *   node scripts/sync-copies.js --check  change nothing; exit 1 if any copy is out of date (used by CI)
 *
 * Only src/ and public/ are mirrored, plus one thing from each target's package.json: every runtime dependency of the
 * root must be listed there with the same version (otherwise the bundled server would crash or silently degrade
 * on a missing module). A target's other files and fields (main.js, scripts, build config, extra deps) are never touched.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TARGETS = ['linux', 'windows', path.join('HosterApp', 'nodejs-assets', 'nodejs-project')];
const MIRRORED = ['src', 'public'];
const IGNORE = new Set(['node_modules', '.DS_Store', 'Thumbs.db']);
const check = process.argv.includes('--check');

function walk(dir, base = dir, out = new Map()) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, base, out);
    else if (ent.isFile()) out.set(path.relative(base, full), full);
  }
  return out;
}

const same = (a, b) => {
  const sa = fs.statSync(a), sb = fs.statSync(b);
  return sa.size === sb.size && fs.readFileSync(a).equals(fs.readFileSync(b));
};

const problems = [];
let changed = 0;
for (const target of TARGETS) {
  for (const sub of MIRRORED) {
    const from = walk(path.join(ROOT, sub));
    const toDir = path.join(ROOT, target, sub);
    const to = walk(toDir);

    for (const [rel, src] of from) {
      const dst = path.join(toDir, rel);
      if (!to.has(rel) || !same(src, dst)) {
        problems.push(`${to.has(rel) ? 'outdated' : 'missing '}  ${path.join(target, sub, rel)}`);
        if (!check) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); changed++; }
      }
    }
    for (const [rel, dst] of to) {
      if (!from.has(rel)) {
        problems.push(`stale    ${path.join(target, sub, rel)}`);
        if (!check) { fs.rmSync(dst); changed++; }
      }
    }
  }
}

// ── dependency parity: root runtime deps must exist, at the same version, in every target ──
function sortedLike(original, obj) { // keep a package.json's dependencies alphabetical if it already was
  const keys = Object.keys(original);
  const wasSorted = keys.every((k, i) => i === 0 || keys[i - 1] <= k);
  return wasSorted ? Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : 1))) : obj;
}
// Edit ONLY the "dependencies" block of a package.json, as text, so hand-formatted parts of the file stay untouched.
function rewriteDependencies(text, deps) {
  const key = text.indexOf('"dependencies"');
  const open = text.indexOf('{', key);
  const close = text.indexOf('}', open); // dependencies hold no nested objects
  const inner = text.slice(open + 1, close);
  const entryIndent = (inner.match(/\n([ \t]+)"/) || [null, '    '])[1];
  const lineStart = text.lastIndexOf('\n', close) + 1;
  const closeIndent = text.slice(lineStart, close).match(/^[ \t]*/)[0];
  const body = Object.entries(deps).map(([k, v]) => `${entryIndent}${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n');
  return text.slice(0, open + 1) + '\n' + body + '\n' + closeIndent + text.slice(close);
}

const rootDeps = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies || {};
for (const target of TARGETS) {
  const file = path.join(ROOT, target, 'package.json');
  if (!fs.existsSync(file)) continue;
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const deps = { ...(pkg.dependencies || {}) };
  let touched = false;
  for (const [name, version] of Object.entries(rootDeps)) {
    if (deps[name] !== version) {
      problems.push(`${deps[name] ? 'dep version' : 'dep missing'}  ${path.join(target, 'package.json')}: ${name} ${deps[name] ? deps[name] + ' → ' : '→ '}${version}`);
      deps[name] = version;
      touched = true;
    }
  }
  if (touched && !check) {
    fs.writeFileSync(file, rewriteDependencies(fs.readFileSync(file, 'utf8'), sortedLike(pkg.dependencies || {}, deps)));
    changed++;
  }
}

if (check) {
  if (problems.length) {
    console.error('Copies are out of sync with src/ and public/:\n  ' + problems.join('\n  '));
    console.error('\nRun `npm run sync` and commit the result.');
    process.exit(1);
  }
  console.log('All copies are in sync.');
} else {
  console.log(changed ? `Synced ${changed} file(s).` : 'Already in sync.');
}
