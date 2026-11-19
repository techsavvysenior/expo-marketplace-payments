import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { PGlite } from '@electric-sql/pglite';

import { asService, asUser, createDatabase, signUp } from './harness.mts';

type Order = {
  id: string;
  status: string;
  currency: string;
  subtotal_cents: number;
  platform_fee_cents: number;
  total_cents: number;
};

const PERMISSION_DENIED = /permission denied/;

let db: PGlite;
let customer: string;
let otherCustomer: string;
let merchant: string;
let otherMerchant: string;
let admin: string;
let mug: string;
let poster: string;
let ebook: string;

async function addProduct(owner: string, title: string, price: number, kind = 'physical', currency = 'USD') {
  return asUser(db, owner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      'insert into public.products (merchant_id, title, price_cents, kind, currency) values ($1, $2, $3, $4, $5) returning id',
      [owner, title, price, kind, currency],
    );
    return rows[0].id;
  });
}

beforeEach(async () => {
  db = await createDatabase();
  customer = await signUp(db, 'cara@example.com');
  otherCustomer = await signUp(db, 'cody@example.com');
  merchant = await signUp(db, 'mo@example.com', 'merchant');
  otherMerchant = await signUp(db, 'mia@example.com', 'merchant');
  admin = await signUp(db, 'ada@example.com', 'admin');
  mug = await addProduct(merchant, 'Mug', 1250);
  poster = await addProduct(otherMerchant, 'Poster', 2000);
  ebook = await addProduct(merchant, 'Ebook', 900, 'digital');
});

afterEach(async () => {
  await db.close();
});

const order = (
  as: string,
  items: Array<{ product_id: string; quantity: number }>,
  key = 'checkout-0001',
  provider = 'stripe',
) =>
  asUser(db, as, async (tx) => {
    const { rows } = await tx.query<Order>('select * from public.create_order($1::jsonb, $2, $3)', [
      JSON.stringify(items),
      provider,
      key,
    ]);
    return rows[0];
  });

const pay = (orderId: string, eventId: string, amount: number, currency = 'usd', provider = 'stripe') =>
  asService(db, async (tx) => {
    const { rows } = await tx.query<{ result: string }>(
      'select public.record_payment($1, $2, $3, $4, $5, $6) as result',
      [provider, eventId, orderId, 'pi_123', amount, currency],
    );
    return rows[0].result;
  });

const status = async (orderId: string) => {
  const { rows } = await db.query<{ status: string }>('select status from public.orders where id = $1', [orderId]);
  return rows[0].status;
};

describe('products', () => {
  it('cannot be listed by a customer', async () => {
    await assert.rejects(addProduct(customer, 'Fake', 1000), /row-level security/);
  });

  it('cannot be listed under another merchant', async () => {
    await assert.rejects(
      asUser(db, merchant, (tx) =>
        tx.query("insert into public.products (merchant_id, title, price_cents) values ($1, 'Fake', 1000)", [otherMerchant]),
      ),
      /row-level security/,
    );
  });

  it("cannot be edited by another merchant", async () => {
    const result = await asUser(db, otherMerchant, (tx) =>
      tx.query('update public.products set price_cents = 1 where id = $1', [mug]),
    );
    assert.equal(result.affectedRows, 0);
  });

  it('can be edited by any admin', async () => {
    const result = await asUser(db, admin, (tx) =>
      tx.query('update public.products set active = false where id = $1', [mug]),
    );
    assert.equal(result.affectedRows, 1);
  });

  it('hides inactive products from customers', async () => {
    await asUser(db, merchant, (tx) => tx.query('update public.products set active = false where id = $1', [mug]));
    const titles = await asUser(db, customer, async (tx) =>
      (await tx.query<{ title: string }>('select title from public.products order by title')).rows.map((r) => r.title),
    );
    assert.deepEqual(titles, ['Ebook', 'Poster']);
  });
});

describe('creating an order', () => {
  it('prices the order from the database, not the app', async () => {
    const created = await order(customer, [
      { product_id: mug, quantity: 2 },
      { product_id: poster, quantity: 1 },
    ]);

    assert.equal(created.subtotal_cents, 4500);
    assert.equal(created.total_cents, 4500);
    assert.equal(created.platform_fee_cents, 450);
    assert.equal(created.status, 'awaiting_payment');
  });

  it('merges repeated lines for the same product', async () => {
    const created = await order(customer, [
      { product_id: mug, quantity: 1 },
      { product_id: mug, quantity: 2 },
    ]);
    assert.equal(created.subtotal_cents, 3750);
  });

  it('returns the same order when the app retries with the same key', async () => {
    const first = await order(customer, [{ product_id: mug, quantity: 1 }]);
    const retry = await order(customer, [{ product_id: mug, quantity: 5 }]);

    assert.equal(retry.id, first.id);
    assert.equal(retry.subtotal_cents, 1250);
  });

  it('sends digital goods to in-app purchase', async () => {
    await assert.rejects(order(customer, [{ product_id: ebook, quantity: 1 }]), /DIGITAL_GOODS_REQUIRE_IN_APP_PURCHASE/);
  });

  it('refuses an inactive or unknown product', async () => {
    await asUser(db, merchant, (tx) => tx.query('update public.products set active = false where id = $1', [mug]));
    await assert.rejects(order(customer, [{ product_id: mug, quantity: 1 }]), /PRODUCT_UNAVAILABLE/);
    await assert.rejects(
      order(customer, [{ product_id: '00000000-0000-0000-0000-000000000000', quantity: 1 }], 'checkout-0002'),
      /PRODUCT_UNAVAILABLE/,
    );
  });

  it('refuses an empty cart and impossible quantities', async () => {
    await assert.rejects(order(customer, []), /EMPTY_CART/);
    await assert.rejects(order(customer, [{ product_id: mug, quantity: 0 }], 'checkout-0002'), /INVALID_QUANTITY/);
  });

  it('refuses a cart that mixes currencies', async () => {
    const euroPrint = await addProduct(otherMerchant, 'Print', 1500, 'physical', 'EUR');
    await assert.rejects(
      order(customer, [
        { product_id: mug, quantity: 1 },
        { product_id: euroPrint, quantity: 1 },
      ]),
      /MIXED_CURRENCIES/,
    );
  });

  it('stops a merchant buying their own product', async () => {
    await assert.rejects(order(merchant, [{ product_id: mug, quantity: 1 }]), /CANNOT_BUY_OWN_PRODUCT/);
  });

  it('cannot be inserted directly', async () => {
    await assert.rejects(
      asUser(db, customer, (tx) =>
        tx.query(
          "insert into public.orders (customer_id, provider, currency, subtotal_cents, platform_fee_cents, total_cents, idempotency_key) values ($1, 'stripe', 'USD', 1, 0, 1, 'sneaky-key')",
          [customer],
        ),
      ),
      PERMISSION_DENIED,
    );
  });
});

describe('who sees an order', () => {
  it('shows the customer their orders and nobody else', async () => {
    const mine = await order(customer, [{ product_id: mug, quantity: 1 }]);
    await order(otherCustomer, [{ product_id: poster, quantity: 1 }]);

    const ids = await asUser(db, customer, async (tx) =>
      (await tx.query<{ id: string }>('select id from public.orders')).rows.map((r) => r.id),
    );
    assert.deepEqual(ids, [mine.id]);
  });

  it('shows a merchant only the orders and lines they sell in', async () => {
    const mixed = await order(customer, [
      { product_id: mug, quantity: 1 },
      { product_id: poster, quantity: 1 },
    ]);
    await order(otherCustomer, [{ product_id: poster, quantity: 1 }]);

    const seen = await asUser(db, merchant, async (tx) => ({
      orders: (await tx.query<{ id: string }>('select id from public.orders')).rows.map((r) => r.id),
      lines: (await tx.query<{ product_id: string }>('select product_id from public.order_items')).rows.map((r) => r.product_id),
    }));
    assert.deepEqual(seen, { orders: [mixed.id], lines: [mug] });
  });

  it('shows an admin every order', async () => {
    await order(customer, [{ product_id: mug, quantity: 1 }]);
    await order(otherCustomer, [{ product_id: poster, quantity: 1 }]);
    const count = await asUser(db, admin, async (tx) => (await tx.query('select id from public.orders')).rows.length);
    assert.equal(count, 2);
  });

  it("never exposes the attribution data used for Meta", async () => {
    await order(customer, [{ product_id: mug, quantity: 1 }]);
    await assert.rejects(
      asUser(db, customer, (tx) => tx.query('select attribution from public.orders')),
      PERMISSION_DENIED,
    );
  });
});

describe('recording a payment (webhook)', () => {
  it('marks the order paid when amount and currency match', async () => {
    const created = await order(customer, [{ product_id: mug, quantity: 2 }]);
    assert.equal(await pay(created.id, 'evt_1', 2500), 'paid');
    assert.equal(await status(created.id), 'paid');
  });

  it('treats a redelivered event as a no-op', async () => {
    const created = await order(customer, [{ product_id: mug, quantity: 1 }]);
    await pay(created.id, 'evt_1', 1250);
    assert.equal(await pay(created.id, 'evt_1', 1250), 'duplicate');
  });

  it('rejects an amount or currency that does not match', async () => {
    const created = await order(customer, [{ product_id: mug, quantity: 1 }]);
    await assert.rejects(pay(created.id, 'evt_1', 100), /AMOUNT_MISMATCH/);
    await assert.rejects(pay(created.id, 'evt_2', 1250, 'eur'), /AMOUNT_MISMATCH/);
    assert.equal(await status(created.id), 'awaiting_payment');
  });

  it('rejects a payment from the wrong provider', async () => {
    const created = await order(customer, [{ product_id: mug, quantity: 1 }], 'checkout-0001', 'paypal');
    await assert.rejects(pay(created.id, 'evt_1', 1250, 'usd', 'stripe'), /PROVIDER_MISMATCH/);
  });

  it('does not reopen a failed order', async () => {
    const created = await order(customer, [{ product_id: mug, quantity: 1 }]);
    await asService(db, (tx) => tx.query("select public.record_payment_failure('stripe', 'evt_f', $1)", [created.id]));
    assert.equal(await pay(created.id, 'evt_2', 1250), 'ignored');
    assert.equal(await status(created.id), 'failed');
  });

  it('cannot be called from the app', async () => {
    const created = await order(customer, [{ product_id: mug, quantity: 1 }]);
    await assert.rejects(
      asUser(db, customer, (tx) =>
        tx.query("select public.record_payment('stripe', 'evt_x', $1, 'pi', 1250, 'usd')", [created.id]),
      ),
      PERMISSION_DENIED,
    );
  });
});

describe('refunds', () => {
  it('lets an admin flag a paid order for refund', async () => {
    const created = await order(customer, [{ product_id: mug, quantity: 1 }]);
    await pay(created.id, 'evt_1', 1250);
    await asUser(db, admin, (tx) => tx.query('select public.request_refund($1)', [created.id]));
    assert.equal(await status(created.id), 'refund_requested');
  });

  it('refuses merchants and unpaid orders', async () => {
    const created = await order(customer, [{ product_id: mug, quantity: 1 }]);
    await assert.rejects(asUser(db, merchant, (tx) => tx.query('select public.request_refund($1)', [created.id])), /FORBIDDEN/);
    await assert.rejects(asUser(db, admin, (tx) => tx.query('select public.request_refund($1)', [created.id])), /ORDER_NOT_REFUNDABLE/);
  });
});

describe('merchant sales summary', () => {
  it('counts only paid orders and takes the platform fee', async () => {
    const paid = await order(customer, [
      { product_id: mug, quantity: 2 },
      { product_id: poster, quantity: 1 },
    ]);
    await pay(paid.id, 'evt_1', 4500);
    await order(otherCustomer, [{ product_id: mug, quantity: 1 }]);

    const summary = await asUser(db, merchant, async (tx) => (await tx.query('select * from public.merchant_sales_summary()')).rows);
    assert.deepEqual(summary, [{ paid_orders: 1, gross_cents: 2500, payout_cents: 2250, currency: 'USD' }]);
  });
});

describe('subscription entitlements (RevenueCat webhook)', () => {
  const apply = (eventId: string, type: string, expires: string | null = '2099-01-01T00:00:00Z') =>
    asService(db, async (tx) => {
      const { rows } = await tx.query<{ result: string }>(
        "select public.apply_entitlement_event($1, $2, $3, array['pro'], 'pro_monthly', 'APP_STORE', $4) as result",
        [eventId, customer, type, expires],
      );
      return rows[0].result;
    });

  const myEntitlements = () =>
    asUser(db, customer, async (tx) =>
      (await tx.query<{ entitlement: string }>('select entitlement from public.my_entitlements')).rows.map((r) => r.entitlement),
    );

  it('grants on purchase and revokes on expiration', async () => {
    assert.equal(await apply('rc_1', 'INITIAL_PURCHASE'), 'granted');
    assert.deepEqual(await myEntitlements(), ['pro']);

    assert.equal(await apply('rc_2', 'EXPIRATION'), 'revoked');
    assert.deepEqual(await myEntitlements(), []);
  });

  it('keeps access after a cancellation until it expires', async () => {
    await apply('rc_1', 'INITIAL_PURCHASE');
    assert.equal(await apply('rc_2', 'CANCELLATION'), 'ignored');
    assert.deepEqual(await myEntitlements(), ['pro']);
  });

  it('hides an entitlement whose expiry has passed', async () => {
    await apply('rc_1', 'INITIAL_PURCHASE', '2001-01-01T00:00:00Z');
    assert.deepEqual(await myEntitlements(), []);
  });

  it('ignores a redelivered event', async () => {
    await apply('rc_1', 'INITIAL_PURCHASE');
    assert.equal(await apply('rc_1', 'INITIAL_PURCHASE'), 'duplicate');
  });

  it("shows users only their own entitlements", async () => {
    await apply('rc_1', 'INITIAL_PURCHASE');
    const seen = await asUser(db, otherCustomer, async (tx) => (await tx.query('select * from public.entitlements')).rows);
    assert.deepEqual(seen, []);
  });
});
