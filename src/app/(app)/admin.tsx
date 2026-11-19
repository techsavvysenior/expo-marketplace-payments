import { FlatList, StyleSheet, View } from 'react-native';

import { Badge, Button, Card, ErrorNotice, Loading, Muted, Screen, Title } from '@/components/ui';
import { ROLES } from '@/core/roles';
import { useAuth } from '@/features/auth';
import { useAssignRole, useUsers } from '@/features/queries';
import { toAppError } from '@/lib/to-app-error';

/**
 * Role management. assign_role() checks the roles.assign permission in the
 * database and writes an audit row. The changed user sees their new tabs
 * after their next token refresh.
 */
export default function Admin() {
  const { session } = useAuth();
  const users = useUsers();
  const assign = useAssignRole();

  if (users.isPending) return <Loading />;
  if (users.isError) return <ErrorNotice error={toAppError(users.error)} onRetry={() => users.refetch()} />;

  return (
    <Screen>
      {assign.isError ? <ErrorNotice error={toAppError(assign.error)} /> : null}
      <FlatList
        contentContainerStyle={styles.list}
        data={users.data}
        keyExtractor={(user) => user.user_id}
        renderItem={({ item }) => (
          <Card>
            <View style={styles.row}>
              <Title>{item.display_name}</Title>
              <Badge label={item.role} tone={item.role === 'admin' ? 'success' : 'neutral'} />
            </View>
            {item.user_id === session?.user.id ? (
              <Muted>This is you. Another admin can change your role.</Muted>
            ) : (
              <View style={styles.row}>
                {ROLES.filter((role) => role !== item.role).map((role) => (
                  <Button
                    key={role}
                    label={`Make ${role}`}
                    loading={assign.isPending && assign.variables?.userId === item.user_id && assign.variables.role === role}
                    onPress={() => assign.mutate({ userId: item.user_id, role })}
                    style={styles.flex}
                    variant="secondary"
                  />
                ))}
              </View>
            )}
          </Card>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: 12, paddingBottom: 24 },
  row: { alignItems: 'center', flexDirection: 'row', gap: 8, justifyContent: 'space-between' },
  flex: { flex: 1 },
});
