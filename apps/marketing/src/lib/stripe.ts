/**
 * Stripe SDK factory — lazy-init on request. Cloudflare Workers +
 * Node runtime both work; Stripe v17+ ships a fetch-based HTTP client
 * that's Workers-safe.
 */

import Stripe from 'stripe';
import { readEnv } from './supabase';

export function getStripe(locals: App.Locals): Stripe {
  const key = readEnv(locals, 'STRIPE_SECRET_KEY');
  if (!key) {
    throw new Error('Stripe env not configured (STRIPE_SECRET_KEY). See docs/AUTH-SETUP.md § Stripe.');
  }
  return new Stripe(key, {
    apiVersion: '2024-12-18.acacia',
    // Workers-friendly HTTP client. Prevents "Buffer is not defined"
    // and other Node-isms from tripping the Pages Functions runtime.
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export function getWebhookSecret(locals: App.Locals): string {
  const s = readEnv(locals, 'STRIPE_WEBHOOK_SECRET');
  if (!s) throw new Error('STRIPE_WEBHOOK_SECRET not configured.');
  return s;
}

/**
 * Price-id → plan-name map. Kept as a single-source-of-truth here so
 * both /api/checkout (before purchase) and /api/stripe-webhook (after
 * purchase) agree on what plan a given price maps to. Environment-
 * variable driven so test / staging / prod price ids can differ
 * without a code change.
 */
export function planForPrice(locals: App.Locals, priceId: string): string | null {
  const map = [
    ['STRIPE_PRICE_PRO_MONTHLY',        'pro'],
    ['STRIPE_PRICE_PRO_ANNUAL',         'pro'],
    ['STRIPE_PRICE_TEAM_MONTHLY',       'team'],
    ['STRIPE_PRICE_TEAM_ANNUAL',        'team'],
    ['STRIPE_PRICE_BUSINESS_MONTHLY',   'business'],
    ['STRIPE_PRICE_BUSINESS_ANNUAL',    'business'],
    ['STRIPE_PRICE_ENTERPRISE_MONTHLY', 'enterprise'],
    ['STRIPE_PRICE_ENTERPRISE_ANNUAL',  'enterprise'],
  ] as const;
  for (const [envKey, plan] of map) {
    if (readEnv(locals, envKey) === priceId) return plan;
  }
  return null;
}

/**
 * Resolve a friendly plan name → the configured Stripe price id.
 * Called by /api/checkout so browsers never see price ids in HTML
 * (which would let anyone POST an arbitrary price and buy it).
 *
 * Plans mirror the pricing page (Free is not billable, Enterprise is
 * sales-led): pro / pro-annual / team / team-annual / business /
 * business-annual / enterprise / enterprise-annual.
 */
export function priceForPlan(locals: App.Locals, plan: string): string | null {
  const key = ({
    'pro':                'STRIPE_PRICE_PRO_MONTHLY',
    'pro-annual':         'STRIPE_PRICE_PRO_ANNUAL',
    'team':               'STRIPE_PRICE_TEAM_MONTHLY',
    'team-annual':        'STRIPE_PRICE_TEAM_ANNUAL',
    'business':           'STRIPE_PRICE_BUSINESS_MONTHLY',
    'business-annual':    'STRIPE_PRICE_BUSINESS_ANNUAL',
    'enterprise':         'STRIPE_PRICE_ENTERPRISE_MONTHLY',
    'enterprise-annual':  'STRIPE_PRICE_ENTERPRISE_ANNUAL',
  } as Record<string, string>)[plan];
  if (!key) return null;
  return readEnv(locals, key) ?? null;
}
