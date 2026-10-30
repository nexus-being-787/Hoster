'use strict';
// Central access control for the share port:
//  - PIN check with brute-force lockout (a 4-digit PIN has only 10,000 combinations)
//  - short-lived, path-bound signed tokens, so media/playlist links given to VLC never contain the PIN
//  - a viewer cookie so the HTML viewer's sub-resources (/view-dir/*) work after one PIN check
// Tokens are signed with a per-process random secret: they stop working when the server restarts.

const crypto = require('crypto');
const { validatePin } = require('./security');

const SECRET = crypto.randomBytes(32);

const MAX_FAILS = 5; // wrong PINs…
const WINDOW_MS = 10 * 60 * 1000; // …within 10 minutes…
const LOCK_MS = 5 * 60 * 1000; // …lock that IP out for 5 minutes
const MEDIA_TTL = 24 * 3600; // a long movie must not expire mid-playback
const VIEW_TTL = 12 * 3600;
const SESSION_TTL = 12 * 3600;

const fails = new Map(); // ip -> { count, first, lockedUntil }

function ipOf(req) {
  return String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
}
function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1';
}

// Canonical form of a shared-folder path so a token matches however the client spelled it.
function normPath(p) {
  return '/' + String(p || '').replace(/\\/g, '/').split('/').filter(Boolean).join('/');
}

function mac(data) {
  return crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
}

function signToken(scope, ttlSec, bind = '') {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return `${exp}.${mac(`${scope}|${bind}|${exp}`)}`;
}

function verifyToken(scope, token, bind = '') {
  if (typeof token !== 'string') return false;
  const i = token.indexOf('.');
  if (i < 1) return false;
  const exp = Number(token.slice(0, i));
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  const a = Buffer.from(token.slice(i + 1));
  const b = Buffer.from(mac(`${scope}|${bind}|${exp}`));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getCookie(req, name) {
  const h = req.headers && req.headers.cookie;
  if (!h) return null;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function lockedForMs(ip) {
  const e = fails.get(ip);
  if (!e || !e.lockedUntil) return 0;
  const left = e.lockedUntil - Date.now();
  if (left <= 0) { fails.delete(ip); return 0; }
  return left;
}
function recordFail(ip) {
  const now = Date.now();
  let e = fails.get(ip);
  if (!e || now - e.first > WINDOW_MS) e = { count: 0, first: now, lockedUntil: 0 };
  e.count += 1;
  if (e.count >= MAX_FAILS) e.lockedUntil = now + LOCK_MS;
  fails.set(ip, e);
}

// Forget stale entries so the map can't grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of fails) if (now - e.first > WINDOW_MS && (!e.lockedUntil || e.lockedUntil < now)) fails.delete(ip);
}, 60 * 1000).unref();

/**
 * Check the PIN for this request.
 * @returns {{ok:true, viaPin?:boolean} | {ok:false, status:401|429, retryAfter?:number}}
 * Only wrong PINs that were actually *supplied* count as failures (a bare page load is not a guess).
 * The owner's own device (loopback) is never locked out.
 */
function check(req, state, suppliedOverride) {
  if (!state.pinEnabled || !state.pin) return { ok: true };
  const ip = ipOf(req);
  const owner = isLoopback(ip);
  const supplied = suppliedOverride !== undefined
    ? suppliedOverride
    : req.headers['x-hoster-pin'] || req.headers['x-pin'] || req.query.pin;

  if (!owner) {
    const wait = lockedForMs(ip);
    if (wait) return { ok: false, status: 429, retryAfter: Math.ceil(wait / 1000) };
  }
  if (validatePin(supplied, state.pin)) {
    if (!owner) fails.delete(ip);
    return { ok: true, viaPin: true };
  }
  if (supplied && !owner) {
    recordFail(ip);
    const wait = lockedForMs(ip);
    if (wait) return { ok: false, status: 429, retryAfter: Math.ceil(wait / 1000) };
  }
  return { ok: false, status: 401 };
}

/** Password from an `Authorization: Basic` header (WebDAV clients can't fill in a PIN form). */
function basicPassword(req) {
  const h = req.headers && req.headers.authorization;
  if (!h || !/^basic /i.test(h)) return '';
  try {
    const decoded = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    return i < 0 ? decoded : decoded.slice(i + 1); // the username is ignored
  } catch (e) { return ''; }
}

/**
 * After one successful PIN check the browser gets a session cookie, so the PIN never has to appear in a URL
 * (ZIP download, HTML/PDF viewer, in-page media). HttpOnly: page scripts can't read it; SameSite=Strict: other
 * sites can't make the browser send it. Signed with the per-process secret, so it dies when the server restarts
 * (the page then re-authenticates with the PIN it still holds in memory).
 */
function hasSession(req) {
  return verifyToken('session', getCookie(req, 'hoster_session'));
}

function setSessionCookie(req, res) {
  const secure = req.secure || req.protocol === 'https' ? '; Secure' : '';
  res.append('Set-Cookie', `hoster_session=${signToken('session', SESSION_TTL)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL}${secure}`);
}

/** For routes that guard themselves: PIN not required, or a valid session, or a correct PIN (with lockout). */
function authorized(req, state) {
  if (!state.pinEnabled || !state.pin) return { ok: true };
  if (hasSession(req)) return { ok: true };
  return check(req, state);
}

function setViewCookies(res) {
  const t = signToken('view', VIEW_TTL);
  const attrs = `; HttpOnly; SameSite=Lax; Max-Age=${VIEW_TTL}`;
  res.append('Set-Cookie', `hoster_view=${t}; Path=/view-dir${attrs}`);
  res.append('Set-Cookie', `hoster_view=${t}; Path=/view-asset${attrs}`);
}

/** Express middleware mounted on /files, /view, /view-dir, /view-asset and /upload. */
function middleware(state) {
  return function pinGuard(req, res, next) {
    if (!state.pinEnabled || !state.pin) return next();
    const base = req.baseUrl;
    const p = req.path;
    const q = req.query;

    // The Windows setup script contains nothing private.
    if (base === '/files' && p === '/setup-vlc.bat') return next();

    // Path-bound tokens (what VLC links carry instead of the PIN)
    if (base === '/files' && p === '/stream' && verifyToken('media', q.t, normPath(q.path))) return next();
    if (base === '/files' && p === '/playlist.m3u' && verifyToken('playlist', q.t, normPath(q.path))) return next();

    // HTML viewer sub-resources: cookie set after one successful /view
    if ((base === '/view-dir' || base === '/view-asset') && verifyToken('view', getCookie(req, 'hoster_view'))) return next();

    // A valid session is as good as the PIN (and is not a guess, so it ignores the lockout)
    if (hasSession(req)) return next();

    const r = check(req, state);
    if (r.ok) {
      if (r.viaPin) setSessionCookie(req, res);
      if (base === '/view' && r.viaPin) setViewCookies(res);
      return next();
    }
    if (r.status === 429) {
      res.set('Retry-After', String(r.retryAfter));
      return res.status(429).json({ error: 'Too many wrong PIN attempts. Try again later.', retryAfter: r.retryAfter });
    }
    return res.status(401).json({ error: 'Invalid or missing PIN' });
  };
}

module.exports = {
  check, authorized, hasSession, setSessionCookie, basicPassword, middleware, signToken, verifyToken, normPath, isLoopback, ipOf,
  MEDIA_TTL, _resetFailsForTests: () => fails.clear(),
};
