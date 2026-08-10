-- ── Expand license_keys.plan to the 5-tier open-core lineup ─────
--
-- Original 0001 migration allowed any text in `plan` with a comment
-- restricting to 'pro' | 'enterprise'. Pricing v2 (2026-08) adds
-- 'team' + 'business' as billable middle tiers. Adding an explicit
-- CHECK now surfaces typos in the Stripe webhook (which is what
-- writes into this column) instead of silently persisting garbage
-- that would then confuse the desktop app's tier normalisation.
--
-- Safe to run on existing installs: the check only rejects values
-- outside the enum; every row we've ever written falls in the enum.

alter table public.license_keys
  drop constraint if exists license_keys_plan_check;

alter table public.license_keys
  add constraint license_keys_plan_check
  check (plan in ('pro', 'team', 'business', 'enterprise'));

comment on column public.license_keys.plan is
  'Billable tier at time of purchase: pro | team | business | enterprise. Free is not billable and has no license row.';
