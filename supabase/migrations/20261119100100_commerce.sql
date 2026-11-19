-- Products, orders, payments and subscription entitlements.
--
-- Rules the database enforces, whatever the app sends:
--   * prices come from the products table, never from the client
--   * physical goods are paid through Stripe or PayPal
--   * digital goods and subscriptions go through App Store or Google Play billing,
--     so they can't be put in a Stripe or PayPal order
--   * an order is marked paid only by the payment webhooks (service role), only
--     once, and only when the amount and currency match the order
--   * every webhook event is recorded so a retried delivery is a no-op

create type public.product_kind as enum ('physical', 'digital');
create type public.payment_provider as enum ('stripe', 'paypal');
create type public.order_status as enum ('awaiting_payment', 'paid', 'failed', 'refund_requested', 'refunded');

create table public.products (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  price_cents integer not null check (price_cents between 50 and 10000000),
  currency char(3) not null default 'USD' check (currency = upper(currency)),
  kind public.product_kind not null default 'physical',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index products_merchant_idx on public.products (merchant_id);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references auth.users (id) on delete cascade,
  provider public.payment_provider not null,
  status public.order_status not null default 'awaiting_payment',
  currency char(3) not null,
  subtotal_cents integer not null check (subtotal_cents > 0),
  platform_fee_cents integer not null check (platform_fee_cents >= 0),
  total_cents integer not null check (total_cents = subtotal_cents),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 80),
  provider_reference text,
  -- Meta attribution captured on the device at checkout, used by the
  -- Conversions API call when the payment is confirmed server-side.
  attribution jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  unique (customer_id, idempotency_key)
);

create index orders_customer_idx on public.orders (customer_id, created_at desc);

create table public.order_items (
  order_id uuid not null references public.orders (id) on delete cascade,
  product_id uuid not null references public.products (id),
  merchant_id uuid not null references auth.users (id),
  unit_price_cents integer not null check (unit_price_cents > 0),
  quantity integer not null check (quantity between 1 and 99),
  primary key (order_id, product_id)
);

create index order_items_merchant_idx on public.order_items (merchant_id);

create table public.payment_events (
  provider text not null,
  event_id text not null,
  received_at timestamptz not null default now(),
  primary key (provider, event_id)
);

create table public.entitlements (
  user_id uuid not null references auth.users (id) on delete cascade,
  entitlement text not null,
  product_id text not null,
  store text,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, entitlement)
);

-- Platform keeps 10%, in whole cents, rounded down.
create function public.platform_fee(subtotal integer)
returns integer
language sql
immutable
as $$ select (subtotal * 10) / 100 $$;

-- The only way to create an order.
-- p_items: [{"product_id": "...", "quantity": 2}, ...]
create function public.create_order(
  p_items jsonb,
  p_provider public.payment_provider,
  p_idempotency_key text,
  p_attribution jsonb default '{}'::jsonb
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  existing public.orders;
  created public.orders;
  line record;
  order_currency char(3);
  subtotal integer := 0;
  line_count integer := 0;
begin
  if me is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;

  select * into existing from public.orders
  where customer_id = me and idempotency_key = p_idempotency_key;
  if found then
    return existing;
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_CART' using errcode = 'P0001';
  end if;

  create temporary table if not exists pg_temp.cart_lines (
    product_id uuid, merchant_id uuid, price integer, currency char(3), kind public.product_kind, active boolean, quantity integer
  ) on commit drop;
  delete from pg_temp.cart_lines;

  insert into pg_temp.cart_lines
  select p.id, p.merchant_id, p.price_cents, p.currency, p.kind, p.active, i.quantity
  from (
    select (x ->> 'product_id')::uuid as product_id, sum((x ->> 'quantity')::integer) as quantity
    from jsonb_array_elements(p_items) x
    group by 1
  ) i
  left join public.products p on p.id = i.product_id;

  for line in select * from pg_temp.cart_lines loop
    if line.merchant_id is null or not line.active then
      raise exception 'PRODUCT_UNAVAILABLE' using errcode = 'P0002';
    end if;
    if line.kind = 'digital' then
      raise exception 'DIGITAL_GOODS_REQUIRE_IN_APP_PURCHASE' using errcode = 'P0001';
    end if;
    if line.quantity not between 1 and 99 then
      raise exception 'INVALID_QUANTITY' using errcode = 'P0001';
    end if;
    if line.merchant_id = me then
      raise exception 'CANNOT_BUY_OWN_PRODUCT' using errcode = 'P0001';
    end if;
    if order_currency is null then
      order_currency := line.currency;
    elsif order_currency <> line.currency then
      raise exception 'MIXED_CURRENCIES' using errcode = 'P0001';
    end if;
    subtotal := subtotal + line.price * line.quantity;
    line_count := line_count + 1;
  end loop;

  insert into public.orders (
    customer_id, provider, currency, subtotal_cents, platform_fee_cents, total_cents, idempotency_key, attribution
  )
  values (
    me, p_provider, order_currency, subtotal, public.platform_fee(subtotal), subtotal, p_idempotency_key,
    coalesce(p_attribution, '{}'::jsonb)
  )
  returning * into created;

  insert into public.order_items (order_id, product_id, merchant_id, unit_price_cents, quantity)
  select created.id, product_id, merchant_id, price, quantity from pg_temp.cart_lines;

  return created;
end;
$$;

-- Webhook side. Records the event first, so a retry returns 'duplicate'.
-- Returns 'paid', 'duplicate' or 'ignored' (order already in a final state).
create function public.record_payment(
  p_provider public.payment_provider,
  p_event_id text,
  p_order_id uuid,
  p_provider_reference text,
  p_amount_cents integer,
  p_currency text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.orders;
begin
  insert into public.payment_events (provider, event_id)
  values (p_provider::text, p_event_id)
  on conflict do nothing;
  if not found then
    return 'duplicate';
  end if;

  select * into target from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if target.provider <> p_provider then
    raise exception 'PROVIDER_MISMATCH' using errcode = 'P0001';
  end if;
  if target.total_cents <> p_amount_cents or target.currency <> upper(p_currency) then
    raise exception 'AMOUNT_MISMATCH' using errcode = 'P0001';
  end if;
  if target.status <> 'awaiting_payment' then
    return 'ignored';
  end if;

  update public.orders
  set status = 'paid', paid_at = now(), provider_reference = p_provider_reference
  where id = p_order_id;
  return 'paid';
end;
$$;

create function public.record_payment_failure(p_provider public.payment_provider, p_event_id text, p_order_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.payment_events (provider, event_id)
  values (p_provider::text, p_event_id)
  on conflict do nothing;
  if not found then
    return 'duplicate';
  end if;

  update public.orders set status = 'failed'
  where id = p_order_id and status = 'awaiting_payment';
  return case when found then 'failed' else 'ignored' end;
end;
$$;

-- Admins flag a paid order for refund. The refund itself is issued with the
-- provider and confirmed by its webhook.
create function public.request_refund(p_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated public.orders;
begin
  if not public.authorize('orders.refund') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  update public.orders set status = 'refund_requested'
  where id = p_order_id and status = 'paid'
  returning * into updated;
  if not found then
    raise exception 'ORDER_NOT_REFUNDABLE' using errcode = 'P0001';
  end if;
  return updated;
end;
$$;

-- RevenueCat webhook side. Grants or revokes one entitlement per event.
create function public.apply_entitlement_event(
  p_event_id text,
  p_user_id uuid,
  p_event_type text,
  p_entitlements text[],
  p_product_id text,
  p_store text,
  p_expires_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  ent text;
begin
  insert into public.payment_events (provider, event_id)
  values ('revenuecat', p_event_id)
  on conflict do nothing;
  if not found then
    return 'duplicate';
  end if;

  if not exists (select 1 from auth.users where id = p_user_id) then
    return 'unknown_user';
  end if;

  if p_event_type in ('INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE',
                      'SUBSCRIPTION_EXTENDED', 'NON_RENEWING_PURCHASE', 'TEMPORARY_ENTITLEMENT_GRANT') then
    foreach ent in array coalesce(p_entitlements, '{}') loop
      insert into public.entitlements (user_id, entitlement, product_id, store, expires_at, updated_at)
      values (p_user_id, ent, p_product_id, p_store, p_expires_at, now())
      on conflict (user_id, entitlement) do update
        set product_id = excluded.product_id,
            store = excluded.store,
            expires_at = excluded.expires_at,
            updated_at = now();
    end loop;
    return 'granted';
  elsif p_event_type = 'EXPIRATION' then
    delete from public.entitlements
    where user_id = p_user_id and entitlement = any (coalesce(p_entitlements, '{}'));
    return 'revoked';
  end if;

  -- CANCELLATION only turns off auto-renew. Access lasts until EXPIRATION.
  return 'ignored';
end;
$$;

create view public.my_entitlements
with (security_invoker = true)
as
select entitlement, product_id, store, expires_at
from public.entitlements
where user_id = auth.uid()
  and (expires_at is null or expires_at > now());

-- Merchant dashboard numbers, computed in the database.
create function public.merchant_sales_summary()
returns table (paid_orders bigint, gross_cents bigint, payout_cents bigint, currency char(3))
language sql
stable
security invoker
set search_path = ''
as $$
  select
    count(distinct o.id),
    coalesce(sum(oi.unit_price_cents * oi.quantity), 0),
    coalesce(sum(oi.unit_price_cents * oi.quantity - public.platform_fee(oi.unit_price_cents * oi.quantity)), 0),
    o.currency
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where oi.merchant_id = auth.uid() and o.status = 'paid'
  group by o.currency;
$$;

alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.payment_events enable row level security;
alter table public.entitlements enable row level security;

create policy "signed-in users browse active products" on public.products
  for select to authenticated
  using (active or merchant_id = (select auth.uid()) or (select public.authorize('products.manage_all')));

create policy "merchants add their own products" on public.products
  for insert to authenticated
  with check (
    (select public.authorize('products.manage_own')) and merchant_id = (select auth.uid())
  );

create policy "merchants edit their own products, admins edit any" on public.products
  for update to authenticated
  using (
    ((select public.authorize('products.manage_own')) and merchant_id = (select auth.uid()))
    or (select public.authorize('products.manage_all'))
  )
  with check (
    ((select public.authorize('products.manage_own')) and merchant_id = (select auth.uid()))
    or (select public.authorize('products.manage_all'))
  );

-- Security definer, so the check below doesn't recurse into order_items RLS.
create function public.sells_in_order(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.order_items
    where order_id = p_order_id and merchant_id = auth.uid()
  );
$$;

create policy "customers see their orders, merchants see orders they sell in, admins see all"
  on public.orders for select to authenticated
  using (
    customer_id = (select auth.uid())
    or public.sells_in_order(id)
    or (select public.authorize('orders.read_all'))
  );

create policy "order lines follow the order, merchants see only their lines"
  on public.order_items for select to authenticated
  using (
    merchant_id = (select auth.uid())
    or exists (select 1 from public.orders o where o.id = order_id and o.customer_id = (select auth.uid()))
    or (select public.authorize('orders.read_all'))
  );

create policy "users read their own entitlements" on public.entitlements
  for select to authenticated using (user_id = (select auth.uid()));

-- No insert, update or delete policies on orders, order_items, payment_events
-- or entitlements: every write goes through the functions above.
revoke all on public.products, public.orders, public.order_items, public.payment_events, public.entitlements from anon;
revoke insert, update, delete on public.orders, public.order_items, public.payment_events, public.entitlements from authenticated;
revoke all on public.payment_events from authenticated;
revoke delete on public.products from authenticated;
revoke update on public.products from authenticated;
grant update (title, price_cents, active) on public.products to authenticated;
-- Customers never see each other's attribution data, and merchants don't need it.
revoke select on public.orders from authenticated;
grant select (id, customer_id, provider, status, currency, subtotal_cents, platform_fee_cents, total_cents,
              provider_reference, created_at, paid_at)
  on public.orders to authenticated;

revoke execute on function public.create_order, public.request_refund, public.merchant_sales_summary,
  public.record_payment, public.record_payment_failure, public.apply_entitlement_event, public.sells_in_order
  from public, anon;
grant execute on function public.create_order, public.request_refund, public.merchant_sales_summary,
  public.sells_in_order to authenticated;
revoke execute on function public.record_payment, public.record_payment_failure, public.apply_entitlement_event
  from authenticated;
grant execute on function public.record_payment, public.record_payment_failure, public.apply_entitlement_event
  to service_role;
