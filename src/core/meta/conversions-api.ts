import type { Money } from '../money.ts';
import type { Attribution } from '../payments/types.ts';

/**
 * Server-side Meta Conversions API for app events.
 *
 * Spec followed (checked Nov 2026):
 *  - App events: https://developers.facebook.com/docs/marketing-api/conversions-api/app-events
 *    action_source "app", app_data with advertiser_tracking_enabled and
 *    application_tracking_enabled (both required), extinfo as a 16-item array.
 *  - Customer information: em and ph are SHA-256 of normalized values.
 *    client_ip_address, client_user_agent and anon_id are never hashed.
 *  - Deduplication: same event_name and event_id as the SDK event.
 *
 * Shared by the Edge Functions (Deno) and the unit tests (Node). Uses only
 * Web Crypto and fetch, which both runtimes provide.
 */

export const DEFAULT_GRAPH_API_VERSION = 'v26.0';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Digits only, no leading zeros. Expects the country code to be included. */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '').replace(/^0+/, '');
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * extinfo is positional: 16 values, all present, empty string for unknowns.
 * Index 0 is "i2" for iOS and "a2" for Android, index 4 (OS version) is required.
 */
export function buildExtinfo(attribution: Attribution): string[] {
  const extinfo = Array<string>(16).fill('');
  extinfo[0] = attribution.platform === 'android' ? 'a2' : 'i2';
  extinfo[1] = attribution.appBundleId ?? '';
  extinfo[2] = attribution.appVersion ?? ''; // short version
  extinfo[3] = attribution.appVersion ?? ''; // long version
  extinfo[4] = attribution.osVersion ?? '';
  extinfo[5] = attribution.deviceModel ?? '';
  extinfo[6] = attribution.locale ?? '';
  extinfo[15] = attribution.timezone ?? ''; // device timezone, e.g. "America/New_York"
  return extinfo;
}

export type CapiUser = {
  /** Our user id. Hashed and sent as external_id. */
  id: string;
  email?: string | null;
  phone?: string | null;
};

export type CapiEvent = {
  event_name: string;
  event_time: number;
  event_id: string;
  action_source: 'app';
  user_data: Record<string, unknown>;
  custom_data?: Record<string, unknown>;
  app_data: {
    advertiser_tracking_enabled: 0 | 1;
    application_tracking_enabled: 0 | 1;
    extinfo: string[];
  };
};

export async function buildAppEvent(input: {
  eventName: 'Purchase' | 'Subscribe';
  eventId: string;
  occurredAt: Date;
  user: CapiUser;
  attribution: Attribution;
  value: Money;
  orderId?: string;
  contentIds?: string[];
  numItems?: number;
}): Promise<CapiEvent> {
  const { attribution, user } = input;

  const userData: Record<string, unknown> = {
    external_id: [await sha256Hex(user.id)],
  };
  if (user.email) userData.em = [await sha256Hex(normalizeEmail(user.email))];
  if (user.phone) {
    const phone = normalizePhone(user.phone);
    if (phone) userData.ph = [await sha256Hex(phone)];
  }
  if (attribution.anonId) userData.anon_id = attribution.anonId;
  // The advertising ID is only sent when the person allowed tracking.
  if (attribution.advertiserTrackingEnabled && attribution.advertiserId) {
    userData.madid = attribution.advertiserId;
  }

  const customData: Record<string, unknown> = {
    currency: input.value.currency,
    value: input.value.toDecimalString(),
  };
  if (input.orderId) customData.order_id = input.orderId;
  if (input.contentIds?.length) {
    customData.content_ids = input.contentIds;
    customData.content_type = 'product';
  }
  if (input.numItems) customData.num_items = input.numItems;

  return {
    event_name: input.eventName,
    event_time: Math.floor(input.occurredAt.getTime() / 1000),
    event_id: input.eventId,
    action_source: 'app',
    user_data: userData,
    custom_data: customData,
    app_data: {
      advertiser_tracking_enabled: attribution.advertiserTrackingEnabled ? 1 : 0,
      application_tracking_enabled: attribution.applicationTrackingEnabled ? 1 : 0,
      extinfo: buildExtinfo(attribution),
    },
  };
}

export class ConversionsApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Conversions API returned ${status}`);
    this.name = 'ConversionsApiError';
  }
}

export class MetaConversionsClient {
  constructor(
    private readonly config: {
      datasetId: string;
      accessToken: string;
      apiVersion?: string;
      /** From Events Manager, Test events tab. Leave unset in production. */
      testEventCode?: string;
      fetch?: typeof fetch;
    },
  ) {}

  async send(events: CapiEvent[]): Promise<{ eventsReceived: number; fbtraceId?: string }> {
    const version = this.config.apiVersion ?? DEFAULT_GRAPH_API_VERSION;
    const url = new URL(`https://graph.facebook.com/${version}/${this.config.datasetId}/events`);
    url.searchParams.set('access_token', this.config.accessToken);

    const body: Record<string, unknown> = { data: events };
    if (this.config.testEventCode) body.test_event_code = this.config.testEventCode;

    const response = await (this.config.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new ConversionsApiError(response.status, text);

    const json = JSON.parse(text) as { events_received?: number; fbtrace_id?: string };
    return { eventsReceived: json.events_received ?? 0, fbtraceId: json.fbtrace_id };
  }
}
