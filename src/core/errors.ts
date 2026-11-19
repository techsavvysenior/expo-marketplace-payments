/**
 * Every failure the app shows to a person maps to one of these. The UI
 * switches on `code`, so a new failure can't slip through as a raw error.
 */
export abstract class AppError extends Error {
  abstract readonly code: string;
  /** Whether trying the same thing again could work. */
  abstract readonly retryable: boolean;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The person backed out of the payment sheet or the PayPal page. Not an error to show. */
export class PaymentCancelledError extends AppError {
  readonly code = 'payment_cancelled';
  readonly retryable = true;
  constructor() {
    super('Payment was cancelled.');
  }
}

export class PaymentDeclinedError extends AppError {
  readonly code = 'payment_declined';
  readonly retryable = true;
  constructor(readonly providerMessage?: string) {
    super(providerMessage ?? 'The payment was declined.');
  }
}

/** The provider or our backend could not be reached. */
export class ProviderUnavailableError extends AppError {
  readonly code = 'provider_unavailable';
  readonly retryable = true;
  constructor(readonly provider: string, options?: { cause?: unknown }) {
    super(`${provider} is not reachable right now.`, options);
  }
}

/** A business rule refused the request, e.g. DIGITAL_GOODS_REQUIRE_IN_APP_PURCHASE. */
export class RuleViolationError extends AppError {
  readonly code = 'rule_violation';
  readonly retryable = false;
  constructor(readonly rule: string) {
    super(rule);
  }
}

export class ForbiddenError extends AppError {
  readonly code = 'forbidden';
  readonly retryable = false;
  constructor(action: string) {
    super(`Your role is not allowed to ${action}.`);
  }
}

/** A webhook or redirect that fails verification. Never retried. */
export class SignatureError extends AppError {
  readonly code = 'invalid_signature';
  readonly retryable = false;
}

/** Rule names raised by the SQL functions, matched from Postgres error messages. */
const DATABASE_RULES = [
  'EMPTY_CART',
  'PRODUCT_UNAVAILABLE',
  'DIGITAL_GOODS_REQUIRE_IN_APP_PURCHASE',
  'INVALID_QUANTITY',
  'MIXED_CURRENCIES',
  'CANNOT_BUY_OWN_PRODUCT',
  'ORDER_NOT_REFUNDABLE',
  'CANNOT_CHANGE_OWN_ROLE',
] as const;

export type DatabaseRule = (typeof DATABASE_RULES)[number];

export function ruleFromDatabaseMessage(message: string | undefined): DatabaseRule | undefined {
  return DATABASE_RULES.find((rule) => message?.includes(rule));
}

export function describeError(error: AppError): string {
  if (error instanceof RuleViolationError) {
    switch (error.rule as DatabaseRule) {
      case 'EMPTY_CART':
        return 'Your cart is empty.';
      case 'PRODUCT_UNAVAILABLE':
        return 'Something in your cart is no longer available.';
      case 'DIGITAL_GOODS_REQUIRE_IN_APP_PURCHASE':
        return 'Digital items are bought through the App Store or Google Play.';
      case 'INVALID_QUANTITY':
        return 'Choose a quantity between 1 and 99.';
      case 'MIXED_CURRENCIES':
        return 'Items priced in different currencies need separate orders.';
      case 'CANNOT_BUY_OWN_PRODUCT':
        return "You can't buy your own product.";
      case 'ORDER_NOT_REFUNDABLE':
        return 'Only paid orders can be refunded.';
      case 'CANNOT_CHANGE_OWN_ROLE':
        return 'Ask another admin to change your role.';
    }
  }
  return error.message;
}
