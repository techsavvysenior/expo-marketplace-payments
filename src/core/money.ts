/**
 * An amount in minor units (cents) with its currency.
 *
 * Integer math only, so totals never pick up floating-point drift, and
 * arithmetic across currencies is a programming error, not a silent bug.
 */
export class Money {
  private constructor(
    readonly cents: number,
    readonly currency: string,
  ) {}

  static of(cents: number, currency: string): Money {
    if (!Number.isSafeInteger(cents) || cents < 0) {
      throw new RangeError(`Money needs a whole, non-negative number of cents, got ${cents}`);
    }
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new RangeError(`Currency must be a three-letter ISO 4217 code, got "${currency}"`);
    }
    return new Money(cents, currency);
  }

  static zero(currency: string): Money {
    return Money.of(0, currency);
  }

  plus(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.cents + other.cents, this.currency);
  }

  times(quantity: number): Money {
    if (!Number.isInteger(quantity) || quantity < 0) {
      throw new RangeError(`Quantity must be a whole number, got ${quantity}`);
    }
    return Money.of(this.cents * quantity, this.currency);
  }

  /** Percentage of this amount, rounded down to the cent. Mirrors public.platform_fee(). */
  percent(rate: number): Money {
    return Money.of(Math.floor((this.cents * rate) / 100), this.currency);
  }

  equals(other: Money): boolean {
    return this.cents === other.cents && this.currency === other.currency;
  }

  /** Decimal string for APIs that want one, e.g. PayPal's "12.50". Assumes two minor digits. */
  toDecimalString(): string {
    const whole = Math.floor(this.cents / 100);
    const fraction = String(this.cents % 100).padStart(2, '0');
    return `${whole}.${fraction}`;
  }

  /** Major units as a number, for SDKs like Meta's logPurchase. */
  toMajorUnits(): number {
    return this.cents / 100;
  }

  format(locale = 'en-US'): string {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: this.currency }).format(this.cents / 100);
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new TypeError(`Cannot combine ${this.currency} with ${other.currency}`);
    }
  }
}
