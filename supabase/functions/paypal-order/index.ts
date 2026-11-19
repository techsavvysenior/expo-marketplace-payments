/**
 * POST { action: "create", orderId }            -> { paypalOrderId, approveUrl }
 * POST { action: "capture", orderId, paypalOrderId } -> { status }
 *
 * The app opens approveUrl in an auth session browser. PayPal redirects to
 * the app's return URL, and the app calls "capture". Capture is a
 * server-to-server call, so its response is trusted the same way a webhook
 * is: the amount PayPal reports is checked against the order by
 * record_payment().
 */
import { PayPalClient, type PayPalEnvironment } from '../../../src/core/paypal/paypal-client.ts';
import { Money } from '../../../src/core/money.ts';
import { PaymentDeclinedError } from '../../../src/core/errors.ts';
import { env, HttpError, json, serve } from '../_shared/http.ts';
import { sendPurchaseToMeta } from '../_shared/meta.ts';
import { loadOwnOrder, requireUser, ruleError, serviceClient } from '../_shared/supabase.ts';

const paypal = new PayPalClient({
  clientId: env('PAYPAL_CLIENT_ID'),
  clientSecret: env('PAYPAL_CLIENT_SECRET'),
  environment: (Deno.env.get('PAYPAL_ENVIRONMENT') ?? 'sandbox') as PayPalEnvironment,
});

type Body =
  | { action: 'create'; orderId: string }
  | { action: 'capture'; orderId: string; paypalOrderId: string };

serve(async (req) => {
  const { user, client } = await requireUser(req);
  const body = (await req.json()) as Body;
  const order = await loadOwnOrder(client, body.orderId, user.id);
  if (order.provider !== 'paypal') throw new HttpError(409, 'wrong_provider');

  if (body.action === 'create') {
    const scheme = env('APP_SCHEME');
    const created = await paypal.createOrder({
      ourOrderId: order.id,
      amount: Money.of(order.total_cents, order.currency),
      returnUrl: `${scheme}://paypal/return`,
      cancelUrl: `${scheme}://paypal/cancel`,
      brandName: Deno.env.get('BRAND_NAME') ?? 'Marketplace',
    });
    return json({ paypalOrderId: created.id, approveUrl: created.approveUrl });
  }

  if (body.action === 'capture') {
    let captured;
    try {
      captured = await paypal.captureOrder(body.paypalOrderId);
    } catch (error) {
      if (error instanceof PaymentDeclinedError) throw new HttpError(402, 'payment_declined');
      throw error;
    }
    if (captured.ourOrderId !== order.id) throw new HttpError(409, 'order_mismatch');

    const service = serviceClient();
    const { data, error } = await service.rpc('record_payment', {
      p_provider: 'paypal',
      p_event_id: `capture:${captured.captureId}`,
      p_order_id: order.id,
      p_provider_reference: captured.captureId,
      p_amount_cents: captured.amount.cents,
      p_currency: captured.amount.currency,
    });
    if (error) throw ruleError(error) ?? error;
    if (data === 'paid') await sendPurchaseToMeta(service, order.id);
    return json({ status: captured.status, result: data });
  }

  throw new HttpError(400, 'unknown_action');
});
