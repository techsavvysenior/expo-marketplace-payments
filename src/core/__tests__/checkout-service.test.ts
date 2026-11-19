import { Analytics, type AnalyticsSink, type CommerceEvent } from '../analytics/events.ts';
import { Cart, type Product } from '../cart.ts';
import { PaymentCancelledError, PaymentDeclinedError, ProviderUnavailableError, RuleViolationError } from '../errors.ts';
import { Money } from '../money.ts';
import { CheckoutService } from '../payments/checkout-service.ts';
import type { Attribution, GatewayResult, OrdersApi, PaymentGateway, PendingOrder } from '../payments/types.ts';

const mug: Product = { id: 'mug', title: 'Mug', price: Money.of(1250, 'USD'), kind: 'physical', merchantId: 'm1' };

const attribution: Attribution = {
  platform: 'ios',
  advertiserTrackingEnabled: false,
  applicationTrackingEnabled: true,
  anonId: 'XZ-install-1',
};

class FakeGateway implements PaymentGateway {
  readonly label = 'Fake';
  next: () => Promise<GatewayResult> = async () => ({ status: 'succeeded', providerReference: 'pi_1' });
  paid: PendingOrder[] = [];
  constructor(
    readonly provider: 'stripe' | 'paypal',
    private available = true,
  ) {}
  async isAvailable() {
    return this.available;
  }
  async pay(order: PendingOrder) {
    this.paid.push(order);
    return this.next();
  }
}

class RecordingSink implements AnalyticsSink {
  readonly name = 'recording';
  events: CommerceEvent[] = [];
  track(event: CommerceEvent) {
    this.events.push(event);
  }
}

function setup() {
  let counter = 0;
  const orders: jest.Mocked<OrdersApi> = {
    createOrder: jest.fn(async (input) => ({
      id: `order-for-${input.idempotencyKey}`,
      provider: input.provider,
      total: Money.of(2500, 'USD'),
    })),
  };
  const stripe = new FakeGateway('stripe');
  const paypal = new FakeGateway('paypal', false);
  const sink = new RecordingSink();
  const service = new CheckoutService({
    orders,
    gateways: [stripe, paypal],
    analytics: new Analytics([sink]),
    consent: { attribution: async () => attribution },
    newIdempotencyKey: () => `key-${++counter}`,
  });
  return { service, orders, stripe, paypal, sink };
}

const cart = Cart.empty().add(mug, 2);

describe('CheckoutService', () => {
  it('creates the order on the server, pays it, and logs a deduplicable Purchase', async () => {
    const { service, orders, stripe, sink } = setup();

    const receipt = await service.checkout(cart, 'stripe');

    expect(orders.createOrder).toHaveBeenCalledWith({
      items: [{ product_id: 'mug', quantity: 2 }],
      provider: 'stripe',
      idempotencyKey: 'key-1',
      attribution,
    });
    expect(stripe.paid).toHaveLength(1);
    expect(receipt.result.providerReference).toBe('pi_1');
    expect(sink.events.map((event) => [event.name, event.eventId])).toEqual([
      ['InitiateCheckout', 'checkout_order-for-key-1'],
      ['Purchase', 'purchase_order-for-key-1'],
    ]);
  });

  it('reuses the same order when the person cancels and tries again', async () => {
    const { service, orders, stripe, sink } = setup();
    stripe.next = async () => {
      throw new PaymentCancelledError();
    };

    await expect(service.checkout(cart, 'stripe')).rejects.toBeInstanceOf(PaymentCancelledError);
    stripe.next = async () => ({ status: 'succeeded', providerReference: 'pi_2' });
    await service.checkout(cart, 'stripe');

    const keys = orders.createOrder.mock.calls.map(([input]) => input.idempotencyKey);
    expect(keys).toEqual(['key-1', 'key-1']);
    expect(sink.events.filter((event) => event.name === 'Purchase')).toHaveLength(1);
  });

  it('starts a new order after a successful one', async () => {
    const { service, orders } = setup();
    await service.checkout(cart, 'stripe');
    await service.checkout(cart, 'stripe');
    expect(orders.createOrder.mock.calls.map(([input]) => input.idempotencyKey)).toEqual(['key-1', 'key-2']);
  });

  it('starts a new order when the cart changes', async () => {
    const { service, orders, stripe } = setup();
    stripe.next = async () => {
      throw new PaymentDeclinedError('Card declined');
    };
    await expect(service.checkout(cart, 'stripe')).rejects.toBeInstanceOf(PaymentDeclinedError);
    await expect(service.checkout(cart.add(mug), 'stripe')).rejects.toBeInstanceOf(PaymentDeclinedError);
    expect(orders.createOrder.mock.calls.map(([input]) => input.idempotencyKey)).toEqual(['key-1', 'key-2']);
  });

  it('wraps an unexpected gateway crash as provider unavailable', async () => {
    const { service, stripe } = setup();
    stripe.next = async () => {
      throw new Error('native module missing');
    };
    await expect(service.checkout(cart, 'stripe')).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('refuses an empty cart before calling the server', async () => {
    const { service, orders } = setup();
    await expect(service.checkout(Cart.empty(), 'stripe')).rejects.toBeInstanceOf(RuleViolationError);
    expect(orders.createOrder).not.toHaveBeenCalled();
  });

  it('only offers gateways that are available on this device', async () => {
    const { service } = setup();
    expect((await service.availableGateways(cart)).map((g) => g.provider)).toEqual(['stripe']);
  });

  it('completes checkout even when an analytics sink fails', async () => {
    const failures: string[] = [];
    const service = new CheckoutService({
      orders: { createOrder: async () => ({ id: 'o1', provider: 'stripe', total: Money.of(100, 'USD') }) },
      gateways: [new FakeGateway('stripe')],
      analytics: new Analytics(
        [{ name: 'broken', track: () => { throw new Error('sdk not initialised'); } }],
        (sink) => failures.push(sink),
      ),
      consent: { attribution: async () => attribution },
      newIdempotencyKey: () => 'key-x',
    });

    await expect(service.checkout(cart, 'stripe')).resolves.toBeDefined();
    expect(failures).toEqual(['broken', 'broken']);
  });
});
