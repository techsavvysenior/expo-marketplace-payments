import { useStripe } from '@stripe/stripe-react-native';
import * as Crypto from 'expo-crypto';
import { createContext, use, useMemo, useState, type ReactNode } from 'react';

import { Analytics, type AnalyticsSink } from '@/core/analytics/events';
import { Cart } from '@/core/cart';
import { CheckoutService } from '@/core/payments/checkout-service';
import { DeviceConsentProvider } from '@/platform/device-consent';
import { ConsoleSink, MetaAppEventsSink } from '@/platform/meta-app-events';
import { supabaseOrdersApi } from '@/platform/orders-api';
import { PayPalGateway } from '@/platform/paypal-gateway';
import { StripeGateway } from '@/platform/stripe-gateway';
import { SubscriptionService } from '@/platform/subscriptions';

export const APP_SCHEME = 'marketplace';

type Services = {
  analytics: Analytics;
  checkout: CheckoutService;
  subscriptions: SubscriptionService;
  cart: Cart;
  setCart(update: (cart: Cart) => Cart): void;
};

const ServicesContext = createContext<Services | null>(null);

/**
 * Composition root: the one place concrete adapters are chosen. Everything
 * below it depends on the interfaces in src/core, which is what the unit
 * tests exercise with fakes.
 */
export function ServicesProvider({ children }: { children: ReactNode }) {
  const stripe = useStripe();
  const [cart, setCartState] = useState(Cart.empty);

  const services = useMemo(() => {
    const sinks: AnalyticsSink[] = [new MetaAppEventsSink()];
    if (__DEV__) sinks.push(new ConsoleSink());
    const analytics = new Analytics(sinks, (sink, error) => console.warn(`Analytics sink ${sink} failed`, error));

    const checkout = new CheckoutService({
      orders: supabaseOrdersApi,
      gateways: [
        new StripeGateway(stripe, {
          merchantDisplayName: 'Marketplace',
          merchantCountryCode: 'US',
          returnURL: `${APP_SCHEME}://stripe-redirect`,
          testEnv: __DEV__,
        }),
        new PayPalGateway(APP_SCHEME),
      ],
      analytics,
      consent: new DeviceConsentProvider(),
      newIdempotencyKey: () => Crypto.randomUUID(),
    });

    return { analytics, checkout, subscriptions: new SubscriptionService(analytics) };
  }, [stripe]);

  const value = useMemo<Services>(
    () => ({ ...services, cart, setCart: (update) => setCartState((current) => update(current)) }),
    [services, cart],
  );

  return <ServicesContext value={value}>{children}</ServicesContext>;
}

export function useServices(): Services {
  const value = use(ServicesContext);
  if (!value) throw new Error('useServices must be used inside ServicesProvider.');
  return value;
}
