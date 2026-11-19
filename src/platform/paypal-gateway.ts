import * as WebBrowser from 'expo-web-browser';

import { PaymentCancelledError } from '@/core/errors';
import type { GatewayResult, PaymentGateway, PendingOrder } from '@/core/payments/types';
import { invokeFunction } from '@/lib/functions';

/**
 * PayPal through an auth session browser (ASWebAuthenticationSession on iOS,
 * Custom Tabs on Android). The secret never reaches the device: the
 * paypal-order function creates and captures the PayPal order.
 */
export class PayPalGateway implements PaymentGateway {
  readonly provider = 'paypal' as const;
  readonly label = 'PayPal';

  constructor(private readonly scheme: string) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async pay(order: PendingOrder): Promise<GatewayResult> {
    const { paypalOrderId, approveUrl } = await invokeFunction<{ paypalOrderId: string; approveUrl: string }>(
      'paypal-order',
      { action: 'create', orderId: order.id },
    );

    const session = await WebBrowser.openAuthSessionAsync(approveUrl, `${this.scheme}://paypal`);
    if (session.type !== 'success' || !session.url.includes('/return')) {
      throw new PaymentCancelledError();
    }

    const { status } = await invokeFunction<{ status: string }>('paypal-order', {
      action: 'capture',
      orderId: order.id,
      paypalOrderId,
    });
    return { status: status === 'COMPLETED' ? 'succeeded' : 'processing', providerReference: paypalOrderId };
  }
}
