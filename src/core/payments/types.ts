import type { Money } from '../money.ts';

export type PaymentProvider = 'stripe' | 'paypal';

/** An order the backend created and priced, waiting for payment. */
export type PendingOrder = {
  id: string;
  provider: PaymentProvider;
  total: Money;
};

/**
 * What a gateway reports back to the app.
 *
 * 'succeeded' means the provider accepted the payment on the device. It is
 * NOT what marks the order paid: the provider's webhook does that, after the
 * server checks the amount. 'processing' covers bank-backed methods that
 * settle later.
 */
export type GatewayResult = {
  status: 'succeeded' | 'processing';
  providerReference: string;
};

/**
 * One payment method the app can offer. Implementations live in
 * src/platform (Stripe PaymentSheet, PayPal in a browser session) and in
 * tests (a fake). Each one throws PaymentCancelledError when the person backs
 * out and PaymentDeclinedError when the provider refuses.
 */
export interface PaymentGateway {
  readonly provider: PaymentProvider;
  /** Human label for the button, e.g. "Card, Apple Pay or Google Pay". */
  readonly label: string;
  isAvailable(): Promise<boolean>;
  pay(order: PendingOrder): Promise<GatewayResult>;
}

/** Device-side data the server needs to send a matching Conversions API event. */
export type Attribution = {
  /** The Meta SDK's install ID (AppEventsLogger.getAnonymousID). */
  anonId?: string;
  /** iOS App Tracking Transparency result, or Android's ad-tracking setting. */
  advertiserTrackingEnabled: boolean;
  applicationTrackingEnabled: boolean;
  /** Advertising ID, only present when the person allowed tracking. */
  advertiserId?: string;
  platform: 'ios' | 'android' | 'web';
  appBundleId?: string;
  appVersion?: string;
  osVersion?: string;
  deviceModel?: string;
  locale?: string;
  timezone?: string;
};

export interface OrdersApi {
  createOrder(input: {
    items: { product_id: string; quantity: number }[];
    provider: PaymentProvider;
    idempotencyKey: string;
    attribution: Attribution;
  }): Promise<PendingOrder>;
}
