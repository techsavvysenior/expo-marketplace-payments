import { Cart, MAX_QUANTITY, type Product } from '../cart.ts';
import { Money } from '../money.ts';

const mug: Product = { id: 'mug', title: 'Mug', price: Money.of(1250, 'USD'), kind: 'physical', merchantId: 'm1' };
const poster: Product = { id: 'poster', title: 'Poster', price: Money.of(2000, 'USD'), kind: 'physical', merchantId: 'm2' };
const ebook: Product = { id: 'ebook', title: 'Ebook', price: Money.of(900, 'USD'), kind: 'digital', merchantId: 'm1' };
const euroPrint: Product = { id: 'print', title: 'Print', price: Money.of(1500, 'EUR'), kind: 'physical', merchantId: 'm2' };

describe('Cart', () => {
  it('totals lines and merges repeat adds', () => {
    const cart = Cart.empty().add(mug).add(mug).add(poster);
    expect(cart.itemCount).toBe(3);
    expect(cart.estimatedTotal()?.cents).toBe(4500);
    expect(cart.toOrderItems()).toEqual([
      { product_id: 'mug', quantity: 2 },
      { product_id: 'poster', quantity: 1 },
    ]);
  });

  it('never changes the cart it was called on', () => {
    const empty = Cart.empty();
    empty.add(mug);
    expect(empty.isEmpty).toBe(true);
  });

  it('keeps digital goods out of the cart', () => {
    expect(() => Cart.empty().add(ebook)).toThrow(/in-app purchase/);
  });

  it('keeps one currency per cart', () => {
    expect(() => Cart.empty().add(mug).add(euroPrint)).toThrow(/USD/);
  });

  it('caps quantity and removes a line set to zero', () => {
    expect(Cart.empty().setQuantity(mug, 500).lines[0].quantity).toBe(MAX_QUANTITY);
    expect(Cart.empty().add(mug).setQuantity(mug, 0).isEmpty).toBe(true);
  });

  it('gives the same fingerprint for the same contents in any order', () => {
    const a = Cart.empty().add(mug).add(poster);
    const b = Cart.empty().add(poster).add(mug);
    expect(a.fingerprint()).toBe(b.fingerprint());
    expect(a.add(mug).fingerprint()).not.toBe(b.fingerprint());
  });
});
