import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { PGlite } from '@electric-sql/pglite';

import { asAnonymous, asUser, createDatabase, issueClaims, signUp } from './harness.mts';

const PERMISSION_DENIED = /permission denied/;

let db: PGlite;
let customer: string;
let merchant: string;
let admin: string;

beforeEach(async () => {
  db = await createDatabase();
  customer = await signUp(db, 'cara@example.com');
  merchant = await signUp(db, 'mo@example.com', 'merchant');
  admin = await signUp(db, 'ada@example.com', 'admin');
});

afterEach(async () => {
  await db.close();
});

const can = (userId: string, permission: string) =>
  asUser(db, userId, async (tx) => {
    const { rows } = await tx.query<{ ok: boolean }>('select public.authorize($1) as ok', [permission]);
    return rows[0].ok;
  });

describe('access token hook', () => {
  it('puts the role in the token', async () => {
    assert.equal((await issueClaims(db, merchant)).user_role, 'merchant');
    assert.equal((await issueClaims(db, admin)).user_role, 'admin');
  });

  it('gives a new sign-up the customer role', async () => {
    assert.equal((await issueClaims(db, customer)).user_role, 'customer');
  });

  it('keeps the claims Supabase Auth already set', async () => {
    const claims = await issueClaims(db, customer);
    assert.equal(claims.sub, customer);
    assert.equal(claims.role, 'authenticated');
  });

  it('cannot be called by a signed-in user', async () => {
    await assert.rejects(
      asUser(db, customer, (tx) => tx.query("select public.custom_access_token_hook('{}'::jsonb)")),
      PERMISSION_DENIED,
    );
  });
});

describe('permissions', () => {
  it('gives customers no elevated permissions', async () => {
    for (const permission of ['products.manage_own', 'orders.read_all', 'orders.refund', 'roles.assign']) {
      assert.equal(await can(customer, permission), false, permission);
    }
  });

  it('lets merchants manage only their own products', async () => {
    assert.equal(await can(merchant, 'products.manage_own'), true);
    assert.equal(await can(merchant, 'products.manage_all'), false);
    assert.equal(await can(merchant, 'orders.refund'), false);
  });

  it('gives admins every permission', async () => {
    for (const permission of ['products.manage_all', 'orders.read_all', 'orders.refund', 'roles.assign']) {
      assert.equal(await can(admin, permission), true, permission);
    }
  });
});

describe('role table', () => {
  it('shows a user only their own role', async () => {
    const rows = await asUser(db, customer, async (tx) => (await tx.query('select user_id from public.user_roles')).rows);
    assert.deepEqual(rows, [{ user_id: customer }]);
  });

  it('cannot be edited directly, even to promote yourself', async () => {
    await assert.rejects(
      asUser(db, customer, (tx) =>
        tx.query("update public.user_roles set role = 'admin' where user_id = $1", [customer]),
      ),
      PERMISSION_DENIED,
    );
  });

  it('is hidden from visitors who are not signed in', async () => {
    await assert.rejects(asAnonymous(db, (tx) => tx.query('select * from public.user_roles')), PERMISSION_DENIED);
  });
});

describe('assigning roles', () => {
  it('lets an admin promote a customer and records who did it', async () => {
    await asUser(db, admin, (tx) => tx.query("select public.assign_role($1, 'merchant')", [customer]));

    assert.equal((await issueClaims(db, customer)).user_role, 'merchant');
    const log = await asUser(db, admin, async (tx) =>
      (await tx.query('select old_role, new_role, changed_by from public.role_changes')).rows,
    );
    assert.deepEqual(log, [{ old_role: 'customer', new_role: 'merchant', changed_by: admin }]);
  });

  it('refuses anyone who is not an admin', async () => {
    await assert.rejects(
      asUser(db, merchant, (tx) => tx.query("select public.assign_role($1, 'admin')", [customer])),
      /FORBIDDEN/,
    );
  });

  it('stops an admin from changing their own role', async () => {
    await assert.rejects(
      asUser(db, admin, (tx) => tx.query("select public.assign_role($1, 'customer')", [admin])),
      /CANNOT_CHANGE_OWN_ROLE/,
    );
  });

  it('keeps the role log private to admins', async () => {
    const rows = await asUser(db, merchant, async (tx) => (await tx.query('select * from public.role_changes')).rows);
    assert.deepEqual(rows, []);
  });
});
