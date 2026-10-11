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

const wServer = new webdav.WebDAVServer({ requireAuthentification: false });
const webdavRouter = webdav.extensions.express('/webdav', wServer);

const fileRoutes = require('./routes/files');
const uploadRoutes = require('./routes/upload');
const viewRoutes = require('./routes/view');
const pdfRoutes = require('./routes/pdf');
const { validatePin } = require('./utils/security');

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

    return webdavRouter(req, res, next);
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static host UI
app.use('/host', express.static(path.join(__dirname, 'host-ui')));

// Serve client portal static assets
app.use('/assets', express.static(path.join(__dirname, '..', 'public')));

// PIN middleware for client portal
app.use('/files', (req, res, next) => {
  if (!serverState.pinEnabled || !serverState.pin) return next();
  const token = req.headers['x-hoster-pin'] || req.query.pin;
  if (!validatePin(token, serverState.pin)) {
    return res.status(401).json({ error: 'Invalid or missing PIN' });
  }
  next();
});

// Access log & device tracking middleware
app.use((req, res, next) => {
  // Skip static assets from the host UI itself if we only want to track external clients
  if (req.path.startsWith('/host/') || req.path === '/host') return next();

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

app.get('/api/status', (req, res) => {
  res.json({
    running: serverState.running,
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
  // Default: always show IP. Only show .local as primary if user explicitly set a custom domain.
  let domainUrl = cleanDomain ? hostnameUrl : localUrl;

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
      wssShare.on('connection', (ws) => {
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

  serverState.running = true;
  serverState.startedAt = new Date().toISOString();

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
  serverState.running = false;
  serverState.startedAt = null;
  stopMdns();
  if (activeShareServer) {
    try { activeShareServer.close(); } catch(e) {}
    activeShareServer = null;
  }
  broadcast({ type: 'status', data: { running: false } });
  res.json({ success: true });
});

app.post('/api/settings', (req, res) => {
  const { pin, pinEnabled, uploadEnabled, webdavEnabled, useHttps } = req.body;
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
  broadcast({ type: 'settings', data: { pinEnabled: serverState.pinEnabled, uploadEnabled: serverState.uploadEnabled, webdavEnabled: serverState.webdavEnabled, useHttps: serverState.useHttps } });
  res.json({ success: true });
});

app.get('/api/qrcode', async (req, res) => {
  try {
    const protocol = serverState.useHttps ? 'https' : 'http';
    const url = `${protocol}://${serverState.localIP}:${serverState.port}`;
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
  if (typeof rn_bridge !== 'undefined') {
    rn_bridge.channel.send('started');
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
