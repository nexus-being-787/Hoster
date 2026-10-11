# Hoster — Linux Desktop App

A Linux desktop build of **Hoster** — the same Wi-Fi file sharing server from your phone, now running as a native Linux app.

## What's Inside

| File | Purpose |
|------|---------|
| `main.js` | Electron main process — starts the server, creates the app window, system tray |
| `preload.js` | IPC bridge — native folder picker, desktop tweaks |
| `src/` → `../src` | Symlink to the shared Express server source |
| `public/` → `../public` | Symlink to the shared client portal |
| `assets/` | App icon (512×512 PNG) and tray icon (22×22 PNG) |

## Development

```bash
npm install
npm start          # Opens Electron window with the Hoster dashboard
```

## Build

```bash
npm run build      # Produces dist/Hoster-1.2.0.AppImage + Hoster-1.2.0.deb
```

> **Note:** Build on a Linux machine. The AppImage is portable (no install needed) — just `chmod +x Hoster.AppImage && ./Hoster.AppImage`.

## How It Works

1. Electron starts the Node.js Express server **in-process** on port 9090
2. A `BrowserWindow` opens and loads `http://localhost:9090/host` (the existing dashboard UI)
3. Clients on the same Wi-Fi connect to `http://<your-ip>:8080` in their browser — no app needed on their side
4. A system tray icon lets you toggle the window or quit

All features work identically to the mobile app: HTML viewer, PDF reader, sort/filter, upload, WebDAV, QR code.
