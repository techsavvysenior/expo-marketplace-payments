-- Roles and permissions.
--
-- Every user has exactly one role. A Custom Access Token Hook copies it into
-- the JWT as the `user_role` claim, so policies can check it without a table
-- lookup, and `authorize()` maps a role to fine-grained permissions.
-- Pattern from the Supabase RBAC guide:
-- https://supabase.com/docs/guides/database/postgres/custom-claims-and-role-based-access-control-rbac

create type public.app_role as enum ('customer', 'merchant', 'admin');

create type public.app_permission as enum (
  'products.manage_own',
  'products.manage_all',
  'orders.read_all',
  'orders.refund',
  'roles.assign'
);

create table public.user_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role public.app_role not null default 'customer',
  updated_at timestamptz not null default now()
);

create table public.role_permissions (
  role public.app_role not null,
  permission public.app_permission not null,
  primary key (role, permission)
);

-- Keep in sync with src/core/roles.ts. A unit test compares the two.
insert into public.role_permissions (role, permission) values
  ('merchant', 'products.manage_own'),
  ('admin', 'products.manage_own'),
  ('admin', 'products.manage_all'),
  ('admin', 'orders.read_all'),
  ('admin', 'orders.refund'),
  ('admin', 'roles.assign');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 60),
  created_at timestamptz not null default now()
);

-- New users start as customers.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1))
  );
  insert into public.user_roles (user_id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Runs inside Supabase Auth every time a token is issued.
-- Enable it in the dashboard: Authentication, Hooks, Custom Access Token.
create function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims jsonb := event -> 'claims';
  user_role public.app_role;
begin
  select ur.role into user_role
  from public.user_roles ur
  where ur.user_id = (event ->> 'user_id')::uuid;

  claims := jsonb_set(claims, '{user_role}', coalesce(to_jsonb(user_role), to_jsonb('customer'::text)));
  return jsonb_set(event, '{claims}', claims);
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;
grant select on public.user_roles to supabase_auth_admin;

-- The role from the current token. Falls back to customer.
create function public.current_app_role()
returns public.app_role
language sql
stable
set search_path = ''
as $$
  select coalesce((auth.jwt() ->> 'user_role')::public.app_role, 'customer');
$$;

create function public.authorize(requested_permission public.app_permission)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.role_permissions rp
    where rp.permission = requested_permission
      and rp.role = public.current_app_role()
  );
$$;

-- Only an admin can change roles, and the change is audited.
create table public.role_changes (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  old_role public.app_role not null,
  new_role public.app_role not null,
  changed_by uuid not null references auth.users (id),
  changed_at timestamptz not null default now()
);

create function public.assign_role(p_user_id uuid, p_role public.app_role)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous public.app_role;
begin
  if not public.authorize('roles.assign') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'CANNOT_CHANGE_OWN_ROLE' using errcode = 'P0001';
  end if;

  select role into previous from public.user_roles where user_id = p_user_id for update;
  if not found then
    raise exception 'USER_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.user_roles set role = p_role, updated_at = now() where user_id = p_user_id;
  insert into public.role_changes (user_id, old_role, new_role, changed_by)
  values (p_user_id, previous, p_role, auth.uid());
end;
$$;

alter table public.user_roles enable row level security;
alter table public.role_permissions enable row level security;
alter table public.profiles enable row level security;
alter table public.role_changes enable row level security;

create policy "auth admin reads roles" on public.user_roles
  for select to supabase_auth_admin using (true);

create policy "users read their own role" on public.user_roles
  for select to authenticated using (user_id = (select auth.uid()));

create policy "admins read all roles" on public.user_roles
  for select to authenticated using ((select public.authorize('roles.assign')));

create policy "signed-in users read permissions" on public.role_permissions
  for select to authenticated using (true);

create policy "signed-in users read profiles" on public.profiles
  for select to authenticated using (true);

create policy "users rename themselves" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy "admins read the role log" on public.role_changes
  for select to authenticated using ((select public.authorize('roles.assign')));

revoke all on public.user_roles, public.role_permissions, public.profiles, public.role_changes from anon;
revoke insert, update, delete on public.user_roles, public.role_permissions, public.role_changes from authenticated;
revoke insert, delete on public.profiles from authenticated;
revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;

revoke execute on function public.assign_role, public.authorize, public.current_app_role from public, anon;
grant execute on function public.assign_role, public.authorize, public.current_app_role to authenticated;
