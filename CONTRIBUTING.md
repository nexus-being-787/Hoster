# Contributing to Hoster

Thanks for helping! Hoster is small on purpose: an Express server, a web portal, a Host UI, and a React Native shell for Android
(plus Electron shells for Linux/Windows).

## Quick start

Requires **Node.js 20+**.

```bash
git clone https://github.com/nexus-being-787/Hoster.git
cd Hoster
npm install
npm start                 # server + Host UI → open http://localhost:9090/host
npm test                  # 95+ tests, ~1 minute
```

In the Host UI pick a folder and press **Start**. The client portal is then on the share port (default 8080).

## The one rule about copies

`src/` and `public/` at the repository root are the **single source of truth**. The Linux, Windows and Android builds
each bundle a mirror of them. **Never edit the mirrors** — edit the root, then:

```bash
npm run sync        # copy root → linux/, windows/, HosterApp/nodejs-assets/nodejs-project/
npm run sync:check  # what CI runs; fails if a mirror is out of date
```

## Tests

- `npm test` runs the server suite (Node's built-in test runner, no extra dependencies). It starts real servers on free ports.
- Run it against a shipped copy exactly like CI does: `HOSTER_TEST_ROOT=$PWD/linux npm test`.
- Mobile app: `cd HosterApp && npm ci --ignore-scripts && npx tsc --noEmit && npx jest`.

**Security-sensitive changes must come with tests.** If you touch PIN handling, tokens, `/api` or `/host` access, or file path
handling, add cases to `test/security.test.js` or `test/auth.test.js`. A good test fails when you break the protection —
try deleting your fix and confirm the test goes red.

## Android

The foreground service and native bridge live in `HosterApp/android/app/src/main/java/com/hosterapp/`.
Build with `./build-android.sh` (needs JDK 17, the Android SDK, and optionally `adb`). Please say in your PR which Android
version and device you tested on — CI cannot build or run the APK.

## Pull requests

1. Open an issue first for anything bigger than a small fix, so we can agree on the approach.
2. Keep PRs focused; describe *why*, not just *what*.
3. Make sure `npm test` and `npm run sync:check` pass.
4. Update `CHANGELOG.md` under **Unreleased** when behaviour changes.

## Code style

2-space indent, LF line endings (see `.editorconfig`). No new runtime dependencies without discussion — the Android
build bundles `node_modules`, so every dependency adds to the APK size.

## Conduct

Be kind. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
