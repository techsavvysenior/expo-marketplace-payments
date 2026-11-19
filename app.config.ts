import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Native config. Keys that differ per environment come from the build
 * environment (EAS secrets or a local .env), so nothing private is committed.
 */
const TRACKING_REASON =
  'This lets us measure which ads brought you to the app. We never sell your data, and you can change this in Settings.';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Marketplace',
  slug: 'expo-marketplace-payments',
  version: '1.0.0',
  orientation: 'portrait',
  scheme: 'marketplace',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: 'com.example.marketplace',
    infoPlist: { NSUserTrackingUsageDescription: TRACKING_REASON },
  },
  android: { package: 'com.example.marketplace' },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-web-browser',
    ['expo-splash-screen', { backgroundColor: '#F6F7F9' }],
    [
      '@stripe/stripe-react-native',
      {
        merchantIdentifier: process.env.EXPO_PUBLIC_APPLE_MERCHANT_ID ?? 'merchant.com.example.marketplace',
        enableGooglePay: true,
      },
    ],
    [
      'react-native-fbsdk-next',
      {
        appID: process.env.META_APP_ID ?? '000000000000000',
        clientToken: process.env.META_CLIENT_TOKEN ?? 'replace-me',
        displayName: 'Marketplace',
        scheme: `fb${process.env.META_APP_ID ?? '000000000000000'}`,
        // The app initializes the SDK itself and logs events explicitly.
        isAutoInitEnabled: false,
        autoLogAppEventsEnabled: false,
        advertiserIDCollectionEnabled: true,
        iosUserTrackingPermission: TRACKING_REASON,
      },
    ],
    ['expo-tracking-transparency', { userTrackingPermission: TRACKING_REASON }],
  ],
  experiments: { typedRoutes: true, reactCompiler: true },
});
