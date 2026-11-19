import {
  AppError,
  ForbiddenError,
  ProviderUnavailableError,
  RuleViolationError,
  ruleFromDatabaseMessage,
} from '@/core/errors';

/** Anything Supabase or fetch can throw, turned into one of the app's error types. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  const message = typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error);
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;

  const rule = ruleFromDatabaseMessage(message);
  if (rule) return new RuleViolationError(rule);
  if (code === '42501' || /FORBIDDEN|permission denied|row-level security/i.test(message)) {
    return new ForbiddenError('do that');
  }
  if (/network request failed|failed to fetch|timeout/i.test(message)) {
    return new ProviderUnavailableError('The server', { cause: error });
  }
  return new UnexpectedError(message, { cause: error });
}

export class UnexpectedError extends AppError {
  readonly code = 'unexpected';
  readonly retryable = false;
}
