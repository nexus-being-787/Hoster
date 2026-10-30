module.exports = {
  preset: 'react-native',
  // react-native-webview / nodejs-mobile ship untranspiled ES modules
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|react-native-webview|nodejs-mobile-react-native)/)',
  ],
};
