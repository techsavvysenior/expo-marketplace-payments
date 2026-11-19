import { createHash } from 'node:crypto';

import { buildAppEvent, buildExtinfo, MetaConversionsClient, normalizeEmail, normalizePhone, sha256Hex } from '../meta/conversions-api.ts';
import { Money } from '../money.ts';
import type { Attribution } from '../payments/types.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

const iosAttribution: Attribution = {
  platform: 'ios',
  advertiserTrackingEnabled: true,
  applicationTrackingEnabled: true,
  anonId: 'XZ-install-1',
  advertiserId: '38400000-8cf0-11bd-b23e-10b96e40000d',
  appBundleId: 'dev.example.marketplace',
  appVersion: '1.2.0',
  osVersion: '18.1',
  deviceModel: 'iPhone16,2',
  locale: 'en_US',
  timezone: 'America/New_York',
};

describe('normalization and hashing', () => {
  it('normalizes email and phone the way Meta asks', () => {
    expect(normalizeEmail('  Cara@Example.COM ')).toBe('cara@example.com');
    expect(normalizePhone('+1 (650) 555-1212')).toBe('16505551212');
    expect(normalizePhone('0044 20 7946 0958')).toBe('442079460958');
  });

  it('hashes with SHA-256 hex, matching Node crypto', async () => {
    expect(await sha256Hex('cara@example.com')).toBe(sha('cara@example.com'));
  });
});

describe('extinfo', () => {
  it('is always 16 positional strings with the platform code first', () => {
    const extinfo = buildExtinfo(iosAttribution);
    expect(extinfo).toHaveLength(16);
    expect(extinfo[0]).toBe('i2');
    expect(extinfo[4]).toBe('18.1');
    expect(buildExtinfo({ ...iosAttribution, platform: 'android' })[0]).toBe('a2');
    expect(buildExtinfo({ platform: 'android', advertiserTrackingEnabled: false, applicationTrackingEnabled: true }).every((v) => typeof v === 'string')).toBe(true);
  });
});

describe('buildAppEvent', () => {
  const base = {
    eventName: 'Purchase' as const,
    eventId: 'purchase_order-1',
    occurredAt: new Date('2026-11-19T15:00:00Z'),
    user: { id: 'user-1', email: ' Cara@Example.com ', phone: '+1 650 555 1212' },
    value: Money.of(2500, 'USD'),
    orderId: 'order-1',
    contentIds: ['mug'],
    numItems: 2,
  };

  it('builds an app event with hashed identifiers and plain device IDs', async () => {
    const event = await buildAppEvent({ ...base, attribution: iosAttribution });

    expect(event).toMatchObject({
      event_name: 'Purchase',
      event_time: Date.parse("2026-11-19T15:00:00Z") / 1000,
      event_id: 'purchase_order-1',
      action_source: 'app',
      user_data: {
        em: [sha('cara@example.com')],
        ph: [sha('16505551212')],
        external_id: [sha('user-1')],
        anon_id: 'XZ-install-1',
        madid: iosAttribution.advertiserId,
      },
      custom_data: { currency: 'USD', value: '25.00', order_id: 'order-1', content_ids: ['mug'], num_items: 2 },
      app_data: { advertiser_tracking_enabled: 1, application_tracking_enabled: 1 },
    });
  });

  it('leaves out the advertising ID when tracking was not allowed', async () => {
    const event = await buildAppEvent({
      ...base,
      attribution: { ...iosAttribution, advertiserTrackingEnabled: false },
    });
    expect(event.user_data.madid).toBeUndefined();
    expect(event.app_data.advertiser_tracking_enabled).toBe(0);
  });
});

describe('MetaConversionsClient', () => {
  it('posts to the dataset events endpoint with the test code', async () => {
    const fetchMock = jest.fn(async () => new Response(JSON.stringify({ events_received: 1, fbtrace_id: 'trace' })));
    const client = new MetaConversionsClient({
      datasetId: '123',
      accessToken: 'token',
      testEventCode: 'TEST42',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.send([]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('https://graph.facebook.com/v26.0/123/events?access_token=token');
    expect(JSON.parse(init.body as string)).toEqual({ data: [], test_event_code: 'TEST42' });
    expect(result).toEqual({ eventsReceived: 1, fbtraceId: 'trace' });
  });

  it('raises with the response body on an error', async () => {
    const client = new MetaConversionsClient({
      datasetId: '123',
      accessToken: 'bad',
      fetch: (async () => new Response('{"error":{"message":"Invalid OAuth"}}', { status: 400 })) as typeof fetch,
    });
    await expect(client.send([])).rejects.toMatchObject({ status: 400, body: expect.stringContaining('Invalid OAuth') });
  });
});
