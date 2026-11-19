import { useState } from 'react';
import { FlatList, StyleSheet, TextInput, View } from 'react-native';

import { Badge, Button, Card, colors, ErrorNotice, Loading, Muted, Screen, Title } from '@/components/ui';
import { Money } from '@/core/money';
import { useAuth } from '@/features/auth';
import { useAddProduct, useMyProducts, useSalesSummary, useSetProductActive } from '@/features/queries';
import { toAppError } from '@/lib/to-app-error';

export default function Merchant() {
  const { session } = useAuth();
  const userId = session!.user.id;
  const products = useMyProducts(userId);
  const sales = useSalesSummary();
  const addProduct = useAddProduct(userId);
  const setActive = useSetProductActive(userId);
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');

  const priceCents = Math.round(Number(price) * 100);
  const valid = title.trim().length > 0 && Number.isFinite(priceCents) && priceCents >= 50;

  if (products.isPending) return <Loading />;

  return (
    <Screen>
      <FlatList
        contentContainerStyle={styles.list}
        data={products.data}
        keyExtractor={(product) => product.id}
        ListHeaderComponent={
          <View style={styles.list}>
            <Card>
              <Title>Sales</Title>
              {(sales.data ?? []).length === 0 ? (
                <Muted>No paid orders yet.</Muted>
              ) : (
                sales.data!.map((row) => (
                  <Muted key={row.currency}>
                    {row.paid_orders} paid orders · gross {Money.of(row.gross_cents, row.currency).format()} · your payout{' '}
                    {Money.of(row.payout_cents, row.currency).format()} after the 10% platform fee
                  </Muted>
                ))
              )}
            </Card>
            <Card>
              <Title>New product</Title>
              <TextInput accessibilityLabel="Product title" onChangeText={setTitle} placeholder="Title" style={styles.input} value={title} />
              <TextInput
                accessibilityLabel="Price in dollars"
                inputMode="decimal"
                onChangeText={setPrice}
                placeholder="Price, e.g. 12.50"
                style={styles.input}
                value={price}
              />
              {addProduct.isError ? <ErrorNotice error={toAppError(addProduct.error)} /> : null}
              <Button
                disabled={!valid}
                label="List product"
                loading={addProduct.isPending}
                onPress={() =>
                  addProduct.mutate(
                    { title: title.trim(), priceCents, kind: 'physical' },
                    {
                      onSuccess: () => {
                        setTitle('');
                        setPrice('');
                      },
                    },
                  )
                }
              />
            </Card>
          </View>
        }
        renderItem={({ item }) => (
          <Card>
            <View style={styles.row}>
              <Title>{item.title}</Title>
              <Title>{item.price.format()}</Title>
            </View>
            <Badge label={item.active ? 'Listed' : 'Hidden'} tone={item.active ? 'success' : 'neutral'} />
            <Button
              label={item.active ? 'Hide from shop' : 'List again'}
              loading={setActive.isPending && setActive.variables?.id === item.id}
              onPress={() => setActive.mutate({ id: item.id, active: !item.active })}
              variant="secondary"
            />
          </Card>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: 12, paddingBottom: 12 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  input: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    fontSize: 16,
    minHeight: 44,
    paddingHorizontal: 12,
  },
});
