import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { Badge, Button, Card, ErrorNotice, Loading, Muted, Screen, Title } from '@/components/ui';
import { type AppError, PaymentCancelledError } from '@/core/errors';
import { keys, useEntitlements } from '@/features/queries';
import { useServices } from '@/features/services';
import { PREMIUM_ENTITLEMENT, SubscriptionService } from '@/platform/subscriptions';
import { toAppError } from '@/lib/to-app-error';

/**
 * Subscriptions through App Store and Google Play billing.
 *
 * Two sources of truth, on purpose: the device's CustomerInfo unlocks the
 * feature immediately after purchase, and the server's entitlements table
 * (written by the RevenueCat webhook) lets the backend gate premium data.
 */
export default function Premium() {
  const { subscriptions } = useServices();
  const queryClient = useQueryClient();
  const entitlements = useEntitlements();
  const packages = useQuery({ queryKey: ['packages'], queryFn: () => subscriptions.packages() });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  if (!SubscriptionService.apiKey()) {
    return (
      <Screen>
        <Card>
          <Title>Subscriptions are not configured</Title>
          <Muted>Add your RevenueCat public SDK keys to .env to load App Store and Google Play products.</Muted>
        </Card>
      </Screen>
    );
  }

  const premium = entitlements.data?.some((e) => e.entitlement === PREMIUM_ENTITLEMENT) ?? false;

  async function run(id: string, work: () => Promise<unknown>) {
    setBusy(id);
    setError(null);
    try {
      await work();
      await queryClient.invalidateQueries({ queryKey: keys.entitlements });
    } catch (caught) {
      if (!(caught instanceof PaymentCancelledError)) setError(toAppError(caught));
    } finally {
      setBusy(null);
    }
  }

  if (packages.isPending || entitlements.isPending) return <Loading />;

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Card>
          <Title>Premium</Title>
          <Badge label={premium ? 'Active' : 'Not subscribed'} tone={premium ? 'success' : 'neutral'} />
          <Muted>Lower marketplace fees and early access to drops.</Muted>
        </Card>
        {error ? <ErrorNotice error={error} /> : null}
        {packages.isError ? <ErrorNotice error={toAppError(packages.error)} onRetry={() => packages.refetch()} /> : null}
        {(packages.data ?? []).map((pkg) => (
          <Button
            disabled={busy !== null || premium}
            key={pkg.identifier}
            label={`${pkg.product.title} · ${pkg.product.priceString}`}
            loading={busy === pkg.identifier}
            onPress={() => run(pkg.identifier, () => subscriptions.purchase(pkg))}
          />
        ))}
        <Button
          label="Restore purchases"
          loading={busy === 'restore'}
          onPress={() => run('restore', () => subscriptions.restore())}
          variant="secondary"
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({ content: { gap: 12, paddingBottom: 24 } });
