import { FlatList, StyleSheet, View } from 'react-native';

import { Badge, Button, Card, EmptyState, ErrorNotice, Loading, Muted, Screen, Title } from '@/components/ui';
import { Money } from '@/core/money';
import { can } from '@/core/roles';
import { useAuth } from '@/features/auth';
import { type OrderRow, useOrders, useRequestRefund } from '@/features/queries';
import { toAppError } from '@/lib/to-app-error';

const STATUS: Record<OrderRow['status'], { label: string; tone: 'neutral' | 'success' | 'danger' }> = {
  awaiting_payment: { label: 'Awaiting payment', tone: 'neutral' },
  paid: { label: 'Paid', tone: 'success' },
  failed: { label: 'Payment failed', tone: 'danger' },
  refund_requested: { label: 'Refund requested', tone: 'neutral' },
  refunded: { label: 'Refunded', tone: 'neutral' },
};

/**
 * One screen for every role. The query is the same; row-level security
 * returns a customer's own orders, the orders a merchant sells in, or every
 * order for an admin.
 */
export default function Orders() {
  const { role } = useAuth();
  const orders = useOrders();
  const refund = useRequestRefund();
  const canRefund = can(role, 'orders.refund');

  if (orders.isPending) return <Loading />;
  if (orders.isError) return <ErrorNotice error={toAppError(orders.error)} onRetry={() => orders.refetch()} />;

  return (
    <Screen>
      {refund.isError ? <ErrorNotice error={toAppError(refund.error)} /> : null}
      <FlatList
        contentContainerStyle={styles.list}
        data={orders.data}
        keyExtractor={(order) => order.id}
        ListEmptyComponent={<EmptyState body="Orders you place or sell in show up here." title="No orders yet" />}
        onRefresh={() => orders.refetch()}
        refreshing={orders.isRefetching}
        renderItem={({ item }) => (
          <Card>
            <View style={styles.row}>
              <Title>{Money.of(item.total_cents, item.currency).format()}</Title>
              <Badge label={STATUS[item.status].label} tone={STATUS[item.status].tone} />
            </View>
            <Muted>
              {new Date(item.created_at).toLocaleString()} · {item.provider === 'stripe' ? 'Card / wallet' : 'PayPal'}
            </Muted>
            {canRefund && item.status === 'paid' ? (
              <Button
                label="Request refund"
                loading={refund.isPending && refund.variables === item.id}
                onPress={() => refund.mutate(item.id)}
                variant="secondary"
              />
            ) : null}
          </Card>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: 12, paddingBottom: 24 },
  row: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
});
