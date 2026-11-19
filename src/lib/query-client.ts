import { QueryClient } from '@tanstack/react-query';

import { toAppError } from '@/lib/to-app-error';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // Retry only failures that can clear up on their own.
        retry: (failureCount, error) => toAppError(error).retryable && failureCount < 2,
      },
      // Writes are never retried automatically. Checkout has its own idempotency.
      mutations: { retry: false },
    },
  });
}
