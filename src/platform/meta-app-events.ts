import { AppEventsLogger } from 'react-native-fbsdk-next';

import type { AnalyticsSink, CommerceEvent } from '@/core/analytics/events';

/**
 * Sends commerce events to Meta through the native SDK.
 *
 * Each event carries `event_id`. The server sends the same id through the
 * Conversions API, and Meta keeps one of the two.
 * https://developers.facebook.com/docs/marketing-api/conversions-api/app-events
 */
export class MetaAppEventsSink implements AnalyticsSink {
  readonly name = 'meta-app-events';

  track(event: CommerceEvent): void {
    const { AppEvents, AppEventParams } = AppEventsLogger;
    const params: Record<string, string | number> = { event_id: event.eventId };
    if (event.orderId) params[AppEventParams.OrderId] = event.orderId;
    if (event.contentIds?.length) params[AppEventParams.ContentID] = JSON.stringify(event.contentIds);
    if (event.numItems) params[AppEventParams.NumItems] = event.numItems;
    if (event.value) params[AppEventParams.Currency] = event.value.currency;

    const value = event.value?.toMajorUnits() ?? 0;
    switch (event.name) {
      case 'Purchase':
        AppEventsLogger.logPurchase(value, event.value?.currency ?? 'USD', params);
        return;
      case 'InitiateCheckout':
        AppEventsLogger.logEvent(AppEvents.InitiatedCheckout, value, params);
        return;
      case 'AddToCart':
        AppEventsLogger.logEvent(AppEvents.AddedToCart, value, params);
        return;
      case 'ViewContent':
        AppEventsLogger.logEvent(AppEvents.ViewedContent, params);
        return;
      case 'Subscribe':
        AppEventsLogger.logEvent(AppEvents.Subscribe, value, params);
        return;
    }
  }
}

/** Development-only sink, so events are visible in the Metro log. */
export class ConsoleSink implements AnalyticsSink {
  readonly name = 'console';
  track(event: CommerceEvent): void {
    console.log(`[analytics] ${event.name} ${event.eventId}`, event.value?.format() ?? '');
  }
}
