/**
 * BillingService — plan-aware quota enforcement.
 *
 * Three jobs:
 *   1. Authoritative plan-quota table — the source of truth for
 *      "what does this customer's plan allow".
 *   2. Gate every billable call (check / proxy) against the org's
 *      current usage; return a typed verdict ('allow' | 'cap' | 'block').
 *   3. Surface a snapshot to the cockpit / customer billing page.
 *
 * The actual Stripe sync (subscription lifecycle) lives in the webhook
 * handler at api/stripe.ts; THIS file is the gateway-side reader.
 *
 * Plan IDs are the strings used in the marketing site's pricing page.
 * Keep them in lockstep — when you bump a Pro limit on the website, you
 * MUST also bump it here AND in the Stripe price metadata.
 */

import { Logger } from 'pino';
import type { BillingStore, PlanId } from '../db/billing-store';

export interface PlanQuota {
  monthly_checks: number;
  retention_days: number;
  max_agents: number;
  max_seats: number;
  /** Allow the plan to overrage (Pro / Team) instead of hard-blocking. */
  allow_overage: boolean;
  /** Cents per 10,000-check block of overage. 0 = free overage. */
  overage_cents_per_10k: number;
  /** Whether enterprise features (SAML, witness, custom detectors) unlock. */
  features: {
    scim: boolean;
    saml: boolean;
    witness: boolean;
    custom_detectors: boolean;
    workflow_aware_gen: boolean;
    collusion_detector: boolean;
    pi_corpus: boolean;
    effectiveness_scorer: boolean;
    counterfactual: boolean;
  };
}

/** Authoritative plan-quota table. Mirror to marketing site +
 *  Stripe price metadata when you change a row. */
export const PLAN_QUOTAS: Record<PlanId, PlanQuota> = {
  // Free is a trial, not a tier to run on: enough checks to watch one
  // agent get held and blocked (~10–30 agent tasks), not enough to put
  // anything in production. Mirror: apps/marketing pricing.astro.
  free: {
    monthly_checks: 100,
    retention_days: 1,
    max_agents: 1,
    max_seats: 1,
    allow_overage: false,
    overage_cents_per_10k: 0,
    features: {
      scim: false, saml: false, witness: false, custom_detectors: false,
      workflow_aware_gen: false, collusion_detector: false,
      pi_corpus: false, effectiveness_scorer: false, counterfactual: true,
    },
  },
  pro: {
    monthly_checks: 100_000,
    retention_days: 30,
    max_agents: 100,
    max_seats: 3,
    allow_overage: true,
    overage_cents_per_10k: 100,    // $1 per 10k
    features: {
      scim: true, saml: false, witness: false, custom_detectors: true,
      workflow_aware_gen: true, collusion_detector: true,
      pi_corpus: false, effectiveness_scorer: false, counterfactual: true,
    },
  },
  team: {
    monthly_checks: 1_000_000,
    retention_days: 90,
    max_agents: Number.MAX_SAFE_INTEGER,
    max_seats: 10,
    allow_overage: true,
    overage_cents_per_10k: 50,     // $0.50 per 10k
    features: {
      scim: true, saml: true, witness: true, custom_detectors: true,
      workflow_aware_gen: true, collusion_detector: true,
      pi_corpus: true, effectiveness_scorer: true, counterfactual: true,
    },
  },
  enterprise: {
    monthly_checks: Number.MAX_SAFE_INTEGER,
    retention_days: 365 * 7,
    max_agents: Number.MAX_SAFE_INTEGER,
    max_seats: Number.MAX_SAFE_INTEGER,
    allow_overage: false,           // contractual, not metered
    overage_cents_per_10k: 0,
    features: {
      scim: true, saml: true, witness: true, custom_detectors: true,
      workflow_aware_gen: true, collusion_detector: true,
      pi_corpus: true, effectiveness_scorer: true, counterfactual: true,
    },
  },
};

export interface QuotaVerdict {
  /** `allow` = under quota, proceed normally.
   *  `cap`   = over quota but plan allows overage; bill it.
   *  `block` = over quota AND plan disallows overage (Free); 429 the request. */
  decision: 'allow' | 'cap' | 'block';
  plan: PlanId;
  current_checks: number;
  monthly_cap: number;
  remaining: number;
}

export class BillingService {
  constructor(
    private store: BillingStore,
    private logger: Logger,
  ) {}

  /** Resolve the plan for an org. Defaults to Free when no row found. */
  async planFor(orgId: string): Promise<PlanId> {
    const sub = await this.store.getSubscription(orgId);
    // Treat past_due / unpaid as Free until Stripe reconciles — fail-
    // safe to the cheapest plan rather than blocking traffic.
    if (sub.status === 'past_due' || sub.status === 'unpaid' || sub.status === 'canceled') {
      return 'free';
    }
    return sub.plan;
  }

  /** Hot-path gate. Increment-then-check is by design: the post-
   *  increment counter is what we compare, so a burst of 100 parallel
   *  calls each see a deterministic position vs the cap (no thundering-
   *  herd over-shoot).  */
  async checkQuota(orgId: string): Promise<QuotaVerdict> {
    const plan = await this.planFor(orgId);
    const quota = PLAN_QUOTAS[plan];
    const current = await this.store.incrementUsage(orgId, 'checks');
    const remaining = Math.max(0, quota.monthly_checks - current);
    let decision: QuotaVerdict['decision'];
    if (current <= quota.monthly_checks) {
      decision = 'allow';
    } else if (quota.allow_overage) {
      decision = 'cap';
    } else {
      decision = 'block';
    }
    return {
      decision, plan,
      current_checks: current,
      monthly_cap: quota.monthly_checks,
      remaining,
    };
  }

  /** Feature gate — used by enterprise-feature endpoints (SAML config,
   *  witness register, custom-detector mount). Returns true if the org's
   *  current plan allows the named feature. */
  async hasFeature(orgId: string, feature: keyof PlanQuota['features']): Promise<boolean> {
    const plan = await this.planFor(orgId);
    return PLAN_QUOTAS[plan].features[feature];
  }

  /** Customer billing-page summary. */
  async snapshot(orgId: string): Promise<{
    plan: PlanId;
    quota: PlanQuota;
    usage: Record<string, number>;
    subscription: Awaited<ReturnType<BillingStore['getSubscription']>>;
  }> {
    const subscription = await this.store.getSubscription(orgId);
    const plan = await this.planFor(orgId);
    const quota = PLAN_QUOTAS[plan];
    const usage = await this.store.getAllUsage(orgId);
    return { plan, quota, usage, subscription };
  }
}

/** Express middleware factory — runs after auth so it has access to
 *  req.orgId. On `block` returns 429 with a Retry-After header set to
 *  the start of the next billing period. */
/** Hosted quotas apply only where hosted billing exists. A self-hosted
 *  gateway has no Stripe and no subscription rows, so every org resolved
 *  to the Free plan and was refused after 1,000 checks a month — the
 *  MIT-licensed build silently stopped deciding calls. Found by the
 *  AgentDojo run (~5,000 checks per gateway), which the compatibility
 *  matrix (76) never reached. Enforcement is on when STRIPE_WEBHOOK_SECRET
 *  is configured or AEGIS_BILLING=enforce, off for AEGIS_BILLING=off. */
export function quotaEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = (env.AEGIS_BILLING ?? '').trim().toLowerCase();
  if (mode === 'enforce') return true;
  if (mode === 'off') return false;
  return Boolean(env.STRIPE_WEBHOOK_SECRET?.trim());
}

export function billingMiddleware(svc: BillingService, env: NodeJS.ProcessEnv = process.env) {
  const enforced = quotaEnforced(env);
  return async (req: any, res: any, next: any) => {
    if (!enforced) return next();
    const orgId = req.orgId ?? 'default';
    try {
      const verdict = await svc.checkQuota(orgId);
      // Attach for downstream handlers (audit / response headers).
      req.billing = verdict;
      res.setHeader('X-Aegis-Plan', verdict.plan);
      res.setHeader('X-Aegis-Checks-Remaining', String(verdict.remaining));
      if (verdict.decision === 'block') {
        const nextMonthStart = new Date();
        nextMonthStart.setUTCMonth(nextMonthStart.getUTCMonth() + 1, 1);
        nextMonthStart.setUTCHours(0, 0, 0, 0);
        const retryAfter = Math.max(60, Math.floor((nextMonthStart.getTime() - Date.now()) / 1000));
        res.setHeader('Retry-After', String(retryAfter));
        res.status(429).json({
          error: 'monthly check quota exhausted',
          plan: verdict.plan,
          monthly_cap: verdict.monthly_cap,
          upgrade_url: 'https://aegis.dev/pricing',
        });
        return;
      }
      next();
    } catch (err) {
      // Fail-open on billing errors — better to let a request through
      // and reconcile on next webhook than to block a paying customer
      // because Stripe was flaky.
      next();
    }
  };
}
