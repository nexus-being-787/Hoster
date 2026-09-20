# 🧪 Hoster

<div align="center">

# 🚀 Hoster — Local Wi-Fi Media Server & File Hub

*Turn your Android device into a fast, privacy-focused local media server and file sharing portal.*

![React Native](https://img.shields.io/badge/React_Native-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?style=for-the-badge&logo=express&logoColor=white)
![Android](https://img.shields.io/badge/Android-3DDC84?style=for-the-badge&logo=android&logoColor=white)
![VLC](https://img.shields.io/badge/VLC-FF8800?style=for-the-badge&logo=vlc&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)

---

*"Share anything locally. Stream lossless media without heavy battery drain."*

</div>

---

## 📖 About

**Hoster** is a hybrid mobile application combining **React Native** and an embedded **`nodejs-mobile` Express server**. It turns your Android phone into a high-speed local network server, enabling any laptop, PC, phone, or smart TV on the same Wi-Fi network to browse files, stream videos, play high-resolution audio, and upload files directly through a web browser.

Key highlights:
* 📁 **Share local phone storage** (`/storage/emulated/0`) over Wi-Fi.
* 🔒 **PIN Authentication** for access security.
* 👥 **Connected Devices Tracker & One-Tap IP Blocking**.
* 🎧 **Lossless & Heavy Format Media Streaming** via `.m3u` playlists and external players.
* ⚡ **Zero Cloud Dependency** — 100% private local network transmission.

---

## 🎵 Why `.m3u` & External Players? (The Magic Behind Streaming)

<div align="center">
<img src="https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExbnYxMWJtb2p6b29uMnBzOG1ydXJxdTZtcjJtazVtbDJydnR4eXpsMSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/3o7TKSjRrfIPjeiVyM/giphy.gif" alt="Streaming Media" width="400" />
</div>

### ❓ The Problem with Web Browsers
Modern web browsers (like Mobile Chrome or Safari) have strict built-in limitations. They **cannot** natively decode high-bitrate or specialized audio/video codecs such as **24-bit WAV, FLAC, MKV, or ALAC**. 

If a browser tries to play these files directly inside an HTML `<video>` or `<audio>` tag:
1. The media player will fail or show a disabled black screen.
2. The browser will force the user to download the entire multi-gigabyte file before viewing.

### ❓ Why Not Transcode on the Phone?
Transcoding high-definition videos (e.g. 1080p/4K MKV) on-the-fly using heavy libraries like `ffmpeg` inside an embedded phone server would severely overheat your mobile device, drain battery within minutes, and cause severe streaming lag.

### 💡 The `.m3u` Solution
Instead of forcing browser playback or burning out your phone's processor:
1. Hoster generates an instant, lightweight **`.m3u` playlist stream URL** for unsupported formats.
2. When you tap **Open in External Player**, your OS downloads a tiny text shortcut file (`.m3u`).
3. Opening the `.m3u` instantly launches dedicated media players like **VLC Media Player**, **MX Player**, or **IINA**.
4. VLC reads the direct HTTP stream link inside the `.m3u` and streams the file live from your phone using native hardware acceleration!

---

## ⚡ Key Features

- 📂 **Directory Selector**: Browse and share any folder on your Android phone.
- 👥 **Connected Devices Dashboard**: Monitor connected clients in real-time, view connection timestamps, User-Agents, and easily **Block/Disconnect** unwanted IPs.
- 🔐 **Custom Security PIN**: Optional 4-digit PIN protection for client access.
- 📤 **Client File Uploads**: Enable connected devices to upload files back to your phone.
- 🛠️ **Mali GPU Workaround**: Custom WebView rendering layer (`opacity: 0.99`) ensuring zero app freezes or white screens on Mali-based mobile GPUs.

---

## 📂 Repository Structure

```text
.
├── HosterApp/                   # React Native Android host app
│   ├── android/                 # Android Gradle project & native source
│   ├── nodejs-assets/           # Embedded Node.js runtime code
│   └── App.tsx                  # React Native entry point & WebView container
├── src/                         # Core Node.js Express server
│   ├── server.js                # Express app, WebSocket stats, IP blocklist & device tracking
│   ├── host-ui/                 # Host dashboard web app (HTML/CSS/JS)
│   ├── routes/                  # File browsing, downloads, upload & streaming APIs
│   └── utils/                   # PIN authentication & network helper functions
├── public/                      # Client web portal static frontend (HTML5 audio/video UI)
├── release/                     # Compiled distribution releases
│   └── app/
│       └── Hoster-Stable.apk    # Ready-to-install Android APK
├── build-android.sh             # Automated React Native bundle & Gradle build script
└── README.md                    # Project documentation
```

---

## 🎯 Purpose

The goal of Hoster is to:

* 🚀 Provide lightning-fast local file transfers without cables or cloud storage.
* 📺 Enable lossless streaming of large video/audio libraries to PCs and TVs.
* 🔐 Maintain complete privacy by keeping all traffic within your local Wi-Fi.
* ⚡ Eliminate phone overheating by smart `.m3u` stream handoffs to native decoders.

---

## ⚡ Philosophy

> Keep data local.
> 
> Stream raw quality.
> 
> Offload heavy work to native decoders.
> 
> Build clean, reliable tools.

---

## 🚀 Building & Installation

To build and deploy the app directly to a connected Android device via ADB:

```bash
# Make the build script executable and run it
chmod +x build-android.sh
./build-android.sh
```

Pre-compiled APK location:
`release/app/Hoster-Stable.apk`

---

<div align="center">

### ⭐ Thanks for using Hoster!

**Happy hosting & streaming!** 🚀

</div>
