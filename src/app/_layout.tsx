import { StripeProvider } from '@stripe/stripe-react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Settings } from 'react-native-fbsdk-next';

import { Loading } from '@/components/ui';
import { AuthProvider, useAuth } from '@/features/auth';
import { APP_SCHEME, ServicesProvider, useServices } from '@/features/services';
import { createQueryClient } from '@/lib/query-client';

export default function RootLayout() {
  const [queryClient] = useState(createQueryClient);

  useEffect(() => {
    // Auto-init is off in app.json so nothing is sent before this point.
    Settings.initializeSDK();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <StripeProvider
        publishableKey={process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? ''}
        merchantIdentifier={process.env.EXPO_PUBLIC_APPLE_MERCHANT_ID}
        urlScheme={APP_SCHEME}>
        <AuthProvider>
          <ServicesProvider>
            <StatusBar style="dark" />
            <Navigator />
          </ServicesProvider>
        </AuthProvider>
      </StripeProvider>
    </QueryClientProvider>
  );
}

function Navigator() {
  const { session } = useAuth();
  const { subscriptions } = useServices();

  // Ties RevenueCat purchases to the Supabase user id.
  useEffect(() => {
    if (session) subscriptions.signIn(session.user.id).catch(console.warn);
    else subscriptions.signOut().catch(console.warn);
  }, [session, subscriptions]);

  if (session === undefined) return <Loading />;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={session !== null}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
      <Stack.Protected guard={session === null}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
    </Stack>
  );
}
