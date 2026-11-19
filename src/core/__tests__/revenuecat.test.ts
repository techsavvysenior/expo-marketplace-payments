import { createHmac } from 'node:crypto';

import { SignatureError } from '../errors.ts';
import { hmacSha256Hex, parseRevenueCatEvent, timingSafeEqual, verifyRevenueCatSignature } from '../webhooks/revenuecat.ts';

const secret = 'whsec_test';
const userId = '7a09876a-04ab-4f0e-bdfe-facd4813ded7';
const body = JSON.stringify({
  api_version: '1.0',
  event: {
    id: 'evt-1',
    type: 'INITIAL_PURCHASE',
    app_user_id: userId,
    product_id: 'pro_monthly',
    entitlement_ids: ['pro'],
    store: 'APP_STORE',
    environment: 'SANDBOX',
    expiration_at_ms: 1797606000000,
    transaction_id: '2000000123',
    price: 4.99,
    currency: 'USD',
  },
});

const sign = (t: number, payload = body, key = secret) =>
  `t=${t},v1=${createHmac('sha256', key).update(`${t}.${payload}`).digest('hex')}`;

describe('verifyRevenueCatSignature', () => {
  const now = 1_795_000_000;

  it('accepts a correctly signed, recent delivery', async () => {
    await expect(verifyRevenueCatSignature({ header: sign(now - 10), rawBody: body, secret, nowSeconds: now })).resolves.toBeUndefined();
  });

  it('rejects a body changed after signing', async () => {
    await expect(
      verifyRevenueCatSignature({ header: sign(now), rawBody: body.replace('pro_monthly', 'pro_yearly'), secret, nowSeconds: now }),
    ).rejects.toBeInstanceOf(SignatureError);
  });

  it('rejects the wrong secret, a stale timestamp and a missing header', async () => {
    await expect(verifyRevenueCatSignature({ header: sign(now, body, 'other'), rawBody: body, secret, nowSeconds: now })).rejects.toThrow('does not match');
    await expect(verifyRevenueCatSignature({ header: sign(now - 3600), rawBody: body, secret, nowSeconds: now })).rejects.toThrow('window');
    await expect(verifyRevenueCatSignature({ header: null, rawBody: body, secret, nowSeconds: now })).rejects.toThrow('Missing');
    await expect(verifyRevenueCatSignature({ header: 'garbage', rawBody: body, secret, nowSeconds: now })).rejects.toThrow('Malformed');
  });

  it('computes the same HMAC as Node crypto', async () => {
    expect(await hmacSha256Hex('k', 'm')).toBe(createHmac('sha256', 'k').update('m').digest('hex'));
  });

  it('compares strings of different lengths safely', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('parseRevenueCatEvent', () => {
  it('reads the fields the backend needs', () => {
    expect(parseRevenueCatEvent(body)).toEqual({
      id: 'evt-1',
      type: 'INITIAL_PURCHASE',
      appUserId: userId,
      productId: 'pro_monthly',
      entitlementIds: ['pro'],
      store: 'APP_STORE',
      environment: 'SANDBOX',
      expiresAt: new Date(1797606000000),
      transactionId: '2000000123',
      priceUsd: 4.99,
      currency: 'USD',
    });
  });

  it('refuses an anonymous RevenueCat id', () => {
    const anonymous = body.replace(userId, '$RCAnonymousID:abc123');
    expect(() => parseRevenueCatEvent(anonymous)).toThrow('not a user id');
  });

  it('refuses a body without an event', () => {
    expect(() => parseRevenueCatEvent('{"api_version":"1.0"}')).toThrow('no event');
  });
});
