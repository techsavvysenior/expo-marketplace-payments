import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Button, Card, EmptyState, ErrorNotice, Muted, Screen, Title } from '@/components/ui';
import { Cart } from '@/core/cart';
import { type AppError, PaymentCancelledError } from '@/core/errors';
import type { PaymentGateway, PaymentProvider } from '@/core/payments/types';
import { keys } from '@/features/queries';
import { useServices } from '@/features/services';
import { toAppError } from '@/lib/to-app-error';

export default function CartScreen() {
  const { cart, setCart, checkout } = useServices();
  const queryClient = useQueryClient();
  const [gateways, setGateways] = useState<PaymentGateway[]>([]);
  const [paying, setPaying] = useState<PaymentProvider | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  useEffect(() => {
    checkout.availableGateways(cart).then(setGateways);
  }, [cart, checkout]);

  async function pay(provider: PaymentProvider) {
    setPaying(provider);
    setError(null);
    try {
      const receipt = await checkout.checkout(cart, provider);
      setCart(() => Cart.empty());
      setConfirmation(
        receipt.result.status === 'succeeded'
          ? `Paid ${receipt.order.total.format()}. Your order will show as paid once the payment is confirmed.`
          : 'Payment is processing. We will update the order when it settles.',
      );
      queryClient.invalidateQueries({ queryKey: keys.orders });
    } catch (caught) {
      // Backing out of the sheet is not an error worth a red banner.
      if (!(caught instanceof PaymentCancelledError)) setError(toAppError(caught));
    } finally {
      setPaying(null);
    }
  }

  if (confirmation) {
    return (
      <Screen>
        <Card>
          <Title>Thank you</Title>
          <Muted>{confirmation}</Muted>
        </Card>
        <Button label="Keep shopping" onPress={() => setConfirmation(null)} variant="secondary" />
      </Screen>
    );
  }

  if (cart.isEmpty) return <EmptyState body="Add something from the Shop tab." title="Your cart is empty" />;

  const total = cart.estimatedTotal();

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        {cart.lines.map(({ product, quantity }) => (
          <Card key={product.id}>
            <View style={styles.row}>
              <Title>{product.title}</Title>
              <Title>{product.price.times(quantity).format()}</Title>
            </View>
            <View style={styles.row}>
              <Button label="-" onPress={() => setCart((c) => c.setQuantity(product, quantity - 1))} variant="secondary" />
              <Muted>Qty {quantity}</Muted>
              <Button label="+" onPress={() => setCart((c) => c.setQuantity(product, quantity + 1))} variant="secondary" />
            </View>
          </Card>
        ))}
        <Card>
          <View style={styles.row}>
            <Title>Total</Title>
            <Title>{total?.format()}</Title>
          </View>
          <Muted>The final amount is calculated by the server from current prices.</Muted>
        </Card>
        {error ? <ErrorNotice error={error} onRetry={() => setError(null)} /> : null}
        {gateways.map((gateway) => (
          <Button
            disabled={paying !== null}
            key={gateway.provider}
            label={`Pay with ${gateway.label}`}
            loading={paying === gateway.provider}
            onPress={() => pay(gateway.provider)}
            variant={gateway.provider === 'stripe' ? 'primary' : 'secondary'}
          />
        ))}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: 12, paddingBottom: 24 },
  row: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
});
