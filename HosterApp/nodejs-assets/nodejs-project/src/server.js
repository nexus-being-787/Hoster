const express = require('express');
const http = require('http');
const https = require('https');
const selfsigned = require('selfsigned');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const ip = require('ip');
const QRCode = require('qrcode');
const mdns = require('multicast-dns');
const { v2: webdav } = require('webdav-server');

let activeMdns = null;
let activeShareServer = null;
let ipWatcher = null;

const wServer = new webdav.WebDAVServer({ requireAuthentification: false });
const webdavRouter = webdav.extensions.express('/webdav', wServer);

const fileRoutes = require('./routes/files');
const uploadRoutes = require('./routes/upload');
const viewRoutes = require('./routes/view');
const pdfRoutes = require('./routes/pdf');
const { validatePin } = require('./utils/security');
const auth = require('./utils/auth');
const configStore = require('./utils/config');

// Inside nodejs-mobile (the Android app) this is the bridge to React Native; in plain Node it's absent.
let rnBridge = null;
try { rnBridge = require('rn-bridge'); } catch (e) { /* not running in nodejs-mobile */ }


const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─────────────────────────────────────────────
// mDNS helpers — advertise <hostname>.local on the LAN
// Uses multicast-dns (pure JS, no native bindings, works on Android)
// ─────────────────────────────────────────────
function startMdns(hostname, currentIP) {
  stopMdns();
  try {
    activeMdns = mdns();
    activeMdns.on('query', (query) => {
      const match = query.questions.find(q =>
        q.name === hostname && (q.type === 'A' || q.type === 'ANY')
      );
      if (match) {
        activeMdns.respond({
          answers: [{ name: hostname, type: 'A', ttl: 300, data: currentIP, flush: true }]
        });
      }
    });
    // Proactive announcement
    activeMdns.respond({
      answers: [{ name: hostname, type: 'A', ttl: 300, data: currentIP, flush: true }]
    });
    console.log(`mDNS: ${hostname} → ${currentIP}`);
  } catch (e) {
    console.warn('mDNS start failed:', e.message);
  }
}

function stopMdns() {
  if (activeMdns) {
    try { activeMdns.destroy(); } catch(e) {}
    activeMdns = null;
  }
}

// ─────────────────────────────────────────────
// IP-change watcher — phones get a new DHCP lease whenever Wi-Fi reconnects.
// Re-advertise <hostname>.local with the new IP and tell the host UI, so the
// hostname URL keeps working without restarting the server.
// ─────────────────────────────────────────────
function startIpWatcher() {
  stopIpWatcher();
  ipWatcher = setInterval(() => {
    if (!serverState.running) return;
    let current;
    try { current = ip.address(); } catch (e) { return; }
    if (!current || current.startsWith('127.') || current === serverState.localIP) return;

    console.log(`IP changed: ${serverState.localIP} → ${current}`);
    serverState.localIP = current;
    startMdns(serverState.localHostname, current); // 'hoster.local' alias reads serverState.localIP live

    broadcastStatus();
  }, 8000);
}

function stopIpWatcher() {
  if (ipWatcher) { clearInterval(ipWatcher); ipWatcher = null; }
}

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────
let serverState = {
  running: false,
  sharedDir: null,
  pin: null,
  pinEnabled: false,
  uploadEnabled: false,
  webdavEnabled: false,
  useHttps: false,
  port: 8080,
  localIP: ip.address(),
  localHostname: 'hoster.local',  // stable .local hostname
  clients: new Set(),
  accessLogs: [],
  bytesServed: 0,
  startedAt: null,
  connectedDevices: new Map(), // ip -> { ip, ua, firstSeen, lastSeen }
  blockedIPs: new Set(),
};

global.serverState = serverState;

// Remembered settings (folder, port, toggles, PIN). Sharing itself is never auto-started.
const config = configStore.create(configStore.resolveDir(rnBridge));
const { Radio } = require('./utils/radio');
const radioRoutes = require('./routes/radio');
serverState.radio = new Radio();
Object.assign(serverState, config.load());

// ─────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────
// WebDAV handler must be placed before body parsers so XML/raw binary streams are not consumed
app.use((req, res, next) => {
  if (req.path.startsWith('/webdav')) {
    if (!serverState.running || !serverState.webdavEnabled) {
      return res.status(403).send('WebDAV is disabled or server not running');
    }

    // Strip the bogus www-authenticate header webdav-server v2 sends even when auth is disabled.
    // Without this, browsers show a login dialog or report "site has a problem".
    const origSetHeader = res.setHeader.bind(res);
    res.setHeader = (name, value) => {
      if (name && name.toLowerCase() === 'www-authenticate') return res;
      return origSetHeader(name, value);
    };

    // Browsers send GET to /webdav/ — WebDAV only allows PROPFIND on collections, so browsers get
    // a 405 which shows as "site has a problem". Redirect browser GETs to the file portal instead.
    //
    // IMPORTANT: Use Accept header, NOT User-Agent, for browser detection.
    // Dolphin/KIO, Konqueror, and other DAV clients also send "Mozilla" in their UA string,
    // but they never request "text/html" — only real browsers do.
    if (req.method === 'GET') {
      const accept = req.headers['accept'] || '';
      const wantsHtml = accept.includes('text/html');
      if (wantsHtml) {
        // Build a relative sub-path from the WebDAV URL so we can show the right folder.
        // e.g. /webdav/Photos → /?webdav_path=Photos
        const subPath = req.path.replace(/^\/webdav\/?/, '').replace(/\/+$/, '');
        const redirectTo = subPath ? `/?webdav_path=${encodeURIComponent(subPath)}` : '/';
        return res.redirect(302, redirectTo);
      }
    }

    // PIN: WebDAV clients can't fill in a form, so the PIN is the HTTP Basic password (any username).
    // Same lockout as the rest of the share. Checked BEFORE anything reaches the WebDAV engine.
    if (serverState.pinEnabled && serverState.pin) {
      const verdict = auth.check(req, serverState, auth.basicPassword(req));
      if (!verdict.ok) {
        if (verdict.status === 429) {
          origSetHeader('Retry-After', String(verdict.retryAfter));
          return res.status(429).send('Too many wrong PIN attempts. Try again later.');
        }
        origSetHeader('WWW-Authenticate', 'Basic realm="Hoster - enter the PIN as the password", charset="UTF-8"');
        return res.status(401).send('PIN required');
      }
    }

    // "Client file uploads" off means nobody can change the folder — over WebDAV too.
    const READ_ONLY_OK = ['GET', 'HEAD', 'OPTIONS', 'PROPFIND'];
    if (!serverState.uploadEnabled && !READ_ONLY_OK.includes(req.method)) {
      return res.status(403).send('Uploads are disabled, so WebDAV is read-only');
    }

    // The PIN has been verified above. Don't let webdav-server see the Basic header: it would try to
    // authenticate that username against its own (empty) user list and answer 401 itself.
    delete req.headers.authorization;

    return webdavRouter(req, res, next);
  }
  next();
});

// ─────────────────────────────────────────────
// Host-controls lockdown. The same Express app serves the owner's Host UI (:9090) AND the
// client share port, so without this any device on the Wi-Fi could open /host, list the phone's
// folders, stop the server or change the PIN. Only the device running Hoster (loopback — the
// app's WebView, the notification's Stop button, the desktop shell) may use /host and /api/*.
// LAN devices keep the portal, /files, /upload, WebDAV, and a reduced GET /api/status.
// Escape hatch for advanced setups: HOSTER_ALLOW_REMOTE_HOST_UI=1
// ─────────────────────────────────────────────
app.use((req, res, next) => { res.set('Referrer-Policy', 'no-referrer'); next(); });

const ALLOW_REMOTE_HOST_UI = process.env.HOSTER_ALLOW_REMOTE_HOST_UI === '1';
function isLoopback(addr) {
  addr = String(addr || '').replace(/^::ffff:/, '');
  return addr === '127.0.0.1' || addr === '::1';
}
function isOwnerRequest(req) {
  return ALLOW_REMOTE_HOST_UI || isLoopback(req.socket && req.socket.remoteAddress);
}
app.use((req, res, next) => {
  if (isOwnerRequest(req)) return next();
  const p = req.path;
  const hostOnly = p === '/host' || p.startsWith('/host/') || p === '/api' || p.startsWith('/api/');
  if (!hostOnly) return next();
  if (p === '/api/status' && req.method === 'GET') return next(); // client portal needs it; reduced below
  return res.status(403).json({ error: 'Host controls are only available on the device running Hoster.' });
});

// Devices actually using the share (seen in the last 5 min). The owner's own loopback traffic and
// the Host UI sockets are not "devices".
function activeDeviceCount() {
  const cutoff = Date.now() - 5 * 60 * 1000;
  let n = 0;
  serverState.connectedDevices.forEach(d => {
    if (!isLoopback(d.ip) && Date.parse(d.lastSeen) >= cutoff) n++;
  });
  return n;
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static host UI
app.use('/host', express.static(path.join(__dirname, 'host-ui')));

// Serve client portal static assets
app.use('/assets', express.static(path.join(__dirname, '..', 'public')));

// PIN guard for everything a client can read or write on the share (brute-force lockout, signed
// path-bound tokens for VLC links, viewer cookie). /pdf calls auth.check() itself (it renders a PIN form).
app.use(['/files', '/view', '/view-dir', '/view-asset', '/upload', '/radio'], auth.middleware(serverState));

// Access log & device tracking middleware
app.use((req, res, next) => {
  // Skip static assets from the host UI itself if we only want to track external clients
  if (req.path.startsWith('/host/') || req.path === '/host') return next();
  if (req.path.startsWith('/api/') && isLoopback(req.socket && req.socket.remoteAddress)) return next();

  let clientIP = req.ip || req.connection.remoteAddress;
  if (clientIP.startsWith('::ffff:')) {
    clientIP = clientIP.substring(7);
  }

  // 1. Check if IP is blocked
  if (serverState.blockedIPs.has(clientIP)) {
    // If blocked, immediately destroy the connection to prevent any resources from being used
    req.socket.destroy();
    return;
  }

  const start = Date.now();
  const userAgent = req.headers['user-agent'] || 'Unknown';

  // 2. Track device
  const now = new Date().toISOString();
  if (!serverState.connectedDevices.has(clientIP)) {
    serverState.connectedDevices.set(clientIP, {
      ip: clientIP,
      ua: userAgent.substring(0, 100),
      firstSeen: now,
      lastSeen: now
    });
    broadcast({ type: 'devices', data: Array.from(serverState.connectedDevices.values()) });
  } else {
    const dev = serverState.connectedDevices.get(clientIP);
    dev.lastSeen = now;
    // Don't broadcast every single request to save CPU, just update memory
  }

  res.on('finish', () => {
    const duration = Date.now() - start;
    const log = {
      time: new Date().toISOString(),
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: clientIP,
      ua: userAgent.substring(0, 60),
    };
    serverState.accessLogs.unshift(log);
    if (serverState.accessLogs.length > 200) serverState.accessLogs.pop();
    broadcast({ type: 'log', data: log });
  });
  next();
});

// ─────────────────────────────────────────────
// API: Server Control
// ─────────────────────────────────────────────
app.get('/api/check-dir', (req, res) => {
  let targetPath = req.query.path || '';
  if (!targetPath) return res.json({ exists: false, error: 'No path provided' });
  
  if (targetPath.startsWith('/sdcard/')) {
    targetPath = targetPath.replace('/sdcard/', '/storage/emulated/0/');
  } else if (targetPath === '/sdcard') {
    targetPath = '/storage/emulated/0';
  }
  
  if (!fs.existsSync(targetPath)) {
    if (targetPath.endsWith('/Downloads')) {
      const alt = targetPath.replace(/\/Downloads$/, '/Download');
      if (fs.existsSync(alt)) targetPath = alt;
    }
  }

  if (!fs.existsSync(targetPath)) {
    return res.json({ exists: false, path: targetPath, error: 'Directory does not exist' });
  }

  try {
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      return res.json({ exists: true, isDirectory: false, path: targetPath, error: 'Path is a file, not a directory' });
    }
    const entries = fs.readdirSync(targetPath);
    res.json({
      exists: true,
      isDirectory: true,
      path: targetPath,
      total: entries.length,
    });
  } catch (err) {
    res.json({ exists: true, isDirectory: true, path: targetPath, total: 0, error: err.message });
  }
});

app.get('/api/filesystem', (req, res) => {
  let reqPath = req.query.path || '/storage/emulated/0';
  
  if (!fs.existsSync(reqPath)) {
    reqPath = fs.existsSync('/storage/emulated/0') ? '/storage/emulated/0' : '/';
  }
  
  try {
    const stat = fs.statSync(reqPath);
    if (!stat.isDirectory()) {
      reqPath = path.dirname(reqPath);
    }
    
    const entries = fs.readdirSync(reqPath, { withFileTypes: true });
    const dirs = entries
      .filter(e => {
        const isDir = typeof e.isDirectory === 'function' ? e.isDirectory() : false;
        const name = e.name || e;
        return isDir && typeof name === 'string' && !name.startsWith('.');
      })
      .map(e => {
        const name = e.name || e;
        return {
          name: name,
          path: path.join(reqPath, name).replace(/\\/g, '/'),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
      
    const parentPath = (reqPath === '/' || reqPath === '/storage/emulated/0') ? null : path.dirname(reqPath).replace(/\\/g, '/');
    
    const commonPaths = [
      { name: 'Internal Storage', path: '/storage/emulated/0' },
      { name: 'Download', path: '/storage/emulated/0/Download' },
      { name: 'DCIM (Photos)', path: '/storage/emulated/0/DCIM' },
      { name: 'Pictures', path: '/storage/emulated/0/Pictures' },
      { name: 'Documents', path: '/storage/emulated/0/Documents' },
      { name: 'Music', path: '/storage/emulated/0/Music' },
      { name: 'Movies', path: '/storage/emulated/0/Movies' },
    ].filter(cp => fs.existsSync(cp.path));

    res.json({
      currentPath: reqPath,
      parentPath,
      dirs,
      commonPaths,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// URLs for the current state: stable .local hostname (primary) + raw IP (backup)
function currentUrls() {
  const protocol = serverState.useHttps ? 'https' : 'http';
  const localUrl = `${protocol}://${serverState.localIP}:${serverState.port}`;
  const hostnameUrl = serverState.localHostname
    ? `${protocol}://${serverState.localHostname}:${serverState.port}` : localUrl;
  return { localUrl, hostnameUrl, url: serverState.preferHostname === false ? localUrl : hostnameUrl };
}

function broadcastStatus() {
  const u = currentUrls();
  broadcast({ type: 'status', data: {
    running: true,
    useHttps: serverState.useHttps,
    localIP: serverState.localIP,
    localHostname: serverState.localHostname,
    localUrl: u.localUrl,
    port: serverState.port,
    url: u.url,
    webdavEnabled: serverState.webdavEnabled
  }});
}

app.get('/api/status', (req, res) => {
  if (!isOwnerRequest(req)) {
    // what the client portal needs, nothing about the host (paths, PIN, IPs)
    return res.json({ running: serverState.running, uploadEnabled: serverState.uploadEnabled });
  }
  const urls = currentUrls();
  res.json({
    devices: activeDeviceCount(),
    running: serverState.running,
    url: urls.url,
    localUrl: urls.localUrl,
    localHostname: serverState.localHostname,
    preferHostname: serverState.preferHostname !== false,
    pin: serverState.pin,
    customDomain: serverState.customDomain || '',
    sharedDir: serverState.sharedDir,
    pinEnabled: serverState.pinEnabled,
    uploadEnabled: serverState.uploadEnabled,
    webdavEnabled: serverState.webdavEnabled,
    useHttps: serverState.useHttps,
    port: serverState.port,
    localIP: serverState.localIP,
    clients: serverState.clients.size,
    bytesServed: serverState.bytesServed,
    startedAt: serverState.startedAt,
    logs: serverState.accessLogs.slice(0, 50),
  });
});

app.post('/api/start', async (req, res) => {
  let { dir, pin, pinEnabled, uploadEnabled, webdavEnabled, useHttps, port, customDomain } = req.body;
  
  if (dir) {
    if (dir.startsWith('/sdcard/')) dir = dir.replace('/sdcard/', '/storage/emulated/0/');
    else if (dir === '/sdcard') dir = '/storage/emulated/0';
    if (!fs.existsSync(dir) && dir.endsWith('/Downloads') && fs.existsSync(dir.replace(/\/Downloads$/, '/Download'))) {
      dir = dir.replace(/\/Downloads$/, '/Download');
    }
  }

  if (!dir || !fs.existsSync(dir)) {
    return res.status(400).json({ error: 'Directory does not exist. Use the Browse button to pick a folder.' });
  }
  
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) {
    return res.status(400).json({ error: 'Selected path is a file, not a directory.' });
  }

  serverState.sharedDir = dir;
  serverState.pinEnabled = !!pinEnabled;
  serverState.pin = pin || null;
  serverState.uploadEnabled = !!uploadEnabled;
  serverState.webdavEnabled = !!webdavEnabled;
  serverState.useHttps = !!useHttps;
  serverState.port = parseInt(port) || 8080;
  serverState.localIP = ip.address();

  // Determine .local hostname — custom domain or default 'hoster'
  const cleanDomain = customDomain
    ? customDomain.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase()
    : '';
  const hostnameBase = cleanDomain || 'hoster';
  const localHostname = `${hostnameBase}.local`;
  serverState.localHostname = localHostname;
  serverState.customDomain = cleanDomain; // remembered for next launch

  if (serverState.webdavEnabled) {
    wServer.setFileSystem('/', new webdav.PhysicalFileSystem(dir), () => {});
  }

  if (activeShareServer) {
    try { activeShareServer.close(); } catch(e) {}
    activeShareServer = null;
  }

  const protocol = serverState.useHttps ? 'https' : 'http';
  const localUrl = `${protocol}://${serverState.localIP}:${serverState.port}`;
  const hostnameUrl = `${protocol}://${localHostname}:${serverState.port}`;
  // Stable address: the .local hostname survives DHCP/IP changes, so it is the primary URL.
  // The raw IP URL is still returned as a backup (some Android browsers can't resolve .local).
  // Send preferHostname:false from the host UI to go back to IP-first.
  serverState.preferHostname = !(req.body.preferHostname === false || req.body.preferHostname === 'false');
  let domainUrl = serverState.preferHostname ? hostnameUrl : localUrl;

  // Start mDNS — advertise <hostnameBase>.local → current IP
  // Also advertise hoster.local as an alias if using a custom name
  startMdns(localHostname, serverState.localIP);
  if (hostnameBase !== 'hoster') {
    // Also advertise the default hoster.local so clients always have a fallback
    setTimeout(() => {
      try {
        const fallbackMdns = mdns();
        fallbackMdns.on('query', (q) => {
          if (q.questions.some(r => r.name === 'hoster.local' && (r.type === 'A' || r.type === 'ANY'))) {
            fallbackMdns.respond({ answers: [{ name: 'hoster.local', type: 'A', ttl: 300, data: serverState.localIP, flush: true }] });
          }
        });
        fallbackMdns.respond({ answers: [{ name: 'hoster.local', type: 'A', ttl: 300, data: serverState.localIP, flush: true }] });
      } catch(e) {}
    }, 200);
  }

  try {
    if (serverState.useHttps) {
      // Check cache for existing cert (keyed to hostname, not IP — stable across reconnects)
      const os = require('os');
      const certCachePath = path.join(os.tmpdir(), `hoster_cert_${hostnameBase}.json`);
      let pki = null;

      try {
        if (fs.existsSync(certCachePath)) {
          const cached = JSON.parse(fs.readFileSync(certCachePath, 'utf8'));
          if (cached.hostname === localHostname) {
            pki = cached.pki;
          }
        }
      } catch (err) {}

      if (!pki) {
        // Generate cert for the .local hostname (not IP) so it's stable across IP changes.
        // Browsers still show a warning the first time (self-signed), but the cert persists.
        const keyPair = require('./staticKey.json');
        const altNames = [
          { type: 2, value: localHostname },          // hoster.local (DNS SAN)
          { type: 2, value: 'hoster.local' },         // fallback alias
          { type: 7, ip: serverState.localIP },       // current IP
          { type: 7, ip: '127.0.0.1' },
          { type: 2, value: 'localhost' },
        ];
        if (cleanDomain && cleanDomain !== 'hoster') {
          altNames.push({ type: 2, value: `${cleanDomain}.local` });
        }

        pki = await selfsigned.generate(
          [{ name: 'commonName', value: localHostname }],
          {
            keyPair,
            days: 3650, // 10 years — cert stays valid even when IP changes
            extensions: [{ name: 'subjectAltName', altNames }],
          }
        );
        // Cache keyed to hostname — only regenerate if hostname changes
        try {
          fs.writeFileSync(certCachePath, JSON.stringify({ hostname: localHostname, pki }), 'utf8');
        } catch (err) {}
      }

      const httpsOpts = { cert: pki.cert, key: pki.private };
      activeShareServer = https.createServer(httpsOpts, app);

      // Attach WebSocket server to the HTTPS instance as well
      const wssShare = new WebSocket.Server({ server: activeShareServer });
      wssShare.on('connection', (ws, req) => {
        if (!isOwnerRequest(req)) { ws.close(1008, 'forbidden'); return; }
        serverState.clients.add(ws);
        broadcast({ type: 'clients', data: { count: serverState.clients.size } });
        ws.on('close', () => {
          serverState.clients.delete(ws);
          broadcast({ type: 'clients', data: { count: serverState.clients.size } });
        });
        ws.on('error', () => serverState.clients.delete(ws));
        ws.send(JSON.stringify({ type: 'init', data: { running: true, localIP: serverState.localIP, localHostname, port: serverState.port } }));
      });

      await new Promise((resolve, reject) => {
        activeShareServer.listen(serverState.port, '0.0.0.0', resolve);
        activeShareServer.on('error', reject);
      });
    } else {
      activeShareServer = http.createServer(app);
      await new Promise((resolve, reject) => {
        activeShareServer.listen(serverState.port, '0.0.0.0', resolve);
        activeShareServer.on('error', reject);
      });
    }
  } catch(err) {
    console.error('Failed to start listener on port ' + serverState.port, err);
    return res.status(500).json({ error: 'Failed to start listener: ' + err.message });
  }

  serverState.radio.reset();
  radioRoutes.resetProbes();
  serverState.running = true;
  serverState.startedAt = new Date().toISOString();
  startIpWatcher();
  config.save({
    sharedDir: serverState.sharedDir, port: serverState.port, pinEnabled: serverState.pinEnabled,
    pin: serverState.pin, uploadEnabled: serverState.uploadEnabled, webdavEnabled: serverState.webdavEnabled,
    useHttps: serverState.useHttps, preferHostname: serverState.preferHostname !== false,
    customDomain: serverState.customDomain || '',
  });

  broadcast({ type: 'status', data: {
    running: true,
    useHttps: serverState.useHttps,
    localIP: serverState.localIP,
    localHostname,
    localUrl,
    port: serverState.port,
    url: domainUrl,
    webdavEnabled: serverState.webdavEnabled
  }});
  res.json({ success: true, url: domainUrl, localHostname, localUrl });
});

app.post('/api/stop', (req, res) => {
  serverState.radio.reset();
  radioRoutes.resetProbes();
  serverState.running = false;
  serverState.startedAt = null;
  stopIpWatcher();
  stopMdns();
  if (activeShareServer) {
    try { activeShareServer.close(); } catch(e) {}
    activeShareServer = null;
  }
  broadcast({ type: 'status', data: { running: false } });
  res.json({ success: true });
});

app.post('/api/settings', (req, res) => {
  const { pin, pinEnabled, uploadEnabled, webdavEnabled, useHttps, preferHostname } = req.body;
  if (typeof preferHostname !== 'undefined') {
    // hostname-first (hoster.local, survives IP changes) vs IP-first (browsers without mDNS)
    serverState.preferHostname = !(preferHostname === false || preferHostname === 'false');
    if (serverState.running) broadcastStatus(); // URL card + QR update immediately
  }
  if (typeof pinEnabled !== 'undefined') serverState.pinEnabled = !!pinEnabled;
  if (typeof uploadEnabled !== 'undefined') serverState.uploadEnabled = !!uploadEnabled;
  if (typeof webdavEnabled !== 'undefined') {
    serverState.webdavEnabled = !!webdavEnabled;
    if (serverState.webdavEnabled && serverState.running && serverState.sharedDir) {
      wServer.setFileSystem('/', new webdav.PhysicalFileSystem(serverState.sharedDir), () => {});
    }
  }
  if (typeof useHttps !== 'undefined') serverState.useHttps = !!useHttps;
  if (pin !== undefined) serverState.pin = pin;
  config.save({
    pinEnabled: serverState.pinEnabled, pin: serverState.pin, uploadEnabled: serverState.uploadEnabled,
    webdavEnabled: serverState.webdavEnabled, useHttps: serverState.useHttps,
    preferHostname: serverState.preferHostname !== false,
  });
  broadcast({ type: 'settings', data: { pinEnabled: serverState.pinEnabled, uploadEnabled: serverState.uploadEnabled, webdavEnabled: serverState.webdavEnabled, useHttps: serverState.useHttps, preferHostname: serverState.preferHostname !== false } });
  res.json({ success: true });
});

app.get('/api/qrcode', async (req, res) => {
  try {
    const url = currentUrls().url; // follows the hostname-first / IP-first toggle
    const dataUrl = await QRCode.toDataURL(url, {
      width: 280,
      margin: 2,
      color: { dark: '#0ff', light: '#0a0a1a' }
    });
    res.json({ qrcode: dataUrl, url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// File Routes
// ─────────────────────────────────────────────
app.use('/radio', radioRoutes.guest);
app.use('/api/radio', radioRoutes.admin); // owner only: the loopback guard above refuses everyone else

app.use('/files', (req, res, next) => {
  if (!serverState.running || !serverState.sharedDir) {
    return res.status(503).json({ error: 'Server not running or no directory selected' });
  }
  next();
}, fileRoutes);

app.use('/upload', (req, res, next) => {
  if (!serverState.uploadEnabled) {
    return res.status(403).json({ error: 'Uploads are disabled' });
  }
  next();
}, uploadRoutes);

// ─────────────────────────────────────────────
// HTML Viewer Routes
// ─────────────────────────────────────────────
// GET /view?path=<file>      → renders the HTML file with <base> tag + toolbar
// GET /view-dir/*            → transparent file server (serves assets from sharedDir)
//                              used by the <base> tag so ALL relative URLs work:
//                              ES module imports, fetch(), Workers, textures, audio, etc.
// GET /view-asset?path=<p>  → legacy asset proxy (kept for backward compat)
app.use('/view', (req, res, next) => {
  if (!serverState.running || !serverState.sharedDir) {
    return res.status(503).send('Server not running or no directory selected.');
  }
  next();
}, viewRoutes);

// /view-dir/* — the <base href> target; serves any file from sharedDir by path segments
app.use('/view-dir', (req, res, next) => {
  if (!serverState.running || !serverState.sharedDir) {
    return res.status(503).end();
  }
  // Forward to /dir/* handler in viewRoutes
  req.url = '/dir' + req.url;
  viewRoutes(req, res, () => res.status(404).end());
});

// /view-asset?path= — legacy, keep working
app.use('/view-asset', (req, res, next) => {
  if (!serverState.running || !serverState.sharedDir) {
    return res.status(503).end();
  }
  next();
}, (req, res) => {
  req.url = '/asset' + (req.url === '/' ? '' : req.url);
  viewRoutes(req, res, () => res.status(404).end());
});

// ─────────────────────────────────────────────
// PDF Viewer Route
// GET /pdf?path=<relative_pdf_path>
// ─────────────────────────────────────────────
app.use('/pdf', (req, res, next) => {
  if (!serverState.running || !serverState.sharedDir) {
    return res.status(503).send('Server not running or no directory selected.');
  }
  next();
}, pdfRoutes);

// ─────────────────────────────────────────────
// Client Portal (root)
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─────────────────────────────────────────────
// WebSocket: Real-time broadcast
// ─────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  if (!isOwnerRequest(req)) { ws.close(1008, 'forbidden'); return; }
  serverState.clients.add(ws);
  broadcast({ type: 'clients', data: { count: serverState.clients.size } });

  ws.on('close', () => {
    serverState.clients.delete(ws);
    broadcast({ type: 'clients', data: { count: serverState.clients.size } });
  });

  ws.on('error', () => serverState.clients.delete(ws));

  // Send initial state
  ws.send(JSON.stringify({
    type: 'init',
    data: {
      running: serverState.running,
      localIP: serverState.localIP,
      port: serverState.port,
      sharedDir: serverState.sharedDir,
    }
  }));
});

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  serverState.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  });
}

global.broadcast = broadcast;

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
const HOST_PORT = process.env.HOST_PORT || process.env.HOST_UI_PORT || 9090;
server.listen(HOST_PORT, '0.0.0.0', () => {
  console.log(`Host UI running on ${HOST_PORT}`);
  if (rnBridge) {
    rnBridge.channel.send('started');
  }
  console.log('');
  console.log('  ██╗  ██╗ ██████╗ ███████╗████████╗███████╗██████╗');
  console.log('  ██║  ██║██╔═══██╗██╔════╝╚══██╔══╝██╔════╝██╔══██╗');
  console.log('  ███████║██║   ██║███████╗   ██║   █████╗  ██████╔╝');
  console.log('  ██╔══██║██║   ██║╚════██║   ██║   ██╔══╝  ██╔══██╗');
  console.log('  ██║  ██║╚██████╔╝███████║   ██║   ███████╗██║  ██║');
  console.log('  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝   ╚═╝   ╚══════╝╚═╝  ╚═╝');
  console.log('');
  console.log(`  🚀 Host UI    → http://localhost:${HOST_PORT}/host`);
  console.log(`  🌐 Local IP   → http://${ip.address()}:${HOST_PORT}`);
  console.log(`  📁 File Port  → http://${ip.address()}:8080 (after Start)`);
  console.log(`  📂 WebDAV     → http://${ip.address()}:8080/webdav (after Start)`);
  console.log('');
});
