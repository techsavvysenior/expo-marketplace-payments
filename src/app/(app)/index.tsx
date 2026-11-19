import { FlatList, StyleSheet, View } from 'react-native';

import { Badge, Button, Card, EmptyState, ErrorNotice, Loading, Muted, Screen, Title } from '@/components/ui';
import type { Product } from '@/core/cart';
import { useAuth } from '@/features/auth';
import { useCatalog } from '@/features/queries';
import { useServices } from '@/features/services';
import { toAppError } from '@/lib/to-app-error';

/** Add-to-cart has no server twin, so the id only needs to be unique. */
const addToCartEventId = (productId: string) => `add_to_cart_${productId}_${Date.now()}`;

export default function Shop() {
  const catalog = useCatalog();
  const { cart, setCart, analytics } = useServices();
  const { session } = useAuth();

  if (catalog.isPending) return <Loading />;
  if (catalog.isError) return <ErrorNotice error={toAppError(catalog.error)} onRetry={() => catalog.refetch()} />;

  function addToCart(product: Product) {
    setCart((current) => current.add(product));
    analytics.track({
      name: 'AddToCart',
      eventId: addToCartEventId(product.id),
      value: product.price,
      contentIds: [product.id],
      numItems: 1,
    });
  }

  return (
    <Screen>
      <FlatList
        contentContainerStyle={styles.list}
        data={catalog.data}
        keyExtractor={(product) => product.id}
        ListEmptyComponent={<EmptyState body="Merchants haven't listed anything yet." title="Nothing for sale" />}
        onRefresh={() => catalog.refetch()}
        refreshing={catalog.isRefetching}
        renderItem={({ item }) => {
          const own = item.merchantId === session?.user.id;
          const inCart = cart.lines.find((line) => line.product.id === item.id)?.quantity ?? 0;
          return (
            <Card>
              <View style={styles.row}>
                <Title>{item.title}</Title>
                <Title>{item.price.format()}</Title>
              </View>
              {item.kind === 'digital' ? (
                <>
                  <Badge label="Digital" />
                  <Muted>Digital items are sold through the App Store or Google Play. See the Premium tab.</Muted>
                </>
              ) : own ? (
                <Muted>Your listing</Muted>
              ) : (
                <Button
                  label={inCart ? `Add another (${inCart} in cart)` : 'Add to cart'}
                  onPress={() => addToCart(item)}
                  variant={inCart ? 'secondary' : 'primary'}
                />
              )}
            </Card>
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: 12, paddingBottom: 24 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
});
