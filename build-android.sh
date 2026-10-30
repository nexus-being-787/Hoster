#!/bin/bash
set -e
# Run from the repo root, wherever it is cloned
cd "$(dirname "$0")"
ROOT="$(pwd)"
SRC="$ROOT/HosterApp/nodejs-assets/nodejs-project"

# Mirror src/ and public/ into the Android project (same tool CI uses to check the copies)
node scripts/sync-copies.js
cp package.json "$SRC/package.json"
rsync -a --delete node_modules/ "$SRC/node_modules/"
mkdir -p HosterApp/android/app/src/main/assets
cd HosterApp && npx react-native bundle --platform android --dev false --entry-file index.js --bundle-output android/app/src/main/assets/index.android.bundle --assets-dest android/app/src/main/res
# JDK 17 required. Uses $JAVA_HOME if set, otherwise a JDK unpacked at HosterApp/jdk-17.0.10+7 (git-ignored).
export JAVA_HOME="${JAVA_HOME:-$ROOT/HosterApp/jdk-17.0.10+7}"
export ANDROID_HOME="${ANDROID_HOME:-/home/titan/Android/Sdk}"
cd android && ./gradlew assembleDebug

mkdir -p "$ROOT/release/app"
cp app/build/outputs/apk/debug/app-debug.apk "$ROOT/release/app/Hoster-Stable.apk"
echo "==> Stable APK created at: release/app/Hoster-Stable.apk"

if adb get-state >/dev/null 2>&1; then
    echo "==> Installing to connected device via ADB..."
    adb install -r app/build/outputs/apk/debug/app-debug.apk
    adb shell am start -n com.hosterapp/.MainActivity
else
    echo "==> No ADB device connected. Sideload release/app/Hoster-Stable.apk manually."
fi
