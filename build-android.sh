#!/bin/bash
set -e
cd /home/titan/React/Hoster
SRC=/home/titan/React/Hoster/HosterApp/nodejs-assets/nodejs-project
cp -r src/* $SRC/src/
cp -r public/* $SRC/public/
mkdir -p HosterApp/android/app/src/main/assets
cd HosterApp && npx react-native bundle --platform android --dev false --entry-file index.js --bundle-output android/app/src/main/assets/index.android.bundle --assets-dest android/app/src/main/res
cd android && JAVA_HOME=/home/titan/React/Hoster/HosterApp/jdk-17.0.10+7 ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.hosterapp/.MainActivity
