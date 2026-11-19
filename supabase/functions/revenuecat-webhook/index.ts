/**
 * RevenueCat webhook: keeps public.entitlements in step with App Store and
 * Google Play subscriptions.
 *
 * The app reads entitlements from the database (my_entitlements view), not
 * only from the device, so the backend can gate premium features too.
 *
 * Authentication: HMAC signature when REVENUECAT_WEBHOOK_SECRET is set (the
 * stronger option RevenueCat offers), otherwise the static Authorization
 * header configured in the RevenueCat dashboard. Deploy with --no-verify-jwt.
 */
import { SignatureError } from '../../../src/core/errors.ts';
import {
  parseRevenueCatEvent,
  SIGNATURE_HEADER,
  timingSafeEqual,
  verifyRevenueCatSignature,
} from '../../../src/core/webhooks/revenuecat.ts';
import { HttpError, json, optionalEnv, serve } from '../_shared/http.ts';
import { serviceClient } from '../_shared/supabase.ts';

serve(async (req) => {
  const rawBody = await req.text();

  const hmacSecret = optionalEnv('REVENUECAT_WEBHOOK_SECRET');
  const headerSecret = optionalEnv('REVENUECAT_AUTH_HEADER');
  try {
    if (hmacSecret) {
      await verifyRevenueCatSignature({
        header: req.headers.get(SIGNATURE_HEADER),
        rawBody,
        secret: hmacSecret,
        nowSeconds: Math.floor(Date.now() / 1000),
      });
    } else if (!headerSecret || !timingSafeEqual(req.headers.get('Authorization') ?? '', headerSecret)) {
      throw new SignatureError('Authorization header does not match.');
    }
  } catch (error) {
    if (error instanceof SignatureError) throw new HttpError(401, 'invalid_signature');
    throw error;
  }

  let event;
  try {
    event = parseRevenueCatEvent(rawBody);
  } catch (error) {
    // A TEST event or an anonymous user: acknowledge so RevenueCat stops retrying.
    console.warn('RevenueCat event not applied', (error as Error).message);
    return json({ received: true, ignored: 'unparsable_or_anonymous' });
  }

  const { data, error } = await serviceClient().rpc('apply_entitlement_event', {
    p_event_id: event.id,
    p_user_id: event.appUserId,
    p_event_type: event.type,
    p_entitlements: event.entitlementIds,
    p_product_id: event.productId,
    p_store: event.store,
    p_expires_at: event.expiresAt?.toISOString() ?? null,
  });
  if (error) throw error;
  return json({ received: true, result: data });
});
