# Hoster — Windows Desktop App

A Windows desktop build of **Hoster** — the same Wi-Fi file sharing server from your phone, now running as a native Windows app.

## What's Inside

| File | Purpose |
|------|---------|
| `main.js` | Electron main process — starts the server, creates the app window, system tray |
| `preload.js` | IPC bridge — native folder picker, desktop tweaks |
| `src/` | Mirror of the root `../src` (kept in sync by `npm run sync` in the repo root — don't edit here) |
| `public/` | Mirror of the root `../public` (same — don't edit here) |
| `assets/` | App icon (`.ico`) and tray icon (`.png`) |

## Development

```bash
npm install
npm start          # Opens Electron window with the Hoster dashboard
```

> **Windows users:** If symlinks don't work, enable Developer Mode in Windows Settings, or run `git config core.symlinks true` before cloning.

## Build

```bash
npm run build      # Produces dist/Hoster-Setup-1.2.0.exe (installer) + Hoster-1.2.0.exe (portable)
```

Build on a **Windows machine** for best results.  
(Cross-compiling from Linux requires Wine + NSIS — see [electron-builder docs](https://www.electron.build/multi-platform-build).)

## How It Works

1. Electron starts the Node.js Express server **in-process** on port 9090
2. A `BrowserWindow` opens and loads `http://localhost:9090/host` (the existing dashboard UI)
3. Clients on the same Wi-Fi connect to `http://<your-ip>:8080` in their browser — no app needed on their side
4. A system tray icon in the taskbar lets you toggle the window or quit

All features work identically to the mobile app: HTML viewer, PDF reader, sort/filter, upload, WebDAV, QR code.
