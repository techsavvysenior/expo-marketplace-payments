import { Money } from './money.ts';

export type ProductKind = 'physical' | 'digital';

export type Product = {
  id: string;
  title: string;
  price: Money;
  kind: ProductKind;
  merchantId: string;
};

export type CartLine = { product: Product; quantity: number };

export const MAX_QUANTITY = 99;

/**
 * An immutable cart. Every change returns a new cart, which keeps React
 * state updates simple and makes the rules easy to test.
 *
 * The total shown here is an estimate for the screen. The order total comes
 * from public.create_order(), which prices from the database.
 */
export class Cart {
  private constructor(private readonly byId: ReadonlyMap<string, CartLine>) {}

  static empty(): Cart {
    return new Cart(new Map());
  }

  get lines(): CartLine[] {
    return [...this.byId.values()];
  }

  get isEmpty(): boolean {
    return this.byId.size === 0;
  }

  get itemCount(): number {
    return this.lines.reduce((sum, line) => sum + line.quantity, 0);
  }

  get currency(): string | undefined {
    return this.lines[0]?.product.price.currency;
  }

  /** Physical goods only. Digital goods are sold through in-app purchase. */
  add(product: Product, quantity = 1): Cart {
    if (product.kind === 'digital') {
      throw new TypeError('Digital products are sold through in-app purchase, not the cart.');
    }
    if (this.currency && product.price.currency !== this.currency) {
      throw new TypeError(`This cart is in ${this.currency}. ${product.title} is priced in ${product.price.currency}.`);
    }
    const current = this.byId.get(product.id)?.quantity ?? 0;
    return this.setQuantity(product, current + quantity);
  }

  setQuantity(product: Product, quantity: number): Cart {
    const next = new Map(this.byId);
    if (quantity <= 0) {
      next.delete(product.id);
    } else {
      next.set(product.id, { product, quantity: Math.min(Math.floor(quantity), MAX_QUANTITY) });
    }
    return new Cart(next);
  }

  remove(productId: string): Cart {
    const next = new Map(this.byId);
    next.delete(productId);
    return new Cart(next);
  }

  estimatedTotal(): Money | undefined {
    const currency = this.currency;
    if (!currency) return undefined;
    return this.lines.reduce((sum, line) => sum.plus(line.product.price.times(line.quantity)), Money.zero(currency));
  }

  /** The payload public.create_order() expects. */
  toOrderItems(): { product_id: string; quantity: number }[] {
    return this.lines.map((line) => ({ product_id: line.product.id, quantity: line.quantity }));
  }

  /**
   * A fingerprint of what is being bought. Checkout keeps one idempotency
   * key per fingerprint, so a retry after a dropped connection reuses the
   * same order, while changing the cart starts a new one.
   */
  fingerprint(): string {
    return this.lines
      .map((line) => `${line.product.id}x${line.quantity}`)
      .sort()
      .join('|');
  }
}
