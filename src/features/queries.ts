import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { Product } from '@/core/cart';
import { Money } from '@/core/money';
import type { Role } from '@/core/roles';
import { supabase } from '@/lib/supabase';
import { toAppError } from '@/lib/to-app-error';

type ProductRow = {
  id: string;
  merchant_id: string;
  title: string;
  price_cents: number;
  currency: string;
  kind: 'physical' | 'digital';
  active: boolean;
};

export type OrderRow = {
  id: string;
  customer_id: string;
  provider: 'stripe' | 'paypal';
  status: 'awaiting_payment' | 'paid' | 'failed' | 'refund_requested' | 'refunded';
  currency: string;
  total_cents: number;
  created_at: string;
};

const ORDER_COLUMNS = 'id, customer_id, provider, status, currency, total_cents, created_at';

export const toProduct = (row: ProductRow): Product & { active: boolean } => ({
  id: row.id,
  title: row.title,
  price: Money.of(row.price_cents, row.currency),
  kind: row.kind,
  merchantId: row.merchant_id,
  active: row.active,
});

async function unwrap<T>(query: PromiseLike<{ data: T | null; error: unknown }>): Promise<T> {
  const { data, error } = await query;
  if (error) throw toAppError(error);
  return data as T;
}

export const keys = {
  catalog: ['catalog'] as const,
  myProducts: (userId: string) => ['products', userId] as const,
  orders: ['orders'] as const,
  sales: ['sales'] as const,
  entitlements: ['entitlements'] as const,
  users: ['users'] as const,
};

export function useCatalog() {
  return useQuery({
    queryKey: keys.catalog,
    queryFn: async () =>
      (await unwrap(supabase.from('products').select('*').eq('active', true).order('created_at', { ascending: false })) as ProductRow[]).map(toProduct),
  });
}

export function useMyProducts(userId: string) {
  return useQuery({
    queryKey: keys.myProducts(userId),
    queryFn: async () =>
      (await unwrap(supabase.from('products').select('*').eq('merchant_id', userId).order('created_at', { ascending: false })) as ProductRow[]).map(toProduct),
  });
}

/** Row-level security decides the scope: own orders, orders sold in, or all for admins. */
export function useOrders() {
  return useQuery({
    queryKey: keys.orders,
    queryFn: () => unwrap(supabase.from('orders').select(ORDER_COLUMNS).order('created_at', { ascending: false }).limit(50)) as Promise<OrderRow[]>,
  });
}

export function useSalesSummary() {
  return useQuery({
    queryKey: keys.sales,
    queryFn: () =>
      unwrap(supabase.rpc('merchant_sales_summary')) as Promise<
        { paid_orders: number; gross_cents: number; payout_cents: number; currency: string }[]
      >,
  });
}

export function useEntitlements() {
  return useQuery({
    queryKey: keys.entitlements,
    queryFn: () => unwrap(supabase.from('my_entitlements').select('entitlement, expires_at')) as Promise<{ entitlement: string; expires_at: string | null }[]>,
  });
}

export function useAddProduct(userId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { title: string; priceCents: number; kind: 'physical' | 'digital' }) =>
      unwrap(
        supabase.from('products').insert({ merchant_id: userId, title: input.title, price_cents: input.priceCents, kind: input.kind }),
      ),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: keys.myProducts(userId) });
      client.invalidateQueries({ queryKey: keys.catalog });
    },
  });
}

export function useSetProductActive(userId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; active: boolean }) =>
      unwrap(supabase.from('products').update({ active: input.active }).eq('id', input.id)),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: keys.myProducts(userId) });
      client.invalidateQueries({ queryKey: keys.catalog });
    },
  });
}

export function useRequestRefund() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) => unwrap(supabase.rpc('request_refund', { p_order_id: orderId })),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.orders }),
  });
}

export type UserWithRole = { user_id: string; role: Role; display_name: string };

/** Admin only: user_roles is readable in full only with the roles.assign permission. */
export function useUsers() {
  return useQuery({
    queryKey: keys.users,
    queryFn: async () => {
      const [roles, profiles] = await Promise.all([
        unwrap(supabase.from('user_roles').select('user_id, role')) as Promise<{ user_id: string; role: Role }[]>,
        unwrap(supabase.from('profiles').select('id, display_name')) as Promise<{ id: string; display_name: string }[]>,
      ]);
      const names = new Map(profiles.map((p) => [p.id, p.display_name]));
      return roles.map((r): UserWithRole => ({ ...r, display_name: names.get(r.user_id) ?? 'Unknown' }));
    },
  });
}

export function useAssignRole() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; role: Role }) =>
      unwrap(supabase.rpc('assign_role', { p_user_id: input.userId, p_role: input.role })),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.users }),
  });
}
