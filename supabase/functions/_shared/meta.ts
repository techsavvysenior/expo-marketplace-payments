import type { SupabaseClient } from '@supabase/supabase-js';

import { eventIds } from '../../../src/core/analytics/events.ts';
import { buildAppEvent, MetaConversionsClient } from '../../../src/core/meta/conversions-api.ts';
import { Money } from '../../../src/core/money.ts';
import type { Attribution } from '../../../src/core/payments/types.ts';
import { optionalEnv } from './http.ts';

/**
 * Sends the server-side Purchase for a paid order. Uses the same event_id as
 * the app's SDK event, so Meta counts the purchase once.
 *
 * Failures are logged and swallowed: the payment is already recorded, and
 * analytics must not make the webhook fail and retry.
 */
export async function sendPurchaseToMeta(service: SupabaseClient, orderId: string): Promise<void> {
  const datasetId = optionalEnv('META_DATASET_ID');
  const accessToken = optionalEnv('META_CAPI_ACCESS_TOKEN');
  if (!datasetId || !accessToken) {
    console.log('Meta Conversions API not configured, skipping', orderId);
    return;
  }

  try {
    const { data: order, error } = await service
      .from('orders')
      .select('id, customer_id, currency, total_cents, paid_at, attribution, order_items(product_id, quantity)')
      .eq('id', orderId)
      .single<{
        id: string;
        customer_id: string;
        currency: string;
        total_cents: number;
        paid_at: string | null;
        attribution: Partial<Attribution>;
        order_items: { product_id: string; quantity: number }[];
      }>();
    if (error) throw error;

    const { data: account } = await service.auth.admin.getUserById(order.customer_id);
    const attribution: Attribution = {
      ...order.attribution,
      platform: order.attribution.platform === 'android' ? 'android' : 'ios',
      advertiserTrackingEnabled: order.attribution.advertiserTrackingEnabled === true,
      applicationTrackingEnabled: order.attribution.applicationTrackingEnabled !== false,
    };

    const event = await buildAppEvent({
      eventName: 'Purchase',
      eventId: eventIds.purchase(order.id),
      occurredAt: new Date(order.paid_at ?? Date.now()),
      user: { id: order.customer_id, email: account.user?.email, phone: account.user?.phone },
      attribution,
      value: Money.of(order.total_cents, order.currency),
      orderId: order.id,
      contentIds: order.order_items.map((item) => item.product_id),
      numItems: order.order_items.reduce((sum, item) => sum + item.quantity, 0),
    });

    const result = await new MetaConversionsClient({
      datasetId,
      accessToken,
      apiVersion: optionalEnv('META_GRAPH_API_VERSION'),
      testEventCode: optionalEnv('META_TEST_EVENT_CODE'),
    }).send([event]);
    console.log('Meta purchase sent', orderId, result);
  } catch (error) {
    console.error('Meta purchase failed', orderId, error);
  }
}
