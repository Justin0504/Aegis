'use client'

/**
 * UsageMeter — shows monthly check count vs tier limit.
 *
 * Two variants:
 *   · variant="card"  → full card for the Overview page (default).
 *   · variant="strip" → single-line minimal for the status bar.
 *
 * States:
 *   · Normal (<80%): muted bar, neutral color
 *   · Warn   (80–99%): warm-gold bar + "approaching limit" chip
 *   · Over   (≥100%): red bar + Upgrade CTA
 *
 * Self-hosted mode: soft signal, never blocks. Cockpit's Cockpit
 * shows what would happen if the operator were on the hosted
 * cloud tier + gives them a chance to upgrade before hitting the
 * hosted enforcement layer (which lands in a later commit).
 */

import { ArrowUpRight } from 'lucide-react'
import { useMonthlyUsage, TIER_LIMITS } from '@/hooks/useMonthlyUsage'
import { useLicenseTier, type Tier } from '@/hooks/useLicenseTier'

const TIER_NAME: Record<Tier, string> = {
  free:       'Free',
  pro:        'Pro',
  team:       'Team',
  enterprise: 'Enterprise',
}

function fmt(n: number): string {
  if (!isFinite(n)) return '∞'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`
  return n.toLocaleString()
}

/** Next tier up from current. Enterprise stays at enterprise. */
function nextTier(t: Tier): Tier {
  return t === 'free' ? 'pro' : t === 'pro' ? 'team' : 'enterprise'
}

const UPSELL_URL = 'https://aegistraces.com/pricing'

interface Props {
  variant?: 'card' | 'strip'
}

export function UsageMeter({ variant = 'card' }: Props) {
  const usage = useMonthlyUsage()
  const { tier } = useLicenseTier()
  const next = nextTier(tier)

  // Bar color per state.
  const barColor =
    usage.over ? 'hsl(0 42% 45%)'   :
    usage.warn ? 'hsl(36 60% 42%)'  :
    'hsl(var(--muted-foreground))'
  const trackColor = 'hsl(var(--border))'
  const barWidth = Math.min(100, Math.max(0, usage.pct))

  if (variant === 'strip') {
    // Compact single-line for the status bar. Enterprise → no bar
    // (unlimited), just show "Enterprise · unlimited".
    if (usage.tier === 'enterprise') {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
          Enterprise · unlimited
        </span>
      )
    }
    return (
      <span className="inline-flex items-center gap-2 text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
        <span className="tabular-nums">
          {fmt(usage.used)} / {fmt(usage.limit)}
        </span>
        <span className="inline-block h-1.5 rounded-full" style={{ width: 60, background: trackColor }}>
          <span className="block h-full rounded-full" style={{ width: `${barWidth}%`, background: barColor }} />
        </span>
        {(usage.warn || usage.over) && (
          <a href={UPSELL_URL} target="_blank" rel="noopener"
             className="font-medium"
             style={{ color: usage.over ? 'hsl(0 42% 45%)' : 'hsl(36 60% 32%)' }}>
            Upgrade →
          </a>
        )}
      </span>
    )
  }

  // Card variant for Overview.
  return (
    <div className="rounded-xl border p-4"
         style={{
           background: 'hsl(var(--card))',
           borderColor: 'hsl(var(--border))',
         }}>
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <div>
          <div className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
            Monthly checks
          </div>
          <div className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
            {TIER_NAME[usage.tier]} tier · {usage.limit === Number.POSITIVE_INFINITY ? 'unlimited' : `${fmt(usage.limit)} / month`}
          </div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold tabular-nums" style={{ color: 'hsl(var(--foreground))' }}>
            {fmt(usage.used)}
          </div>
          {usage.limit !== Number.POSITIVE_INFINITY && (
            <div className="text-xs tabular-nums" style={{ color: barColor }}>
              {usage.pct}% used
            </div>
          )}
        </div>
      </div>

      {usage.limit !== Number.POSITIVE_INFINITY && (
        <div className="h-2 rounded-full mb-3" style={{ background: trackColor }}>
          <div className="h-full rounded-full transition-all duration-300"
               style={{ width: `${barWidth}%`, background: barColor }} />
        </div>
      )}

      {usage.over && (
        <div className="flex items-start gap-2 text-xs p-2 rounded"
             style={{ background: 'hsl(0 28% 95%)', color: 'hsl(0 42% 35%)', border: '1px solid hsl(0 42% 80%)' }}>
          <div className="flex-1">
            <strong>Over limit.</strong> Self-hosted: audit-only mode kicks in.
            Hosted cloud will 402 requests over quota — upgrade to keep enforcement live.
          </div>
          <a href={UPSELL_URL} target="_blank" rel="noopener"
             className="flex-shrink-0 inline-flex items-center gap-1 font-semibold px-2 py-1 rounded"
             style={{ background: 'hsl(0 42% 45%)', color: 'white' }}>
            Upgrade to {TIER_NAME[next]} <ArrowUpRight className="h-3 w-3" />
          </a>
        </div>
      )}
      {usage.warn && !usage.over && (
        <div className="flex items-start gap-2 text-xs p-2 rounded"
             style={{ background: 'hsl(36 45% 95%)', color: 'hsl(36 45% 30%)', border: '1px solid hsl(36 45% 75%)' }}>
          <div className="flex-1">
            <strong>Approaching limit.</strong> You'll hit {fmt(usage.limit)} soon —
            upgrade to {TIER_NAME[next]} for {fmt(TIER_LIMITS[next])} / month.
          </div>
          <a href={UPSELL_URL} target="_blank" rel="noopener"
             className="flex-shrink-0 inline-flex items-center gap-1 font-semibold px-2 py-1 rounded"
             style={{ background: 'hsl(36 45% 30%)', color: 'white' }}>
            Upgrade <ArrowUpRight className="h-3 w-3" />
          </a>
        </div>
      )}
    </div>
  )
}
