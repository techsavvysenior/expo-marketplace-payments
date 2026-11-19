import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';

import { env, HttpError } from './http.ts';

/** Bypasses RLS. Only for webhooks and server-side bookkeeping. */
export function serviceClient(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * The caller's own client: every query runs with their JWT, so row-level
 * security decides what they can read, exactly as in the app.
 */
export async function requireUser(req: Request): Promise<{ user: User; client: SupabaseClient }> {
  const authorization = req.headers.get('Authorization');
  if (!authorization) throw new HttpError(401, 'not_authenticated');

  const client = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new HttpError(401, 'not_authenticated');
  return { user: data.user, client };
}

export type OrderRow = {
  id: string;
  customer_id: string;
  provider: 'stripe' | 'paypal';
  status: string;
  currency: string;
  total_cents: number;
};

/** Loads an order through the caller's RLS, so a user can only pay their own. */
export async function loadOwnOrder(client: SupabaseClient, orderId: string, userId: string): Promise<OrderRow> {
  const { data, error } = await client
    .from('orders')
    .select('id, customer_id, provider, status, currency, total_cents')
    .eq('id', orderId)
    .maybeSingle<OrderRow>();
  if (error) throw error;
  if (!data || data.customer_id !== userId) throw new HttpError(404, 'order_not_found');
  if (data.status !== 'awaiting_payment') throw new HttpError(409, 'order_not_payable');
  return data;
}

/** Maps a Postgres exception raised with a rule name to an HTTP error. */
export function ruleError(error: { message?: string } | null): HttpError | null {
  const rule = error?.message?.match(/[A-Z][A-Z_]{5,}/)?.[0];
  return rule ? new HttpError(422, rule) : null;
}
