'use client'

/**
 * useLicenseTier — reactive read of the operator's paid tier.
 *
 * Source of truth: the license row cached in localStorage under
 * `aegis:license` (written by the Settings → License panel after
 * a successful validate against aegistraces.com/api/desktop/
 * validate-license). See components/settings/license-panel.tsx.
 *
 * Free tier is the default — no license, no chip, no upgrade
 * needed. Any paid tier unlocks the corresponding features.
 *
 * Emits changes when the license panel dispatches
 * `aegis-license-change` (see license-panel.tsx). No polling.
 */

import { useEffect, useState } from 'react'
import { readLicense, type LicenseState } from '@/components/settings/license-panel'

export type Tier = 'free' | 'pro' | 'team' | 'enterprise'

const TIER_RANK: Record<Tier, number> = {
  free:       0,
  pro:        1,
  team:       2,
  enterprise: 3,
}

/** True if the operator's current tier meets or exceeds `required`. */
export function hasTier(current: Tier, required: Tier): boolean {
  return TIER_RANK[current] >= TIER_RANK[required]
}

/** Human label for chips + upsell copy. Mirrors marketing pricing. */
export const TIER_LABEL: Record<Tier, string> = {
  free:       'Free',
  pro:        'Pro',
  team:       'Team',
  enterprise: 'Enterprise',
}

/** Normalize whatever the backend returned into our tier enum. New
 *  builds should prefer the explicit `tier` field on the license
 *  payload; legacy `plan` fallback keeps older cached licenses
 *  working. Any unrecognised value falls back to 'free' so a data-
 *  shape drift can't accidentally unlock paid features. */
function normalize(plan: string | undefined): Tier {
  const p = (plan ?? '').toLowerCase()
  if (p === 'pro' || p === 'team' || p === 'enterprise') return p
  return 'free'
}

export function useLicenseTier(): {
  tier: Tier
  license: LicenseState | null
  isPaid: boolean
} {
  const [license, setLicense] = useState<LicenseState | null>(null)

  useEffect(() => {
    setLicense(readLicense())
    const handler = () => setLicense(readLicense())
    window.addEventListener('aegis-license-change', handler)
    return () => window.removeEventListener('aegis-license-change', handler)
  }, [])

  // Prefer the new explicit `tier` field on the license (v2 API);
  // fall back to `plan` for compatibility with pre-v2 cached licenses.
  const tier = license?.valid
    ? normalize((license as any).tier ?? license.plan)
    : 'free'
  return { tier, license, isPaid: tier !== 'free' }
}
