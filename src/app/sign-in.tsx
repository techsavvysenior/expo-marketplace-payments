import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button, colors, ErrorNotice } from '@/components/ui';
import type { AppError } from '@/core/errors';
import { useAuth } from '@/features/auth';
import { toAppError } from '@/lib/to-app-error';

export default function SignIn() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'sign-in') await signIn(email.trim(), password);
      else await signUp(email.trim(), password, name.trim());
    } catch (caught) {
      setError(toAppError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.screen}>
      <View style={styles.form}>
        <Text accessibilityRole="header" style={styles.heading}>
          Marketplace
        </Text>
        <Text style={styles.subheading}>New accounts start as customers. An admin can make you a merchant.</Text>
        {mode === 'sign-up' ? (
          <TextInput accessibilityLabel="Display name" onChangeText={setName} placeholder="Display name" style={styles.input} value={name} />
        ) : null}
        <TextInput
          accessibilityLabel="Email"
          autoCapitalize="none"
          autoComplete="email"
          inputMode="email"
          onChangeText={setEmail}
          placeholder="Email"
          style={styles.input}
          value={email}
        />
        <TextInput
          accessibilityLabel="Password"
          autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
          onChangeText={setPassword}
          placeholder="Password"
          secureTextEntry
          style={styles.input}
          value={password}
        />
        {error ? <ErrorNotice error={error} /> : null}
        <Button label={mode === 'sign-in' ? 'Sign in' : 'Create account'} loading={busy} onPress={submit} />
        <Button
          label={mode === 'sign-in' ? 'New here? Create an account' : 'Have an account? Sign in'}
          onPress={() => setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')}
          variant="secondary"
        />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1, justifyContent: 'center' },
  form: { gap: 12, padding: 24 },
  heading: { color: colors.text, fontSize: 28, fontWeight: '700' },
  subheading: { color: colors.muted, fontSize: 15, marginBottom: 8 },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    fontSize: 16,
    minHeight: 44,
    paddingHorizontal: 12,
  },
});
