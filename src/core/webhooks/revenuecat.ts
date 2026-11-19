import { SignatureError } from '../errors.ts';

/**
 * RevenueCat webhook verification and parsing.
 *
 * Spec followed (checked Nov 2026): https://www.revenuecat.com/docs/integrations/webhooks
 *  - Optional HMAC signing: header X-RevenueCat-Webhook-Signature, format
 *    "t=<unix seconds>,v1=<hex HMAC-SHA256>", computed over "<t>.<raw body>".
 *    Verify the raw body before parsing, compare in constant time, and reject
 *    timestamps outside a tolerance window.
 *  - Delivery is at least once: track event.id to stay idempotent.
 *  - Body shape: { api_version, event: { type, id, app_user_id, ... } }.
 */

export const SIGNATURE_HEADER = 'X-RevenueCat-Webhook-Signature';

export async function verifyRevenueCatSignature(input: {
  header: string | null;
  rawBody: string;
  secret: string;
  nowSeconds: number;
  toleranceSeconds?: number;
}): Promise<void> {
  if (!input.header) throw new SignatureError('Missing signature header.');

  const parts = Object.fromEntries(
    input.header.split(',').map((part) => {
      const index = part.indexOf('=');
      return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
    }),
  );
  const timestamp = Number(parts.t);
  const signature = parts.v1;
  if (!Number.isInteger(timestamp) || !signature) throw new SignatureError('Malformed signature header.');

  const tolerance = input.toleranceSeconds ?? 300;
  if (Math.abs(input.nowSeconds - timestamp) > tolerance) {
    throw new SignatureError('Signature timestamp is outside the allowed window.');
  }

  const expected = await hmacSha256Hex(input.secret, `${timestamp}.${input.rawBody}`);
  if (!timingSafeEqual(expected, signature.toLowerCase())) {
    throw new SignatureError('Signature does not match.');
  }
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Compares every character, so timing doesn't reveal how much matched. */
export function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export type RevenueCatEvent = {
  id: string;
  type: string;
  appUserId: string;
  productId: string;
  entitlementIds: string[];
  store: string | null;
  environment: 'SANDBOX' | 'PRODUCTION';
  expiresAt: Date | null;
  transactionId: string | null;
  priceUsd: number | null;
  currency: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parses and checks the fields this backend relies on. app_user_id must be a
 * Supabase user id, which is what the app passes to Purchases.logIn(). An
 * anonymous RevenueCat id ($RCAnonymousID:...) is reported, not trusted.
 */
export function parseRevenueCatEvent(rawBody: string): RevenueCatEvent {
  const body = JSON.parse(rawBody) as { event?: Record<string, unknown> };
  const event = body.event;
  if (!event || typeof event !== 'object') throw new TypeError('Body has no event.');

  const text = (key: string) => (typeof event[key] === 'string' ? (event[key] as string) : null);
  const id = text('id');
  const type = text('type');
  const appUserId = text('app_user_id');
  if (!id || !type || !appUserId) throw new TypeError('Event is missing id, type or app_user_id.');
  if (!UUID.test(appUserId)) throw new TypeError(`app_user_id is not a user id: ${appUserId}`);

  const expiration = event.expiration_at_ms;
  return {
    id,
    type,
    appUserId,
    productId: text('product_id') ?? '',
    entitlementIds: Array.isArray(event.entitlement_ids) ? (event.entitlement_ids as string[]) : [],
    store: text('store'),
    environment: event.environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
    expiresAt: typeof expiration === 'number' ? new Date(expiration) : null,
    transactionId: text('transaction_id'),
    priceUsd: typeof event.price === 'number' ? event.price : null,
    currency: text('currency'),
  };
}
