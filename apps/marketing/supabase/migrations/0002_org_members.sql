-- ── Team invite flow · organizations + membership ──────────────────
--
-- Turns AEGIS from a single-user tool into a real B2B SaaS org
-- account model. Every user belongs to at least one org (their
-- personal org, auto-created on signup). Buyers can invite
-- teammates who then share the same license row.
--
-- Roles hierarchy (owner > admin > member > viewer):
--   · owner   — billing + destroy org
--   · admin   — invite/remove members, view billing
--   · member  — configure policies, read traces, approve
--   · viewer  — read-only (compliance officers, exec overview)
--
-- Apply via `supabase db push`. Idempotent — safe to re-run.

-- ── Organizations table (may already exist from earlier work) ───────
create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text unique not null,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ── Membership junction table ───────────────────────────────────────
create table if not exists public.organization_members (
  org_id     uuid not null references public.organizations(id) on delete cascade,
  user_id    uuid not null references auth.users(id)             on delete cascade,
  role       text not null check (role in ('owner','admin','member','viewer')),
  invited_by uuid                references auth.users(id),
  joined_at  timestamptz default now(),
  primary key (org_id, user_id)
);
create index if not exists idx_org_members_user on public.organization_members (user_id);
create index if not exists idx_org_members_role on public.organization_members (org_id, role);

-- ── Pending invitations (email → org, waiting for signup) ──────────
-- When an owner invites teammate@corp.com who doesn't have an AEGIS
-- account yet, we store the invite here. On signup / first magic-
-- link, the auth trigger below looks up any pending invites by
-- email and auto-adds the new user to the org.
create table if not exists public.organization_invites (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  email       text not null,
  role        text not null check (role in ('admin','member','viewer')),
  invited_by  uuid references auth.users(id),
  created_at  timestamptz default now(),
  accepted_at timestamptz,
  revoked_at  timestamptz,
  unique (org_id, email)
);
create index if not exists idx_invites_email on public.organization_invites (email)
  where accepted_at is null and revoked_at is null;

-- ── Auto-create personal org + owner membership on signup ──────────
-- Every new auth.users row gets: (1) a personal org named after
-- their email domain (or full email if no @), (2) an owner
-- membership row linking them to it. This means every logged-in
-- user always has an org to work in — no "orphan account" state.
create or replace function public.handle_new_user_org()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  new_org_id uuid;
  slug_seed  text;
begin
  -- Slug from email domain when possible, otherwise from local part.
  -- Collisions get a random suffix.
  slug_seed := lower(coalesce(
    substring(new.email from '@(.+)$'),
    split_part(new.email, '@', 1),
    'user'
  ));
  slug_seed := regexp_replace(slug_seed, '[^a-z0-9\-]', '-', 'g');
  slug_seed := slug_seed || '-' || substr(md5(new.id::text), 1, 6);

  insert into public.organizations (name, slug)
  values (
    coalesce(new.raw_user_meta_data->>'full_name', new.email, 'My Organization'),
    slug_seed
  )
  returning id into new_org_id;

  insert into public.organization_members (org_id, user_id, role, invited_by)
  values (new_org_id, new.id, 'owner', new.id);

  -- Auto-accept any pending invites for this email.
  update public.organization_invites
    set accepted_at = now()
    where email = new.email
      and accepted_at is null
      and revoked_at is null;

  insert into public.organization_members (org_id, user_id, role, invited_by)
  select oi.org_id, new.id, oi.role, oi.invited_by
    from public.organization_invites oi
    where oi.email = new.email
      and oi.accepted_at is not null
  on conflict (org_id, user_id) do nothing;

  return new;
end;
$$;

-- Chain with the existing on_auth_user_created trigger (from
-- 0001_auth_billing.sql). Drop-if-exists so re-running the
-- migration flips cleanly.
drop trigger if exists on_auth_user_created_org on auth.users;
create trigger on_auth_user_created_org
  after insert on auth.users
  for each row execute function public.handle_new_user_org();

-- ── RLS ────────────────────────────────────────────────────────────
alter table public.organizations         enable row level security;
alter table public.organization_members  enable row level security;
alter table public.organization_invites  enable row level security;

-- Members can read the orgs they belong to.
drop policy if exists "orgs_member_read" on public.organizations;
create policy "orgs_member_read" on public.organizations for select
  using (id in (
    select org_id from public.organization_members where user_id = auth.uid()
  ));

-- Owners + admins can update org (rename, change slug).
drop policy if exists "orgs_admin_write" on public.organizations;
create policy "orgs_admin_write" on public.organizations for update
  using (id in (
    select org_id from public.organization_members
      where user_id = auth.uid() and role in ('owner','admin')
  ));

-- Members can see their own org's membership list.
drop policy if exists "members_read_own_org" on public.organization_members;
create policy "members_read_own_org" on public.organization_members for select
  using (org_id in (
    select org_id from public.organization_members where user_id = auth.uid()
  ));

-- Only owners can INSERT/DELETE members directly via table (the
-- normal invite flow goes through /api/team/invite which uses the
-- service-role key). Keeps RLS honest even if the admin UI is
-- bypassed.
drop policy if exists "members_owner_write" on public.organization_members;
create policy "members_owner_write" on public.organization_members for all
  using (org_id in (
    select org_id from public.organization_members
      where user_id = auth.uid() and role = 'owner'
  ));

-- Invites: admins + owners can see + create.
drop policy if exists "invites_admin_read" on public.organization_invites;
create policy "invites_admin_read" on public.organization_invites for select
  using (org_id in (
    select org_id from public.organization_members
      where user_id = auth.uid() and role in ('owner','admin')
  ));
drop policy if exists "invites_admin_write" on public.organization_invites;
create policy "invites_admin_write" on public.organization_invites for all
  using (org_id in (
    select org_id from public.organization_members
      where user_id = auth.uid() and role in ('owner','admin')
  ));

-- ── Migrate subscriptions + license_keys to be org-scoped ──────────
-- Existing rows are user-scoped (user_id column from 0001). Add
-- org_id column; a backfill query sets it to the user's personal
-- org. New rows should populate org_id directly.
alter table public.subscriptions add column if not exists org_id uuid references public.organizations(id);
alter table public.license_keys  add column if not exists org_id uuid references public.organizations(id);

-- One-shot backfill (safe on empty tables).
update public.subscriptions s
  set org_id = m.org_id
  from public.organization_members m
  where s.user_id = m.user_id
    and m.role = 'owner'
    and s.org_id is null;

update public.license_keys lk
  set org_id = m.org_id
  from public.organization_members m
  where lk.user_id = m.user_id
    and m.role = 'owner'
    and lk.org_id is null;

create index if not exists idx_subs_org       on public.subscriptions (org_id);
create index if not exists idx_licenses_org   on public.license_keys  (org_id);

-- Update RLS on subscriptions / license_keys so every org member
-- (not just the buyer) can see the org's billing state + license.
drop policy if exists "subs_self_read" on public.subscriptions;
create policy "subs_org_read" on public.subscriptions for select
  using (org_id in (
    select org_id from public.organization_members where user_id = auth.uid()
  ));

drop policy if exists "keys_self_read" on public.license_keys;
create policy "keys_org_read" on public.license_keys for select
  using (org_id in (
    select org_id from public.organization_members where user_id = auth.uid()
  ));
