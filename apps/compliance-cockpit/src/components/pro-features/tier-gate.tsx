'use client'

/**
 * TierGate — render children only when the operator's tier meets
 * or exceeds `requires`. Otherwise render an upsell card pointing
 * at aegistraces.com/pricing.
 *
 * Two rendering modes:
 *   · `mode="block"` (default) — replace children entirely with a
 *     full-panel upsell. Use for stand-alone features (an entire
 *     page or a section header).
 *   · `mode="disable"` — render children with pointer-events:none +
 *     opacity, overlay a "Pro" chip in the corner. Use when the
 *     shape of the disabled feature matters for context (e.g. a
 *     button in a toolbar).
 */

import type { ReactNode } from 'react'
import { Lock, ArrowUpRight } from 'lucide-react'
import { useLicenseTier, hasTier, TIER_LABEL, type Tier } from '@/hooks/useLicenseTier'

interface Props {
  /** Minimum tier that unlocks the feature. */
  requires: Exclude<Tier, 'free'>
  /** Optional feature name shown in the upsell copy. */
  feature?: string
  /** Optional one-line description of what unlocks. */
  description?: string
  mode?: 'block' | 'disable'
  children: ReactNode
}

const PRICING_URL = 'https://aegistraces.com/pricing'

export function TierGate({
  requires,
  feature = 'This feature',
  description,
  mode = 'block',
  children,
}: Props) {
  const { tier } = useLicenseTier()

  if (hasTier(tier, requires)) return <>{children}</>

  if (mode === 'disable') {
    return (
      <div className="relative inline-block">
        <div className="pointer-events-none opacity-40 select-none">{children}</div>
        <div className="absolute -top-2 -right-2 flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide"
             style={{
               background: 'hsl(36 45% 90%)',
               color: 'hsl(36 45% 30%)',
               border: '1px solid hsl(36 45% 60%)',
             }}
             title={`${TIER_LABEL[requires]} tier required — click to upgrade`}
             onClick={() => window.open(PRICING_URL, '_blank')}>
          <Lock className="h-2.5 w-2.5" /> {TIER_LABEL[requires]}
        </div>
      </div>
    )
  }

  // mode === 'block'
  return (
    <div className="rounded-xl border p-6 text-center"
         style={{
           background: 'hsl(var(--card))',
           borderColor: 'hsl(var(--border))',
         }}>
      <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wide mb-3"
           style={{
             background: 'hsl(36 45% 90%)',
             color: 'hsl(36 45% 30%)',
           }}>
        <Lock className="h-3 w-3" />
        {TIER_LABEL[requires]} tier
      </div>
      <h3 className="text-lg font-semibold mb-1" style={{ color: 'hsl(var(--foreground))' }}>
        {feature} is a {TIER_LABEL[requires]} feature
      </h3>
      {description && (
        <p className="text-sm mb-4 max-w-md mx-auto" style={{ color: 'hsl(var(--muted-foreground))' }}>
          {description}
        </p>
      )}
      <a href={PRICING_URL} target="_blank" rel="noopener"
         className="inline-flex items-center gap-1.5 text-sm font-medium px-4 py-2 rounded-lg"
         style={{
           background: 'hsl(var(--primary))',
           color: 'white',
         }}>
        Upgrade to {TIER_LABEL[requires]}
        <ArrowUpRight className="h-4 w-4" />
      </a>
      <p className="text-xs mt-3" style={{ color: 'hsl(var(--muted-foreground))' }}>
        Or paste an existing license key under Settings → License.
      </p>
    </div>
  )
}
