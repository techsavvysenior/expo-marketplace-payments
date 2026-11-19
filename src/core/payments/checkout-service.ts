import { type Analytics, type ConsentProvider, eventIds } from '../analytics/events.ts';
import type { Cart } from '../cart.ts';
import { AppError, PaymentCancelledError, ProviderUnavailableError, RuleViolationError } from '../errors.ts';
import type { GatewayResult, OrdersApi, PaymentGateway, PaymentProvider, PendingOrder } from './types.ts';

export type CheckoutReceipt = {
  order: PendingOrder;
  result: GatewayResult;
};

export type CheckoutDeps = {
  orders: OrdersApi;
  gateways: PaymentGateway[];
  analytics: Analytics;
  consent: ConsentProvider;
  newIdempotencyKey: () => string;
};

/**
 * Runs one checkout from cart to provider confirmation.
 *
 *  1. Ask for tracking consent (iOS ATT) and capture attribution.
 *  2. Create the order on the server, which prices it. The idempotency key is
 *     tied to the cart's contents, so retrying after a timeout or a cancelled
 *     sheet reuses the same order instead of creating a duplicate.
 *  3. Hand the order to the chosen gateway.
 *  4. Log Purchase with the same event ID the webhook will send to the
 *     Conversions API.
 *
 * The order is marked paid by the provider's webhook, not by this class.
 */
export class CheckoutService {
  private readonly keys = new Map<string, string>();

  constructor(private readonly deps: CheckoutDeps) {}

  /** Gateways that can be offered right now, in the order they were registered. */
  async availableGateways(cart: Cart): Promise<PaymentGateway[]> {
    if (cart.isEmpty) return [];
    const checks = await Promise.all(
      this.deps.gateways.map(async (gateway) => ((await gateway.isAvailable().catch(() => false)) ? gateway : null)),
    );
    return checks.filter((gateway): gateway is PaymentGateway => gateway !== null);
  }

  async checkout(cart: Cart, provider: PaymentProvider): Promise<CheckoutReceipt> {
    if (cart.isEmpty) throw new RuleViolationError('EMPTY_CART');

    const gateway = this.deps.gateways.find((candidate) => candidate.provider === provider);
    if (!gateway) throw new ProviderUnavailableError(provider);

    const attribution = await this.deps.consent.attribution();
    const idempotencyKey = this.keyFor(cart, provider);

    const order = await this.deps.orders.createOrder({
      items: cart.toOrderItems(),
      provider,
      idempotencyKey,
      attribution,
    });

    await this.deps.analytics.track({
      name: 'InitiateCheckout',
      eventId: eventIds.initiateCheckout(order.id),
      value: order.total,
      numItems: cart.itemCount,
      contentIds: cart.lines.map((line) => line.product.id),
      orderId: order.id,
    });

    let result: GatewayResult;
    try {
      result = await gateway.pay(order);
    } catch (error) {
      // Keep the key on cancel or decline: the next attempt pays the same order.
      if (error instanceof AppError) throw error;
      throw new ProviderUnavailableError(provider, { cause: error });
    }

    this.forget(cart, provider);

    await this.deps.analytics.track({
      name: 'Purchase',
      eventId: eventIds.purchase(order.id),
      value: order.total,
      numItems: cart.itemCount,
      contentIds: cart.lines.map((line) => line.product.id),
      orderId: order.id,
    });

    return { order, result };
  }

  static isCancellation(error: unknown): boolean {
    return error instanceof PaymentCancelledError;
  }

  private keyFor(cart: Cart, provider: PaymentProvider): string {
    const fingerprint = `${provider}:${cart.fingerprint()}`;
    let key = this.keys.get(fingerprint);
    if (!key) {
      key = this.deps.newIdempotencyKey();
      this.keys.set(fingerprint, key);
    }
    return key;
  }

  private forget(cart: Cart, provider: PaymentProvider): void {
    this.keys.delete(`${provider}:${cart.fingerprint()}`);
  }
}
