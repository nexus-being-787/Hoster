# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately through GitHub: **Security → Report a vulnerability**
(<https://github.com/nexus-being-787/Hoster/security/advisories/new>).

Include what you found, how to reproduce it, and which part is affected (Android app, desktop app, or the Node server).
You can expect an acknowledgement within a few days. Fixes are released as soon as they are verified, and reporters are credited
in the changelog unless they prefer otherwise.

## Supported versions

Only the latest release and the `main` branch receive security fixes.

## What Hoster is — and is not

Hoster shares a folder over **your own Wi-Fi network**. It is designed for networks you trust (home, your own hotspot).
It is **not** hardened to be exposed to the internet, and you should never port-forward it.

### What it protects

| Threat | Protection |
| --- | --- |
| Another device controlling your Hoster (stop sharing, read folder names, change the PIN) | The Host UI and every `/api/*` endpoint answer **only the device running Hoster** (loopback). Other devices get `403` on both ports; they cannot open the live-activity WebSocket either. |
| Reading or uploading files without the PIN | One shared check guards `/files`, `/view`, `/view-dir`, `/view-asset`, `/upload` and WebDAV (PIN = Basic-auth password); `/pdf` uses the same check. Covered by automated tests, including mutation-tested regressions. |
| Guessing the 4-digit PIN | After 5 wrong PINs an address is locked out for 5 minutes (HTTP 429). Page loads without a PIN are not counted as guesses. The owner's own device is never locked out. |
| The PIN leaking through URLs (history, logs, Referer) | The portal never puts the PIN in a URL. After one correct PIN the browser gets a signed session cookie (`HttpOnly`, `SameSite=Strict`, 12 h, dies when the server restarts) that every PIN-guarded route accepts; links for VLC/MX Player use per-file tokens instead. The PDF unlock form redirects to a URL without the PIN. A valid session is not a guess, so it keeps working while a guesser is locked out. |
| The PIN leaking through links given to VLC | Links for external players carry short-lived (24 h) signed tokens bound to one path, never the PIN. A token cannot open another file, folder, or endpoint. |
| Path traversal (`../`, encoded variants, symlinks out of the share) | Every route resolves paths inside the shared folder; folder playlists skip symlinks. Covered by tests. |
| Tokens/cookies being forged | HMAC-SHA256 with a random per-run secret (tokens stop working when the server restarts). Viewer cookie is `HttpOnly; SameSite=Lax`. |
| Script injection through file names or song tags | The portal escapes file names; the radio UI (portal and Host UI) writes titles with `textContent` only. Static tests fail if `innerHTML` is introduced in the radio code or a raw file name is interpolated into the portal's HTML. |
| Referer leaks | `Referrer-Policy: no-referrer` on all responses. |
| Cookie theft by page scripts, or other sites riding your session | `HttpOnly` (scripts can't read it) and `SameSite=Strict` (other sites can't make the browser send it); `Secure` is added when HTTPS is on. |
| Settings file exposure | Settings (including the PIN) live in the app-private data folder with mode `0600`. |

### Known limitations (please read)

- **Symlinks inside the shared folder are followed.** Path checks are lexical: `../` can't escape the share, but a symlink *you* place inside it that
  points elsewhere will serve its target. (Folder playlists and the radio's folder scans skip symlinks.)
- **Hoster Radio, jukebox mode:** with "Let guests add songs" on, any device that passes the PIN can queue songs (max 100 per folder, 500 in the queue).
  It cannot skip, remove or reorder — those are owner-only. For files the server can't read the length of, a listener may report it once
  (it must be plausible for the file size), so such a file can be mis-timed by a guest; readable files can't.

- **Traffic is plain HTTP by default.** Anyone who can sniff your Wi-Fi can read it, including the PIN when it is typed and the session cookie afterwards.
  Optional HTTPS uses a **self-signed** certificate (browsers will warn). Use a Wi-Fi network you trust.
- **A 4-digit PIN is weak by nature.** The lockout makes online guessing slow, not impossible for a patient attacker
  using several addresses. Treat the PIN as a courtesy lock, not strong authentication.
- **WebDAV sends the PIN as an HTTP Basic password** (any username), so over plain HTTP it is readable on the network like everything else.
  WebDAV is read-only unless "Client file uploads" is on. Leave it off unless you need it.
- **Uploads let connected devices write to your shared folder** (when enabled, and after the PIN). Enable only when needed.
- **`HOSTER_ALLOW_REMOTE_HOST_UI=1`** disables the owner-only protection of the Host UI. Don't set it on a shared network.
- The PIN is stored unhashed in the private settings file (it is shown back to you in the Host UI).
- The Android app asks for "All files access" so it can share arbitrary folders. Share a specific folder, not your whole storage, when you can.

## For contributors

Changes touching authentication, tokens, routing of `/api` or `/host`, or file access need tests in `test/security.test.js` or
`test/auth.test.js`. See [CONTRIBUTING.md](CONTRIBUTING.md).
