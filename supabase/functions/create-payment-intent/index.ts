/**
 * POST { orderId } with the user's JWT.
 * Returns the PaymentIntent client secret for the app's PaymentSheet.
 *
 * The amount comes from the order row, which the database priced. The
 * PaymentIntent is created with an idempotency key derived from the order,
 * so tapping Pay twice returns the same intent instead of charging twice.
 */
import Stripe from 'stripe';

import { env, HttpError, json, serve } from '../_shared/http.ts';
import { loadOwnOrder, requireUser } from '../_shared/supabase.ts';

const stripe = new Stripe(env('STRIPE_SECRET_KEY'));

serve(async (req) => {
  const { user, client } = await requireUser(req);
  const { orderId } = (await req.json()) as { orderId?: string };
  if (!orderId) throw new HttpError(400, 'order_id_required');

  const order = await loadOwnOrder(client, orderId, user.id);
  if (order.provider !== 'stripe') throw new HttpError(409, 'wrong_provider');

  const intent = await stripe.paymentIntents.create(
    {
      amount: order.total_cents,
      currency: order.currency.toLowerCase(),
      automatic_payment_methods: { enabled: true },
      metadata: { order_id: order.id, customer_id: user.id },
    },
    { idempotencyKey: `order-${order.id}` },
  );

  return json({
    clientSecret: intent.client_secret,
    publishableKey: env('STRIPE_PUBLISHABLE_KEY'),
  });
});
