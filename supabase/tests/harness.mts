import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite, type Transaction } from '@electric-sql/pglite';

/**
 * Real Postgres, in process, so policies and functions are tested as SQL.
 *
 * This recreates the parts of a Supabase project the migrations depend on:
 * the API roles, the `auth` schema, `auth.uid()` and `auth.jwt()` reading the
 * request claims, and Supabase's broad default grants (which the migrations
 * then narrow).
 */
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create role supabase_auth_admin nologin;

  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    raw_user_meta_data jsonb not null default '{}'
  );
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
  $$;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(auth.jwt() ->> 'sub', '')::uuid
  $$;

  grant usage on schema auth to anon, authenticated, service_role, supabase_auth_admin;
  grant select on auth.users to service_role;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

export async function createDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  return db;
}

export type AppRole = 'customer' | 'merchant' | 'admin';

/** Signs a user up the way Supabase Auth would, optionally with a role. */
export async function signUp(db: PGlite, email: string, role: AppRole = 'customer'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    'insert into auth.users (email) values ($1) returning id',
    [email],
  );
  const id = rows[0].id;
  if (role !== 'customer') {
    await db.query('update public.user_roles set role = $1 where user_id = $2', [role, id]);
  }
  return id;
}

/**
 * Issues claims the way Supabase Auth does: runs the Custom Access Token Hook
 * as `supabase_auth_admin` on a base token.
 */
export async function issueClaims(db: PGlite, userId: string): Promise<Record<string, unknown>> {
  return db.transaction(async (tx) => {
    await tx.exec('set local role supabase_auth_admin');
    const event = { user_id: userId, claims: { sub: userId, role: 'authenticated', aud: 'authenticated' } };
    const { rows } = await tx.query<{ result: { claims: Record<string, unknown> } }>(
      'select public.custom_access_token_hook($1::jsonb) as result',
      [JSON.stringify(event)],
    );
    return rows[0].result.claims;
  }) as Promise<Record<string, unknown>>;
}

/** Runs `work` as a signed-in user reaching the database through the API. */
export async function asUser<T>(db: PGlite, userId: string, work: (tx: Transaction) => Promise<T>): Promise<T> {
  const claims = await issueClaims(db, userId);
  return db.transaction(async (tx) => {
    await tx.exec('set local role authenticated');
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    return work(tx);
  }) as Promise<T>;
}

/** Runs `work` as an Edge Function using the service role key. */
export function asService<T>(db: PGlite, work: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec('set local role service_role');
    return work(tx);
  }) as Promise<T>;
}

export function asAnonymous<T>(db: PGlite, work: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec('set local role anon');
    return work(tx);
  }) as Promise<T>;
}
