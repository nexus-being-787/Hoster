/**
 * Hoster Desktop — Electron Main Process
 * Starts the existing Hoster Express server in-process,
 * then opens the host-ui dashboard in an Electron window.
 */

'use strict';

const { app, BrowserWindow, Tray, Menu, dialog, ipcMain } = require('electron');
const path = require('path');
const http = require('http');

let mainWindow = null;
let tray = null;
const HOST_PORT = 9090;

// ── Start the Hoster server in-process ─────────────────────────────────
// Set port before requiring server.js so it reads the env var
process.env.HOST_PORT = String(HOST_PORT);

// The server lives in ./src/server.js (symlink → ../src/server.js)
require('./src/server.js');

// ── Wait for server HTTP endpoint to respond ───────────────────────────
function waitForServer(retries, delayMs) {
  retries = retries || 30;
  delayMs = delayMs || 300;
  return new Promise(function(resolve) {
    function attempt(n) {
      var req = http.get('http://localhost:' + HOST_PORT + '/host', function(res) {
        res.resume();
        resolve();
      });
      req.on('error', function() {
        if (n <= 0) { resolve(); return; }
        setTimeout(function() { attempt(n - 1); }, delayMs);
      });
      req.setTimeout(500, function() { req.abort(); });
    }
    attempt(retries);
  });
}

// ── Create BrowserWindow ───────────────────────────────────────────────
function createWindow() {
  var iconFile = process.platform === 'win32'
    ? path.join(__dirname, 'assets', 'icon.ico')
    : path.join(__dirname, 'assets', 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1140,
    height: 740,
    minWidth: 860,
    minHeight: 580,
    title: 'Hoster',
    icon: iconFile,
    backgroundColor: '#08090f',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL('http://localhost:' + HOST_PORT + '/host');

  // Show once rendered — avoids white flash on startup
  mainWindow.once('ready-to-show', function() { mainWindow.show(); });

  // Minimize to tray on close instead of quitting
  mainWindow.on('close', function(e) {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ── System tray ────────────────────────────────────────────────────────
function createTray() {
  var trayIconPath = path.join(__dirname, 'assets', 'tray.png');
  tray = new Tray(trayIconPath);
  tray.setToolTip('Hoster — Wi-Fi File Sharing');

  var menu = Menu.buildFromTemplate([
    {
      label: 'Open Hoster',
      click: function() {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Hoster',
      click: function() {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);

  // Click tray icon → toggle window
  tray.on('click', function() {
    if (mainWindow) {
      if (mainWindow.isVisible()) { mainWindow.hide(); }
      else { mainWindow.show(); }
    }
  });
  tray.on('double-click', function() {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
}

// ── IPC: native folder picker ──────────────────────────────────────────
ipcMain.handle('pick-folder', async function() {
  var result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select folder to share',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Share This Folder',
  });
  return result; // { canceled: bool, filePaths: string[] }
});

// ── App lifecycle ──────────────────────────────────────────────────────
app.whenReady().then(async function() {
  createTray();
  await waitForServer();
  createWindow();

  app.on('activate', function() {
    if (mainWindow) mainWindow.show();
  });
});

// Keep running in background when window is closed (tray)
app.on('window-all-closed', function() {
  // Intentionally NOT quitting — tray icon keeps app alive
});

app.on('before-quit', function() {
  app.isQuitting = true;
});
