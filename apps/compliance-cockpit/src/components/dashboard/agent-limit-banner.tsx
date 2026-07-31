'use client'

/**
 * Agent-limit banner on Overview.
 *
 * Surfaces the org's active-agent count against its license-tier cap.
 * Purpose: give operators a concrete upgrade signal the moment overflow
 * happens ("45 / 50 agents · 2 in audit-only · Upgrade →"), without
 * ever silently blocking calls (overflow agents run in audit-only
 * mode; see agent-registry.applyTierOverflow).
 *
 * Hidden entirely when the org has no agents yet or is on enterprise
 * (unlimited). Otherwise renders one of three states:
 *
 *   · under limit         — muted "X / N agents" chip
 *   · at limit            — amber warning + upgrade CTA
 *   · over limit          — red banner with audit-only count + CTA
 */

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { AlertTriangle, ArrowUpRight, Users } from 'lucide-react'
import { gw } from '@/lib/gateway'

interface Limits {
  tier: 'community' | 'pro' | 'enterprise'
  limit: number | null
  enforced_count: number
  audit_only_count: number
  total_count: number
  over_limit: boolean
}

export function AgentLimitBanner() {
  const { data } = useQuery<Limits | null>({
    queryKey: ['agents-limits'],
    queryFn: async () => {
      const res = await gw('agents/limits')
      if (!res.ok) return null
      return (await res.json()) as Limits
    },
    // Cap noise — this is a soft signal; every 30s is plenty.
    refetchInterval: 30_000,
    staleTime: 15_000,
  })

  if (!data || data.limit == null || data.total_count === 0) return null

  const { tier, limit, enforced_count, audit_only_count, total_count, over_limit } = data
  const pct = Math.min(100, Math.round((total_count / limit) * 100))
  const nextTier = tier === 'community' ? 'Pro' : 'Enterprise'
  const nextTierCap = tier === 'community' ? 50 : 'unlimited'

  // Under limit + still headroom → muted chip only. Threshold: 80%.
  if (!over_limit && pct < 80) {
    return (
      <div className="text-xs flex items-center gap-2 px-3 py-1.5 rounded-md border w-fit"
           style={{ background: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}>
        <Users className="h-3 w-3" />
        <span className="tabular-nums">{total_count} / {limit} agents</span>
        <span>·</span>
        <span className="uppercase tracking-wider">{tier}</span>
      </div>
    )
  }

  // At limit (80-99%) — amber warning.
  if (!over_limit) {
    return (
      <div className="rounded-lg border p-3 flex items-start gap-3"
           style={{ background: 'hsl(36 45% 96%)', borderColor: 'hsl(36 55% 78%)' }}>
        <div className="p-1.5 rounded-md flex-shrink-0"
             style={{ background: 'hsl(36 55% 88%)' }}>
          <Users className="h-3.5 w-3.5" style={{ color: 'hsl(36 55% 30%)' }} />
        </div>
        <div className="flex-1 text-sm">
          <div className="font-medium" style={{ color: 'hsl(36 55% 22%)' }}>
            {total_count} of {limit} agents on {tier} tier
          </div>
          <div className="text-xs mt-0.5" style={{ color: 'hsl(36 55% 32%)' }}>
            {limit - total_count} agent slot{limit - total_count === 1 ? '' : 's'} left before new agents run in audit-only.
          </div>
        </div>
        <Link href="/settings/billing" className="text-xs font-medium flex items-center gap-1 hover:underline flex-shrink-0"
              style={{ color: 'hsl(36 65% 28%)' }}>
          Upgrade to {nextTier}
          <ArrowUpRight className="h-3 w-3" />
        </Link>
      </div>
    )
  }

  // Over limit — red banner.
  return (
    <div className="rounded-lg border p-3 flex items-start gap-3"
         style={{ background: 'hsl(0 45% 97%)', borderColor: 'hsl(0 45% 78%)' }}>
      <div className="p-1.5 rounded-md flex-shrink-0"
           style={{ background: 'hsl(0 45% 92%)' }}>
        <AlertTriangle className="h-3.5 w-3.5" style={{ color: 'hsl(0 55% 40%)' }} />
      </div>
      <div className="flex-1 text-sm">
        <div className="font-medium" style={{ color: 'hsl(0 55% 30%)' }}>
          {enforced_count} of {limit} agents enforced · {audit_only_count} in audit-only
        </div>
        <div className="text-xs mt-0.5" style={{ color: 'hsl(0 45% 40%)' }}>
          Overflow agents still trace, but their calls are never blocked.
          Upgrade to {nextTier} for {nextTierCap} agents with full enforcement.
        </div>
      </div>
      <Link href="/settings/billing" className="text-xs font-semibold flex items-center gap-1 hover:underline flex-shrink-0 whitespace-nowrap"
            style={{ color: 'hsl(0 65% 38%)' }}>
        Upgrade to {nextTier}
        <ArrowUpRight className="h-3 w-3" />
      </Link>
    </div>
  )
}
