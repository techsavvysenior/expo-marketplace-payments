import type { initPaymentSheet, presentPaymentSheet } from '@stripe/stripe-react-native';

import { PaymentCancelledError, PaymentDeclinedError } from '@/core/errors';
import type { GatewayResult, PaymentGateway, PendingOrder } from '@/core/payments/types';
import { invokeFunction } from '@/lib/functions';

type StripeSheet = {
  initPaymentSheet: typeof initPaymentSheet;
  presentPaymentSheet: typeof presentPaymentSheet;
};

/**
 * Card, Apple Pay and Google Pay through Stripe's PaymentSheet.
 *
 * The server creates the PaymentIntent from the order row, so the app never
 * sends an amount. Success here means Stripe confirmed on the device. The
 * order turns paid when the stripe-webhook function receives
 * payment_intent.succeeded.
 */
export class StripeGateway implements PaymentGateway {
  readonly provider = 'stripe' as const;
  readonly label = 'Card, Apple Pay or Google Pay';

  constructor(
    private readonly sheet: StripeSheet,
    private readonly options: { merchantDisplayName: string; merchantCountryCode: string; returnURL: string; testEnv: boolean },
  ) {}

  async isAvailable(): Promise<boolean> {
    return Boolean(process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY);
  }

  async pay(order: PendingOrder): Promise<GatewayResult> {
    const { clientSecret } = await invokeFunction<{ clientSecret: string }>('create-payment-intent', { orderId: order.id });

    const init = await this.sheet.initPaymentSheet({
      merchantDisplayName: this.options.merchantDisplayName,
      paymentIntentClientSecret: clientSecret,
      returnURL: this.options.returnURL,
      applePay: { merchantCountryCode: this.options.merchantCountryCode },
      googlePay: {
        merchantCountryCode: this.options.merchantCountryCode,
        currencyCode: order.total.currency,
        testEnv: this.options.testEnv,
      },
    });
    if (init.error) throw new PaymentDeclinedError(init.error.localizedMessage ?? init.error.message);

    const result = await this.sheet.presentPaymentSheet();
    if (result.error) {
      if (result.error.code === 'Canceled') throw new PaymentCancelledError();
      throw new PaymentDeclinedError(result.error.localizedMessage ?? result.error.message);
    }

    return { status: 'succeeded', providerReference: clientSecret.split('_secret_')[0] };
  }
}
