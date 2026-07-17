-- Supabase schema for AEGIS marketing-site auth + billing.
--
-- Apply via:
--   supabase db push
-- or through the Supabase SQL editor. Idempotent — safe to re-run.

-- ─── Extensions ────────────────────────────────────────────────────
create extension if not exists "pgcrypto";

-- ─── Profiles ──────────────────────────────────────────────────────
-- Extends auth.users (Supabase-managed) with app-facing metadata.
create table if not exists public.profiles (
  id                 uuid primary key references auth.users on delete cascade,
  email              text,
  full_name          text,
  avatar_url         text,
  stripe_customer_id text unique,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

alter table public.profiles enable row level security;

-- Users can read + update their own profile row only.
drop policy if exists "profiles_self_read"  on public.profiles;
drop policy if exists "profiles_self_write" on public.profiles;
create policy "profiles_self_read"  on public.profiles for select using (auth.uid() = id);
create policy "profiles_self_write" on public.profiles for update using (auth.uid() = id);

-- Auto-create a profile row on signup.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─── Subscriptions ─────────────────────────────────────────────────
create table if not exists public.subscriptions (
  id                    text primary key,             -- Stripe subscription id
  user_id               uuid not null references auth.users on delete cascade,
  price_id              text,
  status                text not null,                -- active | canceled | past_due | ...
  current_period_end    timestamptz,
  cancel_at_period_end  boolean default false,
  metadata              jsonb,
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);
create index if not exists subscriptions_user on public.subscriptions (user_id);

alter table public.subscriptions enable row level security;
drop policy if exists "subs_self_read" on public.subscriptions;
create policy "subs_self_read" on public.subscriptions for select using (auth.uid() = user_id);
-- Writes are done by the Stripe webhook using the service-role key —
-- service role bypasses RLS so no INSERT/UPDATE policy is needed.

-- ─── License keys ──────────────────────────────────────────────────
create table if not exists public.license_keys (
  key                  text primary key,
  user_id              uuid not null references auth.users on delete cascade,
  plan                 text not null,                 -- pro | enterprise
  status               text not null default 'active',-- active | revoked
  issued_at            timestamptz default now(),
  expires_at           timestamptz,
  subscription_id      text references public.subscriptions on delete set null,
  checkout_session_id  text unique                    -- idempotency anchor for webhook retries
);
create index if not exists license_keys_user   on public.license_keys (user_id);
create index if not exists license_keys_status on public.license_keys (status);

alter table public.license_keys enable row level security;
drop policy if exists "keys_self_read" on public.license_keys;
create policy "keys_self_read" on public.license_keys for select using (auth.uid() = user_id);
