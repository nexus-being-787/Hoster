import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  Linking,
  NativeModules,
  PermissionsAndroid,
  Platform,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { WebView, WebViewNavigation } from 'react-native-webview';
import nodejs from 'nodejs-mobile-react-native';

const HOST = 'http://127.0.0.1:9090';
const HOST_URL = `${HOST}/host`;
const STATUS_URL = `${HOST}/api/status`;

const BOOT_TIMEOUT_MS = 25000; // how long we wait for the embedded Node server
const POLL_MS = 2500; // how often we sync the foreground service with the server state
const MAX_WEBVIEW_RETRIES = 5;

// Native helper (HosterForegroundService). Undefined on iOS / on a build made before it existed,
// so every call below is optional-chained and the app still works without it.
const Native: any = NativeModules.HosterService;

type Phase = 'boot' | 'ready' | 'failed';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function fetchStatus(): Promise<any | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const r = await fetch(STATUS_URL, { signal: ctrl.signal });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Only runtime permissions that can be granted with a normal dialog. "All files access" and the
// battery exemption are handled contextually below, so we never nag on every launch.
async function requestRuntimePermissions() {
  if (Platform.OS !== 'android') return;
  try {
    if (Platform.Version < 30) {
      await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE,
        PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
      ]);
    }
    if (Platform.Version >= 33) {
      await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES,
        PermissionsAndroid.PERMISSIONS.READ_MEDIA_VIDEO,
        PermissionsAndroid.PERMISSIONS.READ_MEDIA_AUDIO,
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      ]);
    }
  } catch (e) {
    console.warn('permission request failed', e);
  }
}

// Open a link in the user's real browser/app; never throw into the WebView callback.
const openExternal = (url: string) => {
  try {
    Promise.resolve(Linking.openURL(url)).catch(() => {});
  } catch {
    /* no handler for this scheme */
  }
};

const isLocalUrl = (url: string) =>
  /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(url) ||
  /^(about:|blob:|data:)/i.test(url);

const App = () => {
  const [phase, setPhase] = useState<Phase>('boot');
  const [bootId, setBootId] = useState(0);
  const [webviewKey, setWebviewKey] = useState(0);

  const webRef = useRef<WebView>(null);
  const canGoBack = useRef(false);
  const nodeStarted = useRef(false);
  const permsAsked = useRef(false);
  const webviewRetries = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lastNotif = useRef('');
  const serviceOn = useRef(false);
  const asked = useRef({ files: false, battery: false });

  // ── Boot: permissions → start Node once → wait until the server really answers ──────────────
  useEffect(() => {
    let cancelled = false;

    const onMsg = (msg: unknown) => {
      if (msg === 'started' && !cancelled) setPhase(p => (p === 'boot' ? 'ready' : p));
    };
    nodejs.channel.addListener('message', onMsg);

    (async () => {
      if (!permsAsked.current) {
        permsAsked.current = true;
        await requestRuntimePermissions();
      }
      if (!nodeStarted.current) {
        nodeStarted.current = true;
        try {
          nodejs.start('src/server.js');
        } catch (e) {
          console.warn('nodejs.start failed', e);
        }
      }
      const deadline = Date.now() + BOOT_TIMEOUT_MS;
      while (!cancelled && Date.now() < deadline) {
        if (await fetchStatus()) {
          if (!cancelled) setPhase('ready');
          return;
        }
        await sleep(400);
      }
      if (!cancelled) setPhase(p => (p === 'boot' ? 'failed' : p));
    })();

    return () => {
      cancelled = true;
      nodejs.channel.removeListener('message', onMsg);
    };
  }, [bootId]);

  const retryBoot = () => {
    webviewRetries.current = 0;
    setPhase('boot');
    setBootId(n => n + 1);
  };

  // ── "All files access" (Android 11+): only ask when it is actually missing ──────────────────
  const checkAllFiles = useCallback(async () => {
    if (Platform.OS !== 'android' || Platform.Version < 30) return;
    if (!Native?.hasAllFilesAccess || asked.current.files) return;
    if (await Native.hasAllFilesAccess()) return;
    asked.current.files = true;
    Alert.alert(
      'All Files Access needed',
      'To share your music, videos and folders, Hoster needs "All files access".\n\nTap Open Settings and switch it on for Hoster, then come back.',
      [
        { text: 'Later', style: 'cancel' },
        { text: 'Open Settings', onPress: () => Native.openAllFilesSettings() },
      ],
    );
  }, []);

  // ── Foreground service follows the server: running → keep-alive + notification, stopped → off ─
  const syncService = useCallback(async () => {
    if (Platform.OS !== 'android' || !Native?.start) return;
    const st = await fetchStatus();
    if (!st) return;

    if (st.running) {
      const devices: number = st.devices ?? 0; // devices active in the last 5 minutes
      const lines = [
        st.url || st.localUrl,
        st.localUrl && st.url && st.url !== st.localUrl ? `IP: ${st.localUrl}` : null,
        `${devices} device${devices === 1 ? '' : 's'} active`,
      ]
        .filter(Boolean)
        .join('\n');

      if (lastNotif.current !== lines) {
        lastNotif.current = lines;
        serviceOn.current = true;
        // If Android refuses (e.g. app is in the background on 12+), forget it so the next sync retries.
        Promise.resolve(Native.start('Hoster is sharing', lines))
          .then((ok: boolean) => {
            if (ok === false) {
              lastNotif.current = '';
              serviceOn.current = false;
            }
          })
          .catch(() => {
            lastNotif.current = '';
          });
      }

      // First time sharing this session: ask (once) to be exempt from battery optimisation,
      // otherwise many phones still kill the server minutes after the screen turns off.
      if (!asked.current.battery && Native.isIgnoringBatteryOptimizations) {
        asked.current.battery = true;
        if (!(await Native.isIgnoringBatteryOptimizations())) {
          Alert.alert(
            'Keep Hoster running',
            'So songs and videos keep streaming when your screen is off, let Hoster run in the background.',
            [
              { text: 'Not now', style: 'cancel' },
              { text: 'Allow', onPress: () => Native.requestIgnoreBatteryOptimizations() },
            ],
          );
        }
      }
    } else if (serviceOn.current) {
      serviceOn.current = false;
      lastNotif.current = '';
      Native.stop();
    }
  }, []);

  useEffect(() => {
    if (phase !== 'ready') return;
    checkAllFiles();
    syncService();
    const id = setInterval(syncService, POLL_MS);
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') syncService();
    });
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [phase, checkAllFiles, syncService]);

  // ── Android back button: step back inside the Host UI, only then leave the app ──────────────
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBack.current && webRef.current) {
        webRef.current.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, []);

  useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    },
    [],
  );

  const reloadWebView = () => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    if (webviewRetries.current >= MAX_WEBVIEW_RETRIES) {
      setPhase('failed');
      return;
    }
    webviewRetries.current += 1;
    retryTimer.current = setTimeout(() => setWebviewKey(k => k + 1), 1500);
  };

  // ── UI ───────────────────────────────────────────────────────────────────────────────────────
  if (phase === 'boot') {
    return (
      <View style={styles.center}>
        <StatusBar barStyle="light-content" backgroundColor={BG} />
        <ActivityIndicator size="large" color={ACCENT} />
        <Text style={styles.msg}>Starting Hoster…</Text>
      </View>
    );
  }

  if (phase === 'failed') {
    return (
      <View style={styles.center}>
        <StatusBar barStyle="light-content" backgroundColor={BG} />
        <Text style={styles.title}>Hoster couldn't start</Text>
        <Text style={styles.sub}>
          The built-in server didn't respond. Close other apps to free memory, then try again.
        </Text>
        <TouchableOpacity style={styles.btn} onPress={retryBoot} activeOpacity={0.8}>
          <Text style={styles.btnText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.fill}>
      <StatusBar barStyle="light-content" backgroundColor={BG} />
      <WebView
        ref={webRef}
        key={webviewKey}
        source={{ uri: HOST_URL }}
        style={styles.web}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        originWhitelist={['*']}
        cacheMode="LOAD_NO_CACHE" // never show a stale Host UI after an app update
        textZoom={100} // keep layout stable regardless of the system font size
        overScrollMode="never"
        setBuiltInZoomControls={false}
        setDisplayZoomControls={false}
        onShouldStartLoadWithRequest={(req: { url: string }) => {
          if (isLocalUrl(req.url)) return true;
          openExternal(req.url); // external links open in the real browser
          return false;
        }}
        onNavigationStateChange={(n: WebViewNavigation) => {
          canGoBack.current = n.canGoBack;
        }}
        onLoadEnd={() => {
          webviewRetries.current = 0;
        }}
        onError={reloadWebView}
        onRenderProcessGone={() => setWebviewKey(k => k + 1)}
        onHttpError={(e: { nativeEvent: { statusCode: number } }) =>
          console.log('WebView HTTP error:', e.nativeEvent.statusCode)
        }
        startInLoadingState
        renderLoading={() => (
          <View style={[styles.center, StyleSheet.absoluteFill]}>
            <ActivityIndicator size="large" color={ACCENT} />
            <Text style={styles.msg}>Loading…</Text>
          </View>
        )}
      />
    </SafeAreaView>
  );
};

const BG = '#08090f';
const ACCENT = '#00e5ff';

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: BG },
  web: { flex: 1, backgroundColor: BG, opacity: 0.99 },
  center: {
    flex: 1,
    backgroundColor: BG,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
    padding: 32,
  },
  msg: { color: ACCENT, fontSize: 15, fontWeight: '500' },
  title: { color: '#fff', fontSize: 20, fontWeight: '700' },
  sub: { color: '#a0a0b0', fontSize: 14, textAlign: 'center', lineHeight: 21 },
  btn: { backgroundColor: ACCENT, paddingVertical: 12, paddingHorizontal: 28, borderRadius: 12 },
  btnText: { color: BG, fontSize: 15, fontWeight: '700' },
});

export default App;
