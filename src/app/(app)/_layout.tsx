import { Tabs } from 'expo-router';

import { colors } from '@/components/ui';
import { can } from '@/core/roles';
import { useAuth } from '@/features/auth';
import { useServices } from '@/features/services';

/**
 * Tabs follow the role in the token. Hiding a tab is a convenience only:
 * a customer who reached the merchant screen would still be refused by
 * row-level security on every read and write.
 */
export default function AppLayout() {
  const { role } = useAuth();
  const { cart } = useServices();
  const isMerchant = can(role, 'products.manage_own');
  const isAdmin = can(role, 'roles.assign');

  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: colors.primary }}>
      <Tabs.Screen name="index" options={{ title: 'Shop' }} />
      <Tabs.Screen name="cart" options={{ title: 'Cart', tabBarBadge: cart.itemCount || undefined }} />
      <Tabs.Screen name="orders" options={{ title: isAdmin ? 'All orders' : 'Orders' }} />
      <Tabs.Screen name="premium" options={{ title: 'Premium' }} />
      <Tabs.Screen name="merchant" options={{ title: 'Sell', href: isMerchant ? undefined : null }} />
      <Tabs.Screen name="admin" options={{ title: 'Admin', href: isAdmin ? undefined : null }} />
    </Tabs>
  );
}
