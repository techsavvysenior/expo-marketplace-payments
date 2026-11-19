import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { can, PERMISSIONS, ROLE_PERMISSIONS, ROLES, roleFromAccessToken } from '../roles.ts';

const migrations = join(__dirname, '..', '..', '..', 'supabase', 'migrations');
const rolesSql = readFileSync(join(migrations, readdirSync(migrations).find((file) => file.endsWith('_roles.sql'))!), 'utf8');

function enumValues(typeName: string): string[] {
  const match = new RegExp(`create type public\\.${typeName} as enum \\(([^)]*)\\)`).exec(rolesSql);
  return [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function sqlRolePermissions(): Record<string, string[]> {
  const block = /insert into public\.role_permissions \(role, permission\) values([\s\S]*?);/.exec(rolesSql)![1];
  const result: Record<string, string[]> = {};
  for (const [, role, permission] of block.matchAll(/\('([^']+)', '([^']+)'\)/g)) {
    (result[role] ??= []).push(permission);
  }
  return result;
}

const token = (claims: object) =>
  ['header', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'signature'].join('.');

describe('role model', () => {
  it('matches the roles and permissions defined in SQL', () => {
    expect([...ROLES]).toEqual(enumValues('app_role'));
    expect([...PERMISSIONS]).toEqual(enumValues('app_permission'));
  });

  it('grants each role exactly what the SQL grants', () => {
    const sql = sqlRolePermissions();
    for (const role of ROLES) {
      expect([...ROLE_PERMISSIONS[role]].sort()).toEqual((sql[role] ?? []).sort());
    }
  });

  it('answers permission checks', () => {
    expect(can('merchant', 'products.manage_own')).toBe(true);
    expect(can('merchant', 'orders.refund')).toBe(false);
    expect(can('admin', 'roles.assign')).toBe(true);
  });
});

describe('roleFromAccessToken', () => {
  it('reads the user_role claim', () => {
    expect(roleFromAccessToken(token({ sub: 'u1', user_role: 'merchant' }))).toBe('merchant');
  });

  it('falls back to customer for a missing, unknown or unreadable claim', () => {
    expect(roleFromAccessToken(undefined)).toBe('customer');
    expect(roleFromAccessToken(token({ sub: 'u1' }))).toBe('customer');
    expect(roleFromAccessToken(token({ user_role: 'superuser' }))).toBe('customer');
    expect(roleFromAccessToken('not-a-jwt')).toBe('customer');
  });
});
