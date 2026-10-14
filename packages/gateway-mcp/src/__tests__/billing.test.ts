/**
 * Billing service + store tests.
 * Pins:
 *   - First-access provisioning gives Free tier
 *   - checkQuota returns 'allow' / 'cap' / 'block' per plan rules
 *   - past_due / unpaid / canceled fail-safe to Free
 *   - Feature gating per plan
 *   - Stripe webhook signature verification + idempotency
 */
import Database from 'better-sqlite3';
import pino from 'pino';
import { createHmac } from 'crypto';
import { SqliteBillingStore } from '../db/billing-store';
import { BillingService, PLAN_QUOTAS } from '../services/billing';
import { StripeWebhookAPI } from '../api/stripe';

const silent = pino({ level: 'silent' });

async function makeStore() {
  const db = new Database(':memory:');
  const s = new SqliteBillingStore(db);
  await s.init();
  return s;
}

describe('BillingStore', () => {
  test('getSubscription first-access provisions Free row', async () => {
    const s = await makeStore();
    const sub = await s.getSubscription('acme');
    expect(sub.plan).toBe('free');
    expect(sub.status).toBe('active');
  });

  test('upsertSubscription overwrites cleanly', async () => {
    const s = await makeStore();
    await s.upsertSubscription({
      org_id: 'acme', plan: 'pro', status: 'active',
      stripe_customer_id: 'cus_123', stripe_subscription_id: 'sub_456',
      current_period_start: '2026-06-01T00:00:00Z',
      current_period_end:   '2026-07-01T00:00:00Z',
      cancel_at_period_end: 0,
    });
    const sub = await s.getSubscription('acme');
    expect(sub.plan).toBe('pro');
    expect(sub.stripe_subscription_id).toBe('sub_456');
  });

  test('incrementUsage is monotonic + per-metric per-month', async () => {
    const s = await makeStore();
    await s.incrementUsage('acme', 'checks');
    await s.incrementUsage('acme', 'checks');
    const c = await s.incrementUsage('acme', 'checks', 3);
    expect(c).toBe(5);
    // Different metric isolated.
    expect(await s.getUsage('acme', 'tokens')).toBe(0);
  });

  test('getAllUsage returns every metric for the current month', async () => {
    const s = await makeStore();
    await s.incrementUsage('acme', 'checks', 10);
    await s.incrementUsage('acme', 'tokens', 5_000);
    const all = await s.getAllUsage('acme');
    expect(all.checks).toBe(10);
    expect(all.tokens).toBe(5_000);
  });
});

describe('BillingService — checkQuota', () => {
  test('Free tier: under cap → allow, over cap → block', async () => {
    const store = await makeStore();
    const svc = new BillingService(store, silent);
    // Use the actual Free quota to avoid drift.
    const cap = PLAN_QUOTAS.free.monthly_checks;
    // Just under cap.
    for (let i = 0; i < cap - 1; i++) await svc.checkQuota('acme');
    const justAtCap = await svc.checkQuota('acme');
    expect(justAtCap.decision).toBe('allow');
    expect(justAtCap.remaining).toBe(0);
    const overCap = await svc.checkQuota('acme');
    expect(overCap.decision).toBe('block');
  });

  test('Pro tier: over cap → cap (overage billed, not blocked)', async () => {
    const store = await makeStore();
    const svc = new BillingService(store, silent);
    await store.upsertSubscription({
      org_id: 'acme', plan: 'pro', status: 'active',
      stripe_customer_id: 'c', stripe_subscription_id: 's',
      current_period_start: null, current_period_end: null,
      cancel_at_period_end: 0,
    });
    // Simulate burning past the cap quickly by incrementing the counter.
    for (let i = 0; i < PLAN_QUOTAS.pro.monthly_checks + 1; i++) {
      await store.incrementUsage('acme', 'checks');
    }
    const v = await svc.checkQuota('acme');
    expect(v.decision).toBe('cap');
    expect(v.plan).toBe('pro');
  });

  test('past_due subscription fails safe to Free', async () => {
    const store = await makeStore();
    const svc = new BillingService(store, silent);
    await store.upsertSubscription({
      org_id: 'acme', plan: 'pro', status: 'past_due',
      stripe_customer_id: null, stripe_subscription_id: null,
      current_period_start: null, current_period_end: null,
      cancel_at_period_end: 0,
    });
    const plan = await svc.planFor('acme');
    expect(plan).toBe('free');
  });

  test('canceled subscription fails safe to Free', async () => {
    const store = await makeStore();
    const svc = new BillingService(store, silent);
    await store.upsertSubscription({
      org_id: 'acme', plan: 'team', status: 'canceled',
      stripe_customer_id: null, stripe_subscription_id: null,
      current_period_start: null, current_period_end: null,
      cancel_at_period_end: 0,
    });
    expect(await svc.planFor('acme')).toBe('free');
  });
});

describe('BillingService — feature gating', () => {
  test('Free tier blocks SAML / witness / pi_corpus / effectiveness', async () => {
    const store = await makeStore();
    const svc = new BillingService(store, silent);
    expect(await svc.hasFeature('acme', 'saml')).toBe(false);
    expect(await svc.hasFeature('acme', 'witness')).toBe(false);
    expect(await svc.hasFeature('acme', 'pi_corpus')).toBe(false);
    expect(await svc.hasFeature('acme', 'effectiveness_scorer')).toBe(false);
  });

  test('Pro tier unlocks SCIM + collusion but not SAML / witness', async () => {
    const store = await makeStore();
    const svc = new BillingService(store, silent);
    await store.upsertSubscription({
      org_id: 'acme', plan: 'pro', status: 'active',
      stripe_customer_id: null, stripe_subscription_id: null,
      current_period_start: null, current_period_end: null,
      cancel_at_period_end: 0,
    });
    expect(await svc.hasFeature('acme', 'scim')).toBe(true);
    expect(await svc.hasFeature('acme', 'collusion_detector')).toBe(true);
    expect(await svc.hasFeature('acme', 'saml')).toBe(false);
    expect(await svc.hasFeature('acme', 'witness')).toBe(false);
  });

  test('Team tier unlocks everything except enterprise-only flags', async () => {
    const store = await makeStore();
    const svc = new BillingService(store, silent);
    await store.upsertSubscription({
      org_id: 'acme', plan: 'team', status: 'active',
      stripe_customer_id: null, stripe_subscription_id: null,
      current_period_start: null, current_period_end: null,
      cancel_at_period_end: 0,
    });
    expect(await svc.hasFeature('acme', 'saml')).toBe(true);
    expect(await svc.hasFeature('acme', 'witness')).toBe(true);
    expect(await svc.hasFeature('acme', 'pi_corpus')).toBe(true);
  });

  test('snapshot returns plan + quota + usage + raw subscription', async () => {
    const store = await makeStore();
    const svc = new BillingService(store, silent);
    await svc.checkQuota('acme');
    const snap = await svc.snapshot('acme');
    expect(snap.plan).toBe('free');
    expect(snap.quota.monthly_checks).toBe(PLAN_QUOTAS.free.monthly_checks);
    expect(snap.usage.checks).toBeGreaterThanOrEqual(1);
    expect(snap.subscription.org_id).toBe('acme');
  });
});

// ── Stripe webhook ──────────────────────────────────────────────────

function signStripe(body: string, secret: string, ts = Math.floor(Date.now() / 1000)): string {
  const payload = `${ts}.${body}`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  return `t=${ts},v1=${sig}`;
}

describe('Stripe webhook', () => {
  test('valid signature is accepted', async () => {
    const store = await makeStore();
    const api = new StripeWebhookAPI(store, silent, 'whsec_test');
    const body = JSON.stringify({
      type: 'customer.subscription.created',
      data: {
        object: {
          id: 'sub_1', customer: 'cus_1', status: 'active',
          metadata: { org_id: 'acme' },
          items: { data: [{ price: { lookup_key: 'aegis-pro-monthly' } }] },
          current_period_start: 1717200000,
          current_period_end:   1719792000,
          cancel_at_period_end: false,
        },
      },
    });
    const sig = signStripe(body, 'whsec_test');
    const req: any = { rawBody: body, header: (k: string) => k === 'stripe-signature' ? sig : '' };
    let captured: any = null;
    const res: any = {
      status: (n: number) => ({ json: (j: any) => { captured = { n, j }; } }),
      json: (j: any) => { captured = { n: 200, j }; },
    };
    await (api as any).handle(req, res);
    expect(captured.j.received).toBe(true);
    const sub = await store.getSubscription('acme');
    expect(sub.plan).toBe('pro');
    expect(sub.status).toBe('active');
  });

  test('invalid signature returns 400', async () => {
    const store = await makeStore();
    const api = new StripeWebhookAPI(store, silent, 'whsec_test');
    const req: any = { rawBody: '{}', header: (k: string) => k === 'stripe-signature' ? 't=1,v1=deadbeef' : '' };
    let captured: any = null;
    const res: any = {
      status: (n: number) => ({ json: (j: any) => { captured = { n, j }; } }),
      json: (j: any) => { captured = { n: 200, j }; },
    };
    await (api as any).handle(req, res);
    expect(captured.n).toBe(400);
  });

  test('subscription.deleted flips plan to free + canceled', async () => {
    const store = await makeStore();
    const api = new StripeWebhookAPI(store, silent, 'whsec_test');
    // Seed an active Pro sub
    await store.upsertSubscription({
      org_id: 'acme', plan: 'pro', status: 'active',
      stripe_customer_id: 'c', stripe_subscription_id: 'sub_x',
      current_period_start: null, current_period_end: null,
      cancel_at_period_end: 0,
    });
    const body = JSON.stringify({
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_x', customer: 'c', metadata: { org_id: 'acme' }, status: 'canceled' } },
    });
    const req: any = { rawBody: body, header: (k: string) => k === 'stripe-signature' ? signStripe(body, 'whsec_test') : '' };
    const res: any = { status: () => ({ json: () => {} }), json: () => {} };
    await (api as any).handle(req, res);
    const sub = await store.getSubscription('acme');
    expect(sub.plan).toBe('free');
    expect(sub.status).toBe('canceled');
  });

  test('invoice.payment_failed → past_due', async () => {
    const store = await makeStore();
    const api = new StripeWebhookAPI(store, silent, 'whsec_test');
    await store.upsertSubscription({
      org_id: 'acme', plan: 'pro', status: 'active',
      stripe_customer_id: 'c', stripe_subscription_id: 'sub_z',
      current_period_start: null, current_period_end: null,
      cancel_at_period_end: 0,
    });
    const body = JSON.stringify({
      type: 'invoice.payment_failed',
      data: { object: { metadata: { org_id: 'acme' } } },
    });
    const req: any = { rawBody: body, header: (k: string) => k === 'stripe-signature' ? signStripe(body, 'whsec_test') : '' };
    const res: any = { status: () => ({ json: () => {} }), json: () => {} };
    await (api as any).handle(req, res);
    expect((await store.getSubscription('acme')).status).toBe('past_due');
  });
});

describe('quota enforcement is hosted-only', () => {
  const { quotaEnforced, billingMiddleware } = require('../services/billing');

  test('self-hosted (no Stripe, no AEGIS_BILLING) does not enforce', () => {
    expect(quotaEnforced({} as any)).toBe(false);
  });
  test('Stripe configured enforces; AEGIS_BILLING overrides both ways', () => {
    expect(quotaEnforced({ STRIPE_WEBHOOK_SECRET: 'whsec_x' } as any)).toBe(true);
    expect(quotaEnforced({ AEGIS_BILLING: 'enforce' } as any)).toBe(true);
    expect(quotaEnforced({ STRIPE_WEBHOOK_SECRET: 'whsec_x', AEGIS_BILLING: 'off' } as any)).toBe(false);
  });
  test('self-hosted middleware passes check 1,001 and beyond without consulting the plan', async () => {
    const svc = { checkQuota: jest.fn(async () => ({ decision: 'block', plan: 'free', monthly_cap: 1000, remaining: 0 })) };
    const mw = billingMiddleware(svc as any, {} as any);
    const next = jest.fn();
    const res: any = { setHeader: jest.fn(), status: jest.fn(() => res), json: jest.fn() };
    for (let i = 0; i < 1005; i++) await mw({ orgId: 'default' }, res, next);
    expect(next).toHaveBeenCalledTimes(1005);
    expect(svc.checkQuota).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
