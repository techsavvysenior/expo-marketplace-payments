/**
 * The client-side copy of the role model in supabase/migrations/*_roles.sql.
 *
 * The database is the authority: every permission here is also enforced by
 * row-level security or a security-definer function. The app uses this copy
 * only to decide which screens and buttons to show. A unit test parses the
 * migration and fails if the two drift apart.
 */
export const ROLES = ['customer', 'merchant', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'products.manage_own',
  'products.manage_all',
  'orders.read_all',
  'orders.refund',
  'roles.assign',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  customer: [],
  merchant: ['products.manage_own'],
  admin: ['products.manage_own', 'products.manage_all', 'orders.read_all', 'orders.refund', 'roles.assign'],
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Reads the `user_role` claim the Custom Access Token Hook adds. Only for
 * choosing UI: the token is not verified here, the database verifies it.
 */
export function roleFromAccessToken(accessToken: string | undefined | null): Role {
  if (!accessToken) return 'customer';
  const payload = accessToken.split('.')[1];
  if (!payload) return 'customer';
  try {
    const claims = JSON.parse(decodeBase64Url(payload)) as { user_role?: unknown };
    return isRole(claims.user_role) ? claims.user_role : 'customer';
  } catch {
    return 'customer';
  }
}

function decodeBase64Url(input: string): string {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
