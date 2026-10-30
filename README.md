<div align="center">

# 🚀 Hoster

**Turn your phone (or PC) into a private Wi-Fi media server and file hub.**
Browse files, stream lossless audio and 4K video in **VLC** with one tap, and upload — with no cloud and no cables.

[![CI](https://github.com/nexus-being-787/Hoster/actions/workflows/ci.yml/badge.svg)](https://github.com/nexus-being-787/Hoster/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node 20+](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white)
![Android](https://img.shields.io/badge/Android-3DDC84?logo=android&logoColor=white)
![VLC](https://img.shields.io/badge/VLC-FF8800?logo=vlc&logoColor=white)

*Share anything locally. Stream lossless media without heavy battery drain.*

</div>

---

## What is Hoster?

Hoster is a React Native app with an embedded [nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile-react-native)
Express server. It lets any laptop, PC, phone or smart TV **on the same Wi-Fi** browse your files, stream media and upload files
through a web browser. There are also Linux and Windows desktop builds (Electron) of the same server.

- 📁 **Share any folder** from your phone's storage over Wi-Fi.
- ▶️ **One-tap VLC streaming** — files and whole folders play straight from the phone; nothing is saved to disk on the client.
- 🔐 **Optional PIN**, brute-force lockout, and an owner-only control panel ([security model](SECURITY.md)).
- 👥 **Connected-devices dashboard** with one-tap IP blocking.
- 📤 **Client uploads** and a read-only/read-write **WebDAV** mode.
- 📻 **Hoster Radio** — turn the phone into a private radio station: everyone on the Wi-Fi hears the **same song at the same moment** (silent-disco style), with a shared queue.
- 📌 **Stable address:** `hoster.local` keeps working when your phone's IP changes; QR code for quick connect.
- 🔋 **Keeps sharing with the screen off** (Android foreground service) and shows a notification with a **Stop sharing** button.
- ⚡ **Zero cloud dependency** — all traffic stays on your local network; fonts are bundled, so it works fully offline.

## How playback works (and why VLC)

Browsers can't natively decode high-bitrate or exotic formats such as 24-bit WAV, FLAC, ALAC or MKV — and transcoding 1080p/4K on a phone
would overheat it and drain the battery in minutes. So Hoster **hands the stream to a real player** instead:

1. You tap **Play in VLC** (or **VLC** in a folder to play the whole folder).
2. The portal asks the server for the phone's *current* address and a short-lived token for that file, then opens
   `vlc://http://<phone-ip>:<port>/files/stream?path=…&t=…`.
3. VLC streams the file live with HTTP Range requests (seeking works) using native hardware decoding. **No `.m3u` file is downloaded**;
   folder playlists are generated in memory.

| Client | What happens |
| --- | --- |
| Android | `intent://` link opens VLC (or MX Player) directly |
| iOS | `vlc://` opens VLC for iOS |
| Windows | `vlc://` once you run the **one-time setup** the button offers (VLC doesn't register the link itself) |
| Linux / macOS / anything else | The stream link is copied → VLC → <kbd>Ctrl</kbd>+<kbd>N</kbd> → paste |

The link never contains your PIN — only a token valid for that one file (24 h).

## Quick start

### Run it on a computer (no phone needed)

```bash
git clone https://github.com/nexus-being-787/Hoster.git
cd Hoster
npm install
npm start
```

Open <http://localhost:9090/host>, choose a folder, press **Start**. Other devices then open the address shown (QR code included).

### Build the Android app

Requirements: Node 20+, JDK 17, the Android SDK, optionally `adb`.

```bash
npm install
(cd HosterApp && npm install)
./build-android.sh         # bundles the JS, runs Gradle, installs over ADB if a device is connected
```

The APK lands in `release/app/` (git-ignored). Because the foreground service and bridge are native code, re-run the script after pulling
changes — a JS-only reload won't include them. Pre-built APKs, when available, are attached to
[GitHub Releases](https://github.com/nexus-being-787/Hoster/releases).

### Desktop apps

See [`linux/README.md`](linux/README.md) and [`windows/README.md`](windows/README.md).

## 📻 Hoster Radio — listen together, in sync

Press **Queue shared folder** in the Host UI (or **+ Add this folder** / **Add to Radio** in the portal) and the phone becomes a radio station.
Anyone on the Wi-Fi taps **Radio → Tune in** in their browser and hears the same moment of the same song as everybody else — on their own
phone, speaker or headphones.

- **One shared clock.** The server keeps a single queue and playback position; every listener works out "where are we in the song" from it.
- **Corrects for wrong clocks and Wi-Fi jitter.** Each browser estimates how far its own clock is from the host's (NTP-style, using the
  fastest replies), then nudges its `<audio>` with an inaudible ±5 % playback-rate change for small drift, or a seek when clearly off.
  In tests, devices whose clocks were off by up to **45 s**, with up to 120 ms of random reply delay, agreed on the playback position within **~30 ms**.
  (That is clock agreement. Software can't measure a device's audio-output latency, so on a Bluetooth speaker use the **Speaker delay compensation** slider
  in the panel — raise it until that device lines up with the others; it's remembered per browser.)
- **Host controls:** play/pause, next/prev, shuffle, repeat, remove songs, clear — and an optional **"Let guests add songs"** switch (jukebox mode).
- **Safe by design:** the station honours the PIN and lockout like everything else; stream links carry per-song tokens, never the PIN;
  the control API is owner-only; song lengths are read from the files by the server (a guest can't make the station skip songs by lying about a duration).
- Needs a browser that can play the file (MP3, AAC, FLAC, OGG, WAV… — not every format on every browser). Use **Play in VLC** for the rest.

## Using Hoster

1. Open the app, pick a folder, optionally set a PIN, press **Start**.
2. On another device open `http://hoster.local:8080` (or the IP shown as a backup, or scan the QR code).
3. Browse, preview, download, upload (if enabled), or tap **Play in VLC**.
4. Press **Stop** in the app — or **Stop sharing** in the notification.

### A stable address when your IP keeps changing

An app can't assign its own static IP, so Hoster makes the address matter less:

1. **Use the hostname.** `hoster.local` (or your custom name) is announced over mDNS and re-announced within seconds of an IP change.
   Works on Windows 10/11, macOS, iOS and Linux; some Android browsers can't resolve `.local` — switch the main address to **IP** in the Host UI for those.
2. **Reserve the IP on your router** (DHCP reservation for the phone's MAC address) — then even the IP URL never changes.
3. **Or set a static IP on the phone**: Wi-Fi → your network → Advanced → IP settings → Static.

## Security at a glance

Designed for networks **you trust**. Full details and limitations in [SECURITY.md](SECURITY.md).

- The Host UI and all `/api/*` endpoints work **only from the device running Hoster**; other devices get `403`.
- A PIN protects every route that reads or writes your files (portal, viewer, PDF, uploads, WebDAV, radio). The PIN is never put in a URL — a signed session cookie takes over after one correct entry.
  5 wrong PINs lock an address out for 5 minutes.
- Plain HTTP by default; optional HTTPS uses a self-signed certificate. A 4-digit PIN is a courtesy lock, not strong authentication.
- Please report vulnerabilities privately (see SECURITY.md).

## Project layout

```text
.
├── src/                    # ★ Node.js server — source of truth
│   ├── server.js           #   Express app, owner-only guard, WebSocket, device tracking, IP blocklist
│   ├── routes/             #   files (list/stream/zip/playlist), upload, view, pdf, radio
│   ├── utils/              #   auth (PIN, lockout, tokens), radio (station state machine), duration (file lengths),
│   │                       #   media + paths (shared folder scanning / safe paths), config, network, security
│   └── host-ui/            #   Host dashboard (HTML/CSS/JS, bundled fonts)
├── public/                 # ★ Client web portal — source of truth (player-links.js builds VLC links;
│                           #   radio.js + radio-sync.js are the listener side of Hoster Radio)
├── HosterApp/              # React Native Android app
│   ├── App.tsx             #   boot, WebView, foreground-service sync, permission prompts
│   ├── android/            #   Gradle project + native HosterForegroundService / bridge module
│   └── nodejs-assets/      #   embedded Node project (mirror of src/ and public/)
├── linux/  windows/        # Electron desktop builds (mirror of src/ and public/)
├── test/                   # server test suite (node:test)
├── scripts/sync-copies.js  # mirrors src/ + public/ into the builds above
├── docs/ARCHITECTURE.md
└── build-android.sh
```

`src/` and `public/` at the root are the **only** place to edit; run `npm run sync` to update the mirrors.

## Development

```bash
npm test               # server + front-end suites (a few minutes). Starts real servers on free ports.
                       # (some duration tests use ffmpeg and are skipped if it isn't installed)
npm run sync           # mirror src/ + public/ into linux/, windows/ and the Android project
npm run sync:check     # CI check: fails if a mirror is stale
HOSTER_TEST_ROOT=$PWD/linux npm test    # run the same tests against a shipped copy

cd HosterApp && npm ci --ignore-scripts && npx tsc --noEmit && npx jest   # mobile app
```

CI runs all of this on Node 20 and 22. It can't build or run the Android APK — please state which device you tested on in pull requests.
See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Roadmap

Ideas that would make good contributions (not yet implemented):

- [x] ~~Queue / shuffle and a "now playing" view~~ → shipped as Hoster Radio
- [ ] Radio: automatic latency calibration (mic-based "clap test"), vote-to-skip, and a "play the radio in VLC" link
- [ ] Subtitle auto-attach (`.srt`) for videos; cover art and thumbnails
- [ ] Search, sort and pagination for very large folders
- [x] ~~Keep the PIN out of ZIP / viewer / media URLs~~ → session cookie
- [ ] Opt-in auto-resume after reboot / Wi-Fi reconnect
- [ ] Android: automated instrumentation tests; publish signed APKs on GitHub Releases / F-Droid
- [ ] Per-device PINs or one-time pairing instead of a shared 4-digit PIN

## Philosophy

Keep data local. Stream raw quality. Offload heavy work to native decoders. Build clean, reliable tools.

## Contributing

Issues and pull requests are welcome — start with [CONTRIBUTING.md](CONTRIBUTING.md). Please be kind
([Code of Conduct](CODE_OF_CONDUCT.md)).

## License

[MIT](LICENSE). Bundled fonts (Outfit, JetBrains Mono) are licensed under the SIL Open Font License 1.1 —
see the `fonts/` folders.
