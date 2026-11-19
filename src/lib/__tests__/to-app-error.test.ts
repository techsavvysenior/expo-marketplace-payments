import { ForbiddenError, PaymentDeclinedError, ProviderUnavailableError, RuleViolationError } from '@/core/errors';
import { toAppError, UnexpectedError } from '@/lib/to-app-error';

describe('toAppError', () => {
  it('keeps errors that are already typed', () => {
    const declined = new PaymentDeclinedError('Insufficient funds');
    expect(toAppError(declined)).toBe(declined);
  });

  it('recognises rule names raised by the database', () => {
    const error = toAppError({ code: 'P0001', message: 'DIGITAL_GOODS_REQUIRE_IN_APP_PURCHASE' });
    expect(error).toBeInstanceOf(RuleViolationError);
    expect((error as RuleViolationError).rule).toBe('DIGITAL_GOODS_REQUIRE_IN_APP_PURCHASE');
  });

  it('treats permission failures as forbidden', () => {
    expect(toAppError({ code: '42501', message: 'permission denied for function record_payment' })).toBeInstanceOf(ForbiddenError);
    expect(toAppError({ message: 'new row violates row-level security policy for table "products"' })).toBeInstanceOf(ForbiddenError);
  });

  it('marks network failures as retryable', () => {
    const error = toAppError(new TypeError('Network request failed'));
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error.retryable).toBe(true);
  });

  it('falls back to an unexpected error', () => {
    expect(toAppError('boom')).toBeInstanceOf(UnexpectedError);
  });
});
