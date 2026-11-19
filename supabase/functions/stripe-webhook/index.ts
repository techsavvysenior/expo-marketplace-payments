/**
 * Stripe webhook. The only place a card, Apple Pay or Google Pay order
 * becomes paid.
 *
 *  - Verifies the signature on the raw body (Web Crypto provider, as Deno has
 *    no Node crypto). Pattern from the Supabase Stripe webhook guide.
 *  - record_payment() checks amount and currency against the order and
 *    ignores redelivered events.
 *  - Sends the matching Meta Purchase once, when the order first turns paid.
 *
 * Deploy with --no-verify-jwt: Stripe does not send a Supabase JWT, the
 * signature is the authentication.
 */
import Stripe from 'stripe';

import { env, HttpError, json, serve } from '../_shared/http.ts';
import { sendPurchaseToMeta } from '../_shared/meta.ts';
import { ruleError, serviceClient } from '../_shared/supabase.ts';

const stripe = new Stripe(env('STRIPE_SECRET_KEY'));
const cryptoProvider = Stripe.createSubtleCryptoProvider();

serve(async (req) => {
  const signature = req.headers.get('Stripe-Signature');
  if (!signature) throw new HttpError(400, 'missing_signature');

  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      env('STRIPE_WEBHOOK_SIGNING_SECRET'),
      undefined,
      cryptoProvider,
    );
  } catch {
    throw new HttpError(400, 'invalid_signature');
  }

  const service = serviceClient();

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const intent = event.data.object;
      const orderId = intent.metadata.order_id;
      if (!orderId) return json({ received: true, ignored: 'no_order_id' });

      const { data, error } = await service.rpc('record_payment', {
        p_provider: 'stripe',
        p_event_id: event.id,
        p_order_id: orderId,
        p_provider_reference: intent.id,
        p_amount_cents: intent.amount_received,
        p_currency: intent.currency,
      });
      if (error) throw ruleError(error) ?? error;
      if (data === 'paid') await sendPurchaseToMeta(service, orderId);
      return json({ received: true, result: data });
    }

    case 'payment_intent.payment_failed': {
      const orderId = event.data.object.metadata.order_id;
      if (!orderId) return json({ received: true, ignored: 'no_order_id' });
      const { data, error } = await service.rpc('record_payment_failure', {
        p_provider: 'stripe',
        p_event_id: event.id,
        p_order_id: orderId,
      });
      if (error) throw error;
      return json({ received: true, result: data });
    }

    default:
      return json({ received: true, ignored: event.type });
  }
});
