import React, { useEffect, useState } from 'react';
import { SafeAreaView, StatusBar, PermissionsAndroid, Alert, Linking, Platform, Text, View, NativeModules } from 'react-native';
import { WebView } from 'react-native-webview';
import nodejs from 'nodejs-mobile-react-native';

const App = () => {
  const [serverStarted, setServerStarted] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);

  useEffect(() => {
    requestPermissions();
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
          const allFilesUrl = `content://com.android.externalstorage.documents/tree/primary%3A`;
          const settingsUrl = `android.settings.MANAGE_APP_ALL_FILES_ACCESS_PERMISSION&data=package:${packageName}`;
          Alert.alert(
            '📂 All Files Access Required',
            'Hoster needs "All Files Access" to read all folders on your device.\n\nPlease tap "Grant Access" and enable the toggle for Hoster.',
            [
              { text: 'Skip', style: 'cancel' },
              {
                text: 'Grant Access',
                onPress: () => {
                  try {
                    // Use sendIntent to open Android Settings Action directly
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

    // Fallback: Give the server 5 seconds to bind to the port reliably
    setTimeout(() => {
      setServerStarted(true);
    }, 5000);
  };

  if (!hasPermission) {
    return (
      <View style={{flex: 1, backgroundColor: '#08090f', justifyContent: 'center', alignItems: 'center'}}>
        <Text style={{color: '#00e5ff'}}>Requesting Permissions...</Text>
      </View>
    );
  }

  if (!serverStarted) {
    return (
      <View style={{flex: 1, backgroundColor: '#08090f', justifyContent: 'center', alignItems: 'center'}}>
        <Text style={{color: '#00e5ff'}}>Starting Hoster Server Engine...</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#08090f' }}>
      <StatusBar barStyle="light-content" backgroundColor="#08090f" />
      <WebView
        source={{ uri: 'http://127.0.0.1:9090/host' }}
        style={{ flex: 1, backgroundColor: '#08090f', opacity: 0.99 }}
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        allowFileAccess={true}
        allowFileAccessFromFileURLs={true}
        allowUniversalAccessFromFileURLs={true}
        domStorageEnabled={true}
        javaScriptEnabled={true}
        originWhitelist={['*']}
      />
    </SafeAreaView>
  );
};

export default App;
