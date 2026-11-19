import * as WebBrowser from 'expo-web-browser';

import { PaymentCancelledError, PaymentDeclinedError } from '@/core/errors';
import { Money } from '@/core/money';
import type { PendingOrder } from '@/core/payments/types';
import { invokeFunction } from '@/lib/functions';
import { PayPalGateway } from '@/platform/paypal-gateway';
import { StripeGateway } from '@/platform/stripe-gateway';

jest.mock('@/lib/functions', () => ({ invokeFunction: jest.fn() }));
jest.mock('expo-web-browser', () => ({
  openAuthSessionAsync: jest.fn(),
  WebBrowserResultType: { CANCEL: 'cancel', DISMISS: 'dismiss' },
}));

const invoke = invokeFunction as jest.MockedFunction<typeof invokeFunction>;
const openAuthSession = WebBrowser.openAuthSessionAsync as jest.MockedFunction<typeof WebBrowser.openAuthSessionAsync>;

const order: PendingOrder = { id: 'order-1', provider: 'stripe', total: Money.of(2500, 'USD') };

beforeEach(() => jest.clearAllMocks());

describe('StripeGateway', () => {
  function gateway(present: () => Promise<{ error?: { code: string; message: string; localizedMessage?: string } }>) {
    const sheet = {
      initPaymentSheet: jest.fn(async () => ({})),
      presentPaymentSheet: jest.fn(present),
    };
    const instance = new StripeGateway(sheet as never, {
      merchantDisplayName: 'Marketplace',
      merchantCountryCode: 'US',
      returnURL: 'marketplace://stripe-redirect',
      testEnv: true,
    });
    return { instance, sheet };
  }

  beforeEach(() => invoke.mockResolvedValue({ clientSecret: 'pi_123_secret_abc' }));

  it('asks the server for the intent and never sends an amount', async () => {
    const { instance, sheet } = gateway(async () => ({}));

    const result = await instance.pay(order);

    expect(invoke).toHaveBeenCalledWith('create-payment-intent', { orderId: 'order-1' });
    expect(sheet.initPaymentSheet).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentClientSecret: 'pi_123_secret_abc',
        applePay: { merchantCountryCode: 'US' },
        googlePay: expect.objectContaining({ currencyCode: 'USD', testEnv: true }),
      }),
    );
    expect(result).toEqual({ status: 'succeeded', providerReference: 'pi_123' });
  });

  it('maps a closed sheet to a cancellation', async () => {
    const { instance } = gateway(async () => ({ error: { code: 'Canceled', message: 'The payment flow has been canceled' } }));
    await expect(instance.pay(order)).rejects.toBeInstanceOf(PaymentCancelledError);
  });

  it('maps a failure to a decline with Stripe message', async () => {
    const { instance } = gateway(async () => ({ error: { code: 'Failed', message: 'x', localizedMessage: 'Your card was declined.' } }));
    await expect(instance.pay(order)).rejects.toEqual(new PaymentDeclinedError('Your card was declined.'));
  });
});

describe('PayPalGateway', () => {
  const paypalOrder: PendingOrder = { ...order, provider: 'paypal' };

  it('creates, opens the approval page, then captures on the return URL', async () => {
    invoke
      .mockResolvedValueOnce({ paypalOrderId: 'PP-1', approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=PP-1' })
      .mockResolvedValueOnce({ status: 'COMPLETED' });
    openAuthSession.mockResolvedValue({ type: 'success', url: 'marketplace://paypal/return?token=PP-1' });

    const result = await new PayPalGateway('marketplace').pay(paypalOrder);

    expect(openAuthSession).toHaveBeenCalledWith('https://www.sandbox.paypal.com/checkoutnow?token=PP-1', 'marketplace://paypal');
    expect(invoke).toHaveBeenLastCalledWith('paypal-order', { action: 'capture', orderId: 'order-1', paypalOrderId: 'PP-1' });
    expect(result).toEqual({ status: 'succeeded', providerReference: 'PP-1' });
  });

  it('does not capture when the person cancels or closes the browser', async () => {
    invoke.mockResolvedValue({ paypalOrderId: 'PP-1', approveUrl: 'https://paypal.test' });

    openAuthSession.mockResolvedValueOnce({ type: 'success', url: 'marketplace://paypal/cancel?token=PP-1' });
    await expect(new PayPalGateway('marketplace').pay(paypalOrder)).rejects.toBeInstanceOf(PaymentCancelledError);

    openAuthSession.mockResolvedValueOnce({ type: WebBrowser.WebBrowserResultType.DISMISS });
    await expect(new PayPalGateway('marketplace').pay(paypalOrder)).rejects.toBeInstanceOf(PaymentCancelledError);

    expect(invoke).not.toHaveBeenCalledWith('paypal-order', expect.objectContaining({ action: 'capture' }));
  });
});
