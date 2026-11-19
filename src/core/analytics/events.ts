import type { Money } from '../money.ts';
import type { Attribution } from '../payments/types.ts';

export type CommerceEventName = 'ViewContent' | 'AddToCart' | 'InitiateCheckout' | 'Purchase' | 'Subscribe';

export type CommerceEvent = {
  name: CommerceEventName;
  /**
   * Shared with the server. Meta drops the second of two events that have
   * the same event_name and event_id, so the SDK event from the phone and the
   * Conversions API event from the webhook are counted once.
   */
  eventId: string;
  value?: Money;
  contentIds?: string[];
  numItems?: number;
  orderId?: string;
};

/** The one place event IDs are built, used by both the app and the Edge Functions. */
export const eventIds = {
  purchase: (orderId: string) => `purchase_${orderId}`,
  initiateCheckout: (orderId: string) => `checkout_${orderId}`,
  subscribe: (transactionId: string) => `subscribe_${transactionId}`,
};

/** A destination for events: Meta App Events on device, a console logger in development, a fake in tests. */
export interface AnalyticsSink {
  readonly name: string;
  track(event: CommerceEvent): void | Promise<void>;
}

export interface ConsentProvider {
  /** Runs the platform prompt if it hasn't been shown yet (iOS ATT), then returns the result. */
  attribution(): Promise<Attribution>;
}

/**
 * Fans events out to every sink. Analytics must never break checkout, so a
 * sink that throws is reported and skipped.
 */
export class Analytics {
  constructor(
    private readonly sinks: AnalyticsSink[],
    private readonly onSinkError: (sink: string, error: unknown) => void = () => {},
  ) {}

  async track(event: CommerceEvent): Promise<void> {
    await Promise.all(
      this.sinks.map(async (sink) => {
        try {
          await sink.track(event);
        } catch (error) {
          this.onSinkError(sink.name, error);
        }
      }),
    );
  }
}
