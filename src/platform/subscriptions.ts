import { Platform } from 'react-native';
import Purchases, { type PurchasesPackage } from 'react-native-purchases';

import { type Analytics, eventIds } from '@/core/analytics/events';
import { PaymentCancelledError, PaymentDeclinedError } from '@/core/errors';
import { Money } from '@/core/money';

export const PREMIUM_ENTITLEMENT = 'pro';

/**
 * App Store and Google Play subscriptions through RevenueCat.
 *
 * Apple and Google require their own billing for digital goods and
 * subscriptions, which is why these never go through Stripe or PayPal.
 * The RevenueCat app user id is the Supabase user id, so the
 * revenuecat-webhook function can write entitlements to the right account.
 */
export class SubscriptionService {
  private configuredFor?: string;

  constructor(private readonly analytics: Analytics) {}

  static apiKey(): string | undefined {
    return Platform.OS === 'ios'
      ? process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY
      : process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY;
  }

  async signIn(userId: string): Promise<void> {
    const apiKey = SubscriptionService.apiKey();
    if (!apiKey) return;
    if (!this.configuredFor) {
      Purchases.configure({ apiKey, appUserID: userId });
    } else if (this.configuredFor !== userId) {
      await Purchases.logIn(userId);
    }
    this.configuredFor = userId;
  }

  async signOut(): Promise<void> {
    if (this.configuredFor && !(await Purchases.isAnonymous())) await Purchases.logOut();
    this.configuredFor = undefined;
  }

  async packages(): Promise<PurchasesPackage[]> {
    if (!this.configuredFor) return [];
    const offerings = await Purchases.getOfferings();
    return offerings.current?.availablePackages ?? [];
  }

  async isPremium(): Promise<boolean> {
    if (!this.configuredFor) return false;
    const info = await Purchases.getCustomerInfo();
    return PREMIUM_ENTITLEMENT in info.entitlements.active;
  }

  async purchase(pkg: PurchasesPackage): Promise<void> {
    try {
      const result = await Purchases.purchasePackage(pkg);
      await this.analytics.track({
        name: 'Subscribe',
        eventId: eventIds.subscribe(result.transaction.transactionIdentifier),
        value: Money.of(Math.round(pkg.product.price * 100), pkg.product.currencyCode),
        contentIds: [pkg.product.identifier],
      });
    } catch (error) {
      if (isUserCancelled(error)) throw new PaymentCancelledError();
      throw new PaymentDeclinedError((error as Error).message);
    }
  }

  async restore(): Promise<boolean> {
    const info = await Purchases.restorePurchases();
    return PREMIUM_ENTITLEMENT in info.entitlements.active;
  }
}

function isUserCancelled(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === Purchases.PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR
  );
}
