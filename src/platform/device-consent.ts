import Constants from 'expo-constants';
import * as Tracking from 'expo-tracking-transparency';
import { Platform } from 'react-native';
import { AppEventsLogger, Settings } from 'react-native-fbsdk-next';

import type { ConsentProvider } from '@/core/analytics/events';
import type { Attribution } from '@/core/payments/types';

/**
 * Asks for App Tracking Transparency once on iOS and tells the Meta SDK the
 * answer, then collects the device fields the Conversions API needs.
 *
 * Without permission the advertising ID is left out entirely and
 * advertiser_tracking_enabled is sent as 0.
 */
export class DeviceConsentProvider implements ConsentProvider {
  private cached?: Attribution;

  async attribution(): Promise<Attribution> {
    if (this.cached) return this.cached;

    let advertiserTrackingEnabled = Platform.OS === 'android';
    if (Platform.OS === 'ios' && Tracking.isAvailable()) {
      const { granted } = await Tracking.requestTrackingPermissionsAsync();
      advertiserTrackingEnabled = granted;
      await Settings.setAdvertiserTrackingEnabled(granted);
    }

    const advertiserId = advertiserTrackingEnabled ? ((await Tracking.getAdvertisingIdAsync()) ?? undefined) : undefined;
    const options = Intl.DateTimeFormat().resolvedOptions();

    this.cached = {
      platform: Platform.OS === 'android' ? 'android' : Platform.OS === 'ios' ? 'ios' : 'web',
      advertiserTrackingEnabled,
      applicationTrackingEnabled: true,
      advertiserId: advertiserId && !/^0{8}-/.test(advertiserId) ? advertiserId : undefined,
      anonId: (await AppEventsLogger.getAnonymousID()) ?? undefined,
      appBundleId: Platform.OS === 'ios' ? Constants.expoConfig?.ios?.bundleIdentifier : Constants.expoConfig?.android?.package,
      appVersion: Constants.expoConfig?.version,
      osVersion: String(Platform.Version),
      locale: options.locale.replace('-', '_'),
      timezone: options.timeZone,
    };
    return this.cached;
  }
}
