import React, { useEffect, useState, useRef } from 'react';
import { SafeAreaView, StatusBar, PermissionsAndroid, Alert, Linking, Platform, Text, View, NativeModules, ActivityIndicator } from 'react-native';
import { WebView } from 'react-native-webview';
import nodejs from 'nodejs-mobile-react-native';

const HOST_URL = 'http://127.0.0.1:9090/host';

const App = () => {
  const [serverStarted, setServerStarted] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);
  const [webviewKey, setWebviewKey] = useState(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    requestPermissions();
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, []);

  const requestPermissions = async () => {
    if (Platform.OS === 'android') {
      try {
        // Request legacy storage permissions (needed on Android 9 and below)
        if (Platform.Version < 30) {
          await PermissionsAndroid.requestMultiple([
            PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE,
            PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
          ]);
        }

        // On Android 13+ request media permissions
        if (Platform.Version >= 33) {
          await PermissionsAndroid.requestMultiple([
            PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES,
            PermissionsAndroid.PERMISSIONS.READ_MEDIA_VIDEO,
            PermissionsAndroid.PERMISSIONS.READ_MEDIA_AUDIO,
          ]);
        }

        // On Android 11+ (API 30+), check MANAGE_EXTERNAL_STORAGE via deep-link
        if (Platform.Version >= 30) {
          const packageName = NativeModules.RNDeviceInfo?.packageName || 'com.hosterapp';
          Alert.alert(
            '📂 All Files Access Required',
            'Hoster needs "All Files Access" to read all folders on your device.\n\nPlease tap "Grant Access" and enable the toggle for Hoster.',
            [
              { text: 'Skip', style: 'cancel' },
              {
                text: 'Grant Access',
                onPress: () => {
                  try {
                    Linking.sendIntent('android.settings.MANAGE_APP_ALL_FILES_ACCESS_PERMISSION', [
                      { key: 'data', value: `package:${packageName}` }
                    ]).catch(() => {
                      Linking.sendIntent('android.settings.MANAGE_ALL_FILES_ACCESS_PERMISSION')
                        .catch(() => Linking.openSettings());
                    });
                  } catch {
                    Linking.openSettings();
                  }
                }
              }
            ]
          );
        }

        setHasPermission(true);
        startNode();
      } catch (err) {
        console.warn(err);
        setHasPermission(true);
        startNode();
      }
    } else {
      setHasPermission(true);
      startNode();
    }
  };

  const startNode = () => {
    // Listen to messages from Node
    nodejs.channel.addListener('message', (msg) => {
      console.log('From Node: ' + msg);
      if (msg === 'started') {
        setServerStarted(true);
      }
    });

    // Start the Node.js server thread
    nodejs.start('src/server.js');

    // Fallback: wait up to 10s for the server to bind, then show the WebView anyway.
    // The WebView's onError handler will keep retrying if the server isn't ready yet.
    setTimeout(() => {
      setServerStarted(true);
    }, 10000);
  };

  // Called when WebView fails to load (e.g. server not ready yet / connection refused)
  const handleWebViewError = () => {
    console.log('WebView load error — server not ready yet, retrying in 2s...');
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = setTimeout(() => {
      setWebviewKey(k => k + 1); // remount WebView to trigger a fresh load attempt
    }, 2000);
  };

  const LoadingView = ({ message }: { message: string }) => (
    <View style={{ flex: 1, backgroundColor: '#08090f', justifyContent: 'center', alignItems: 'center', gap: 16 }}>
      <ActivityIndicator size="large" color="#00e5ff" />
      <Text style={{ color: '#00e5ff', fontSize: 15, fontWeight: '500' }}>{message}</Text>
    </View>
  );

  if (!hasPermission) {
    return <LoadingView message="Requesting Permissions..." />;
  }

  if (!serverStarted) {
    return <LoadingView message="Starting Hoster Server Engine..." />;
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#08090f' }}>
      <StatusBar barStyle="light-content" backgroundColor="#08090f" />
      <WebView
        key={webviewKey}
        source={{ uri: HOST_URL }}
        style={{ flex: 1, backgroundColor: '#08090f', opacity: 0.99 }}
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        allowFileAccess={true}
        allowFileAccessFromFileURLs={true}
        allowUniversalAccessFromFileURLs={true}
        domStorageEnabled={true}
        javaScriptEnabled={true}
        originWhitelist={['*']}
        onError={handleWebViewError}
        onHttpError={(e) => {
          console.log('WebView HTTP error:', e.nativeEvent.statusCode);
        }}
        renderLoading={() => (
          <View style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: '#08090f', justifyContent: 'center', alignItems: 'center', gap: 16
          }}>
            <ActivityIndicator size="large" color="#00e5ff" />
            <Text style={{ color: '#00e5ff', fontSize: 14 }}>Loading Hoster UI...</Text>
          </View>
        )}
        startInLoadingState={true}
      />
    </SafeAreaView>
  );
};

export default App;
