import { Money } from '@/core/money';
import type { OrdersApi, PendingOrder } from '@/core/payments/types';
import { supabase } from '@/lib/supabase';
import { toAppError } from '@/lib/to-app-error';

/** Creates orders through public.create_order(), which prices them from the database. */
export const supabaseOrdersApi: OrdersApi = {
  async createOrder({ items, provider, idempotencyKey, attribution }): Promise<PendingOrder> {
    const { data, error } = await supabase
      .rpc('create_order', {
        p_items: items,
        p_provider: provider,
        p_idempotency_key: idempotencyKey,
        p_attribution: attribution,
      })
      .single<{ id: string; provider: 'stripe' | 'paypal'; total_cents: number; currency: string }>();
    if (error) throw toAppError(error);
    return { id: data.id, provider: data.provider, total: Money.of(data.total_cents, data.currency) };
  },
};
