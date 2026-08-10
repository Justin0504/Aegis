/**
 * License-key validation endpoint for the AEGIS desktop app.
 *
 * The desktop app POSTs the license key its user typed into
 * Settings → License; we return the plan + owner email + expiry
 * (or an error) so the app can unlock pro features and display
 * a "Pro · <email>" chip.
 *
 * Auth model:
 *   The license key IS the credential. No cookie / bearer required.
 *   Anyone with the key gets the plan. Keys are ~192 bits of
 *   entropy from crypto.getRandomValues (see /api/stripe-webhook)
 *   and rate-limited at the CDN edge — brute-force isn't viable.
 *
 * CORS: open. The desktop app runs at `tauri://localhost` on macOS
 *   and `https://tauri.localhost` on Windows; neither is a stable
 *   origin we can allow-list, so we accept any origin. The endpoint
 *   returns NO user data beyond what a buyer would already see on
 *   /download, so open CORS carries no privilege escalation risk.
 */

import type { APIRoute } from 'astro';
import { getServiceSupabase } from '@/lib/supabase';

export const prerender = false;

// Idempotent 24-hour cache — the desktop app can call this on every
// launch without hammering Supabase.
const CACHE_MAX_AGE = 24 * 60 * 60;

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin':  '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age':       '86400',
};

export const OPTIONS: APIRoute = async () =>
  new Response(null, { status: 204, headers: CORS_HEADERS });

export const POST: APIRoute = async ({ request, locals }) => {
  let body: { license_key?: string };
  try { body = await request.json(); }
  catch {
    return json({ valid: false, error: 'invalid JSON body' }, 400);
  }

  const key = (body.license_key ?? '').trim();
  if (!key || !key.startsWith('AEGIS-')) {
    return json({ valid: false, error: 'license key must start with AEGIS-' }, 400);
  }

  const supabase = getServiceSupabase(locals);

  // Look up the license row. We JOIN through the user id for the
  // owner's email so the desktop app can display it in the header.
  // Using service-role bypasses RLS — this endpoint is trusted server
  // code and the license key itself gates access.
  const { data: license, error } = await supabase
    .from('license_keys')
    .select('key, plan, status, expires_at, issued_at, subscription_id, user_id')
    .eq('key', key)
    .maybeSingle();

  if (error) {
    return json({ valid: false, error: 'license lookup failed' }, 500);
  }
  if (!license) {
    return json({ valid: false, error: 'unknown license key' }, 404);
  }

  if (license.status !== 'active') {
    return json({
      valid: false,
      error: `license is ${license.status}`,
      status: license.status,
    }, 200);
  }
  if (license.expires_at && new Date(license.expires_at) < new Date()) {
    return json({ valid: false, error: 'license expired', status: 'expired' }, 200);
  }

  // Fetch owner email via auth admin API. Not in profiles because
  // Supabase manages auth.users; hitting profiles would be one extra
  // round-trip and still require the auth.users row for verification.
  const { data: userData } = await supabase.auth.admin.getUserById(license.user_id);
  const email = userData?.user?.email ?? null;

  // Canonical tier normalization. Legacy license_keys.plan values
  // were 'pro' | 'enterprise'; new rows can also be 'team' | 'business'.
  // The Cockpit's useLicenseTier hook expects one of these five
  // strings and gates every UI feature on them via TierGate.
  type Tier = 'free' | 'pro' | 'team' | 'business' | 'enterprise';
  const TIER_MAP: Record<string, Tier> = {
    pro: 'pro',
    team: 'team',
    business: 'business',
    enterprise: 'enterprise',
  };
  const tier: Tier = TIER_MAP[String(license.plan).toLowerCase()] ?? 'free';

  return json({
    valid: true,
    // `plan` kept for backward compat with older desktop builds; new
    // builds should read `tier` instead — it's the canonical field
    // used by the Cockpit's useLicenseTier hook + gateway config.
    plan: license.plan,
    tier,
    status: license.status,
    issued_at:  license.issued_at,
    expires_at: license.expires_at,
    email,
    // The subscription_id is opaque to the desktop app but useful in
    // support tickets — echoing it back lets the buyer paste it in
    // their email to us without having to dig around in Stripe.
    subscription_id: license.subscription_id,
  }, 200);
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${CACHE_MAX_AGE}`,
      ...CORS_HEADERS,
    },
  });
}
