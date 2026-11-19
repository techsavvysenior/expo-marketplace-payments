import { Money } from '../money.ts';

describe('Money', () => {
  it('adds and multiplies in whole cents', () => {
    const mug = Money.of(1250, 'USD');
    expect(mug.times(3).plus(Money.of(5, 'USD')).cents).toBe(3755);
  });

  it('refuses fractional cents and lower-case currencies', () => {
    expect(() => Money.of(12.5, 'USD')).toThrow(RangeError);
    expect(() => Money.of(-1, 'USD')).toThrow(RangeError);
    expect(() => Money.of(100, 'usd')).toThrow(RangeError);
  });

  it('refuses to mix currencies', () => {
    expect(() => Money.of(100, 'USD').plus(Money.of(100, 'EUR'))).toThrow(TypeError);
  });

  it('takes a percentage rounded down, the same as the database fee', () => {
    expect(Money.of(1999, 'USD').percent(10).cents).toBe(199);
  });

  it('formats for PayPal and for display', () => {
    expect(Money.of(1205, 'USD').toDecimalString()).toBe('12.05');
    expect(Money.of(7, 'USD').toDecimalString()).toBe('0.07');
    expect(Money.of(123456, 'USD').format('en-US')).toBe('$1,234.56');
  });
});
