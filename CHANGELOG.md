# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Security
- **The PIN no longer appears in any URL the portal builds** (ZIP download, HTML/PDF viewer, in-page media). One correct PIN now yields a signed
  `HttpOnly; SameSite=Strict` session cookie that every PIN-guarded route accepts; the PDF unlock form redirects to a clean URL. Covered by tests,
  including forged / wrong-scope cookies and a static check that the portal never builds a `pin=` URL.
- **Stored XSS in the portal:** two preview cards inserted raw file names into HTML. A guest with write access (e.g. WebDAV, whose file names aren't
  sanitised) could plant a file named like `<img onerror=…>` and run script in other guests' browsers. Names are now escaped, and a test guards it.
- Hoster Radio is behind the same PIN check and lockout; its control API (`/api/radio/*`) is owner-only; its UI never writes song titles as HTML.
- **Host controls are now owner-only.** `/host` and all `/api/*` endpoints answer only the device running Hoster. Before, any device
  on the Wi-Fi could list the phone's folders, stop the server, or change the PIN. The live-activity WebSocket is owner-only too.
- **PIN was not enforced on several routes.** `/upload`, `/view-dir/*` and `/view-asset` accepted requests without the PIN; all are
  now behind one shared check (together with `/files` and `/view`).
- **WebDAV ignored the PIN and ignored "uploads disabled".** WebDAV now requires the PIN (HTTP Basic password, any username)
  and is read-only unless client uploads are enabled. ⚠️ If you relied on writing over WebDAV with uploads switched off, switch uploads on.
- **PIN brute-force lockout:** 5 wrong PINs lock an address out for 5 minutes (HTTP 429) across every PIN-checked route.
- **Links for VLC/MX Player no longer contain the PIN.** They use short-lived signed tokens bound to a single path.
- `Referrer-Policy: no-referrer` on all responses.
- The mobile WebView only loads the local Host UI (external links open in the browser) and no longer enables file-access flags.

### Added
- **Radio: speaker-delay compensation** — a per-device slider (0–600 ms, remembered in the browser) so a phone on a Bluetooth speaker plays slightly ahead and sounds in time with everyone else.
- **📻 Hoster Radio:** a private radio station — a shared queue and one shared playback clock, so every browser on the Wi-Fi hears the same
  moment of the same song. Listener-side clock-offset estimation with drift correction (rate nudges, seeks only when needed), host controls in the
  Host UI (play/pause, next/prev, shuffle, repeat, remove, clear), "Queue shared folder", and an optional guests-can-add-songs mode.
  Song lengths and tags are read from the files on the server (`music-metadata`), with a size-plausibility-checked, first-wins listener report as a
  fallback for files it can't read. Stations reset when sharing stops.
- **Play a whole folder in VLC** (button in the portal): an in-memory M3U in natural order (2 before 10), audio/video only, optional recursion; nothing is saved to disk.
- **One-tap VLC without downloading a file:** `vlc://` deep links (iOS, desktop) and `intent://` (Android), with a copy-link fallback and a one-time Windows setup script.
- **Stable address:** `hoster.local` over mDNS (re-announced within seconds of an IP change) plus a host-screen toggle for hostname-first vs IP-first; the QR code follows it.
- **Android:** foreground service with wake, Wi-Fi and multicast locks (keeps streaming with the screen off and lets `hoster.local` resolve),
  a notification with a **Stop sharing** button, and contextual permission prompts (no more nagging on every launch).
- **Settings are remembered** across restarts (folder, port, toggles, PIN, hostname). Sharing itself never auto-starts.
- Self-hosted fonts (Outfit, JetBrains Mono; OFL-1.1) — the UI works fully offline and makes no requests to Google.
- Automated test suite (100+ tests), CI, `npm run sync` / `sync:check`, LICENSE, SECURITY, CONTRIBUTING, issue/PR templates.

### Changed
- `hoster.local` is the primary address by default (the raw IP is shown as a backup).
- `GET /api/status` is reduced for other devices (`running`, `uploadEnabled` only).
- `build-android.sh` no longer hard-codes a developer's home directory.

### Fixed
- File names containing a literal `%` broke `/pdf` (threw) and uploads (a crash on a second URL-decode); malformed `%` sequences produced a 500.
  Path resolution is now one shared, tested function instead of three private copies.
- Desktop and Android builds did not list every dependency of the server; `npm run sync` now keeps the dependency lists in step too.
- The embedded server's "started" message to the app never fired (the `rn-bridge` module was never required); the app waited out a fixed timeout.
- "N devices connected" counted WebSockets; it now counts other devices active in the last 5 minutes. The phone's own polling no longer
  shows up as a device or fills the activity log.
- The desktop and Android builds shipped stale copies of the server; copies are now generated and verified.
- Android: the "All files access" prompt opened the wrong settings page.
- Mobile app: Jest setup and `@types/node` pin so type-checking and tests run in a clean install.
