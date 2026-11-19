import { FunctionsHttpError } from '@supabase/supabase-js';

import { PaymentDeclinedError, ProviderUnavailableError, RuleViolationError, ruleFromDatabaseMessage } from '@/core/errors';
import { supabase } from '@/lib/supabase';

/**
 * Calls an Edge Function with the signed-in user's token and turns its JSON
 * error codes into typed errors.
 */
export async function invokeFunction<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(name, { body });
  if (!error) return data as T;

  if (error instanceof FunctionsHttpError) {
    const payload = (await error.context.json().catch(() => ({}))) as { error?: string };
    const code = payload.error ?? '';
    if (code === 'payment_declined') throw new PaymentDeclinedError();
    const rule = ruleFromDatabaseMessage(code);
    if (rule) throw new RuleViolationError(rule);
    throw new ProviderUnavailableError(name, { cause: new Error(code || error.message) });
  }
  throw new ProviderUnavailableError(name, { cause: error });
}
