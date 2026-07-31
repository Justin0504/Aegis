'use client'

/**
 * Upsell banner on Overview for Free-tier operators.
 *
 * Shows on the Dashboard for Free users only — a soft nudge listing
 * the three highest-value locked features + a link to pricing.
 * Dismissable per-session (sessionStorage flag); returns after they
 * open a new browser session or upgrade.
 */

import { useEffect, useState } from 'react'
import { X, ArrowUpRight, Sparkles } from 'lucide-react'
import { useLicenseTier } from '@/hooks/useLicenseTier'

const DISMISS_KEY = 'aegis:upsell-dismissed'

export function UpsellBanner() {
  const { tier } = useLicenseTier()
  const [dismissed, setDismissed] = useState(true)  // start true → avoid flash

  useEffect(() => {
    setDismissed(sessionStorage.getItem(DISMISS_KEY) === '1')
  }, [])

  if (tier !== 'free' || dismissed) return null

  return (
    <div className="rounded-xl p-4 flex items-start gap-3 border"
         style={{
           background: 'hsl(36 45% 95%)',
           borderColor: 'hsl(36 45% 75%)',
         }}>
      <div className="flex-shrink-0 p-2 rounded-lg"
           style={{ background: 'hsl(36 45% 88%)' }}>
        <Sparkles className="h-4 w-4" style={{ color: 'hsl(36 45% 30%)' }} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold mb-0.5"
             style={{ color: 'hsl(36 45% 20%)' }}>
          You're on the Free tier
        </div>
        <div className="text-xs mb-2"
             style={{ color: 'hsl(36 45% 30%)' }}>
          Unlock SSO, multi-agent collusion detection, workflow-aware NL policy compiler,
          and 90-day audit retention. From <strong>$19/month</strong>.
        </div>
        <div className="flex items-center gap-3">
          <a href="https://aegistraces.com/pricing" target="_blank" rel="noopener"
             className="inline-flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded"
             style={{
               background: 'hsl(36 45% 30%)',
               color: 'white',
             }}>
            See plans <ArrowUpRight className="h-3 w-3" />
          </a>
          <a href="/settings" className="text-xs font-medium"
             style={{ color: 'hsl(36 45% 30%)' }}>
            Already paid? Enter your license →
          </a>
        </div>
      </div>

      <button
        aria-label="Dismiss"
        onClick={() => {
          sessionStorage.setItem(DISMISS_KEY, '1')
          setDismissed(true)
        }}
        className="flex-shrink-0 p-1 rounded hover:opacity-70"
        style={{ color: 'hsl(36 45% 30%)' }}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
