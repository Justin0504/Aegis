'use client'

/**
 * useMonthlyUsage — reactive read of the operator's current-month
 * check count against the tier limit from marketing pricing.
 *
 * Source of truth for the COUNT: gateway's UsageMeteringService,
 * exposed at GET /api/v1/admin/usage/:orgId. Single-tenant
 * self-host uses orgId 'default'.
 *
 * Source of truth for the LIMIT: TIER_LIMITS below, kept in sync
 * with aegistraces.com/pricing (the user-facing promise). Gateway
 * has its own PLAN_LIMITS but they don't match the marketing
 * pricing numbers — this hook uses the marketing values so what
 * the operator sees in the Cockpit matches what they saw when
 * they signed up.
 *
 * Free tier is the default when no license is loaded. The bar is
 * a SOFT signal — no hard blocks in self-hosted mode. Hosted-cloud
 * enforcement would layer on top by checking checkQuota() at the
 * gateway layer.
 */

import { useQuery } from '@tanstack/react-query'
import { gw } from '@/lib/gateway'
import { useLicenseTier, type Tier } from '@/hooks/useLicenseTier'

/** Marketing pricing → monthly check limits. Mirror any change in
 *  apps/marketing/src/pages/pricing.astro. */
export const TIER_LIMITS: Record<Tier, number> = {
  free:       1_000,
  pro:        100_000,
  team:       1_000_000,
  business:   Number.POSITIVE_INFINITY,
  enterprise: Number.POSITIVE_INFINITY,
}

interface QuotaDashboard {
  plan: string
  period: string
  quotas: Record<string, { current: number; limit: number; pct: number }>
}

export interface UsageState {
  loaded: boolean
  tier: Tier
  used:  number
  limit: number
  pct:   number
  /** True when usage is > 80% of the limit — trigger the warm-gold
   *  "approaching limit" chip. */
  warn:  boolean
  /** True when usage has passed the limit. */
  over:  boolean
}

export function useMonthlyUsage(orgId: string = 'default'): UsageState {
  const { tier } = useLicenseTier()

  // Poll every 30s. Cheap enough — the gateway query is a single
  // indexed WHERE on usage_records for the current period. Failures
  // (gateway down, no admin auth) fall back to `used: 0` so the bar
  // doesn't disappear or lie about usage.
  const { data } = useQuery({
    queryKey: ['monthly-usage', orgId],
    queryFn: async () => {
      const res = await gw(`admin/usage/${orgId}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as QuotaDashboard
    },
    refetchInterval: 30_000,
    staleTime:       25_000,
    retry:           false,
  })

  const limit = TIER_LIMITS[tier]
  const used  = data?.quotas?.traces_per_month?.current ?? 0
  const pct   = limit === Number.POSITIVE_INFINITY
    ? 0
    : Math.round((used / limit) * 100)

  return {
    loaded: data != null,
    tier,
    used,
    limit,
    pct,
    warn: pct >= 80 && pct < 100,
    over: pct >= 100,
  }
}
