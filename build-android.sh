#!/bin/bash
set -e
cd /home/titan/React/Hoster
SRC=/home/titan/React/Hoster/HosterApp/nodejs-assets/nodejs-project
cp -r src/* $SRC/src/
cp -r public/* $SRC/public/
cp package.json $SRC/package.json
rsync -a --delete node_modules/ $SRC/node_modules/
mkdir -p HosterApp/android/app/src/main/assets
cd HosterApp && npx react-native bundle --platform android --dev false --entry-file index.js --bundle-output android/app/src/main/assets/index.android.bundle --assets-dest android/app/src/main/res
cd android && JAVA_HOME=/home/titan/React/Hoster/HosterApp/jdk-17.0.10+7 ./gradlew assembleDebug

mkdir -p /home/titan/React/Hoster/release/app
cp app/build/outputs/apk/debug/app-debug.apk /home/titan/React/Hoster/release/app/Hoster-Stable.apk
echo "==> Stable APK created at: release/app/Hoster-Stable.apk"

if adb get-state >/dev/null 2>&1; then
    echo "==> Installing to connected device via ADB..."
    adb install -r app/build/outputs/apk/debug/app-debug.apk
    adb shell am start -n com.hosterapp/.MainActivity
else
    echo "==> No ADB device connected. Sideload release/app/Hoster-Stable.apk manually."
fi
