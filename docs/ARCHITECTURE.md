# Architecture

```
 ┌────────────── the phone / PC running Hoster ──────────────┐        ┌──── other devices on the Wi-Fi ────┐
 │                                                            │        │                                    │
 │  React Native app (Android)  or  Electron shell (desktop)  │        │  browser → client portal           │
 │        │ WebView                                           │        │  VLC / MX Player → /files/stream   │
 │        ▼                                                   │        │  file manager → /webdav            │
 │  Host UI  http://127.0.0.1:9090/host   (owner only)        │        │                                    │
 │        │ /api/*  + WebSocket (owner only)                  │        └──────────────┬─────────────────────┘
 │        ▼                                                   │                       │ share port (default 8080)
 │  Express server  (src/server.js)  ◄───────────────────────────────────────────────┘
 │    ├─ guard: /host and /api/* only from loopback           │
 │    ├─ auth: PIN check, lockout, signed tokens, viewer cookie (src/utils/auth.js)
 │    ├─ /files   list · stream (Range) · download · zip · playlist.m3u · addr
 │    ├─ /upload  /view  /pdf  /webdav  (all behind the PIN when enabled)
 │    └─ settings: <data dir>/config.json (src/utils/config.js)
 │                                                            │
 │  Android only: HosterForegroundService (wake + Wi-Fi +     │
 │  multicast locks, notification with Stop button)           │
 └────────────────────────────────────────────────────────────┘
```

## Two ports, one app

The same Express `app` listens on **9090** (Host UI) and on the **share port** (default 8080). Because of that, the owner-only
guard is applied *per request* by source address (loopback), not per port — `/api/stop` is refused from another device on either port.

## Playing media without saving files

1. The portal asks `GET /files/addr?path=…` (with the PIN). The server answers with the address the client actually reached
   it on and, if a PIN is set, two signed tokens: `t` (stream this file) and `pt` (fetch this file's/folder's playlist).
2. `public/js/player-links.js` builds `vlc://http://<ip>:<port>/files/stream?path=…&t=…` (or an Android `intent://`).
3. VLC streams with HTTP Range requests. For a folder, VLC fetches `/files/playlist.m3u`, which the server builds in memory and
   whose entries each carry their own token.

Tokens are `<expiry>.<HMAC-SHA256(scope|path|expiry)>` signed with a random per-process secret, so a link works for one path
for 24 h and stops working when the server restarts.

## Hoster Radio

```
 owner (Host UI) ──/api/radio/*──►┐                         ┌──► GET /radio/state ◄── every listener, every ~1.5 s
                                  ▼                         │
                        Radio station  (src/utils/radio.js) ┘     guests may POST /radio/add (if allowed)
                        queue · index · status · startedAt        and POST /radio/duration (fallback only)
                                  ▲
        background probe (src/utils/duration.js, music-metadata) fills in song lengths + tags
```

- **The station is a pure state machine** (injectable clock + RNG, no timers). Track changes are evaluated lazily whenever anyone reads the
  state, so nothing drifts because a timer fired late. A song that ended less than 5 s ago chains gaplessly; a long-overdue one restarts fresh.
- **Every snapshot carries `serverNow` and `positionMs`.** A listener (`public/js/radio-sync.js`) estimates `serverClock − localClock` from
  request/response timestamps (midpoint of the fastest third of recent replies, median), computes where the song should be *right now*, then:
  `|drift| < 30 ms` → leave it; `< 400 ms` → change `playbackRate` by at most ±5 %; otherwise seek.
- **Song lengths come from the server**, not the browsers, so a guest can't skip songs by lying. Probing is asynchronous and in queue order, so
  adding songs is instant. Ids are never reused, so a late probe can't land on a different song.
- Stream links in the state use the same path-bound tokens as VLC links; `/radio/*` sits behind the PIN guard, `/api/radio/*` behind the owner-only guard.
- Tested end to end by running the real `radio.js` / `host.js` against a real server with a fake DOM and a fake `<audio>` that plays in real time
  on phones whose wall clocks are deliberately wrong.

## Android specifics

- The Node server runs inside the app via [nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile-react-native).
  `App.tsx` starts it, waits until `/api/status` answers, then shows the Host UI in a WebView.
- While sharing, `HosterForegroundService` keeps the process alive and holds a **multicast lock** (without it Android drops mDNS
  packets and `hoster.local` never resolves).
- The notification's **Stop sharing** button POSTs to `http://127.0.0.1:9090/api/stop`.

## Source of truth

Root `src/` and `public/` → mirrored into `linux/`, `windows/` and `HosterApp/nodejs-assets/nodejs-project/` by
`npm run sync`. CI fails if a mirror is stale and runs the test suite against each mirror.
