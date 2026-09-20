const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const ip = require('ip');
const QRCode = require('qrcode');

const fileRoutes = require('./routes/files');
const uploadRoutes = require('./routes/upload');
const { validatePin } = require('./utils/security');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────
let serverState = {
  running: false,
  sharedDir: null,
  pin: null,
  pinEnabled: false,
  uploadEnabled: false,
  port: 8080,
  localIP: ip.address(),
  clients: new Set(),
  accessLogs: [],
  bytesServed: 0,
  startedAt: null,
};

global.serverState = serverState;

// ─────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────
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

// Access log middleware
app.use((req, res, next) => {
  const start = Date.now();
  const userAgent = req.headers['user-agent'] || 'Unknown';
  const clientIP = req.ip || req.connection.remoteAddress;

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
app.get('/api/status', (req, res) => {
  res.json({
    running: serverState.running,
    sharedDir: serverState.sharedDir,
    pinEnabled: serverState.pinEnabled,
    uploadEnabled: serverState.uploadEnabled,
    port: serverState.port,
    localIP: serverState.localIP,
    clients: serverState.clients.size,
    bytesServed: serverState.bytesServed,
    startedAt: serverState.startedAt,
    logs: serverState.accessLogs.slice(0, 50),
  });
});

app.post('/api/start', (req, res) => {
  const { dir, pin, pinEnabled, uploadEnabled, port } = req.body;
  if (!dir || !fs.existsSync(dir)) {
    return res.status(400).json({ error: 'Invalid or missing directory path' });
  }
  serverState.sharedDir = dir;
  serverState.pinEnabled = !!pinEnabled;
  serverState.pin = pin || null;
  serverState.uploadEnabled = !!uploadEnabled;
  serverState.port = port || 8080;
  serverState.localIP = ip.address();
  serverState.running = true;
  serverState.startedAt = new Date().toISOString();
  broadcast({ type: 'status', data: { running: true, localIP: serverState.localIP, port: serverState.port } });
  res.json({ success: true, url: `http://${serverState.localIP}:${serverState.port}` });
});

app.post('/api/stop', (req, res) => {
  serverState.running = false;
  serverState.startedAt = null;
  broadcast({ type: 'status', data: { running: false } });
  res.json({ success: true });
});

app.post('/api/settings', (req, res) => {
  const { pin, pinEnabled, uploadEnabled } = req.body;
  if (typeof pinEnabled !== 'undefined') serverState.pinEnabled = !!pinEnabled;
  if (typeof uploadEnabled !== 'undefined') serverState.uploadEnabled = !!uploadEnabled;
  if (pin !== undefined) serverState.pin = pin;
  broadcast({ type: 'settings', data: { pinEnabled: serverState.pinEnabled, uploadEnabled: serverState.uploadEnabled } });
  res.json({ success: true });
});

app.get('/api/qrcode', async (req, res) => {
  try {
    const url = `http://${serverState.localIP}:${serverState.port}`;
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
const PORT = process.env.HOST_UI_PORT || 9090;
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ██╗  ██╗ ██████╗ ███████╗████████╗███████╗██████╗');
  console.log('  ██║  ██║██╔═══██╗██╔════╝╚══██╔══╝██╔════╝██╔══██╗');
  console.log('  ███████║██║   ██║███████╗   ██║   █████╗  ██████╔╝');
  console.log('  ██╔══██║██║   ██║╚════██║   ██║   ██╔══╝  ██╔══██╗');
  console.log('  ██║  ██║╚██████╔╝███████║   ██║   ███████╗██║  ██║');
  console.log('  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝   ╚═╝   ╚══════╝╚═╝  ╚═╝');
  console.log('');
  console.log(`  🚀 Host UI    → http://localhost:${PORT}/host`);
  console.log(`  🌐 Local IP   → http://${ip.address()}:${PORT}`);
  console.log(`  📁 File Port  → http://${ip.address()}:8080 (after Start)`);
  console.log('');
});
