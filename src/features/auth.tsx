import type { Session } from '@supabase/supabase-js';
import { createContext, use, useEffect, useMemo, useState, type ReactNode } from 'react';

import { type Role, roleFromAccessToken } from '@/core/roles';
import { supabase } from '@/lib/supabase';
import { toAppError } from '@/lib/to-app-error';

type AuthState = {
  /** `undefined` while the stored session is still being read. */
  session: Session | null | undefined;
  /** From the token's user_role claim. Drives which tabs are shown; the database enforces it. */
  role: Role;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string, displayName: string): Promise<void>;
  signOut(): Promise<void>;
  /** Gets a fresh token after an admin changes this user's role. */
  refreshRole(): Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (active) setSession(data.session);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      session,
      role: roleFromAccessToken(session?.access_token),
      async signIn(email, password) {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw toAppError(error);
      },
      async signUp(email, password, displayName) {
        const { error } = await supabase.auth.signUp({ email, password, options: { data: { display_name: displayName } } });
        if (error) throw toAppError(error);
      },
      async signOut() {
        const { error } = await supabase.auth.signOut();
        if (error) throw toAppError(error);
      },
      async refreshRole() {
        const { error } = await supabase.auth.refreshSession();
        if (error) throw toAppError(error);
      },
    }),
    [session],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthState {
  const value = use(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider.');
  return value;
}
