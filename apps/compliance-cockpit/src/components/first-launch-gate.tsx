'use client'

/**
 * First-launch gate for the AEGIS desktop app.
 *
 * On very first Tauri boot, if the user has never seen the activation
 * page AND no license is stored yet, redirect to /activate. Runs
 * client-side only (window.__TAURI__ + localStorage checks) so the
 * hosted Cockpit / web-only builds are unaffected.
 *
 * We use sessionStorage (not localStorage) for the "seen" flag so
 * closing and reopening the desktop app doesn't re-prompt the same
 * session, but a fresh boot still shows the gate on Day 2 if the
 * user chose Free tier and later wants to reconsider. The Settings
 * page always shows the LicensePanel, so paid-tier upgrade after
 * the gate is one click away.
 *
 * Guards:
 *   · Skip on /activate itself (would infinite-loop).
 *   · Skip in dev when NEXT_PUBLIC_AEGIS_SKIP_ACTIVATE=1 is set —
 *     lets us dev the dashboard without going through the gate.
 */

import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { readLicense } from '@/components/settings/license-panel'

const SESSION_SEEN_KEY = 'aegis:activate-seen'

export function FirstLaunchGate() {
  const pathname = usePathname()
  const router = useRouter()

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (process.env.NEXT_PUBLIC_AEGIS_SKIP_ACTIVATE === '1') return
    if (pathname === '/activate') return

    const inTauri = !!(window as any).__TAURI__
    if (!inTauri) return

    if (sessionStorage.getItem(SESSION_SEEN_KEY) === '1') return

    const license = readLicense()
    if (license?.valid) return

    sessionStorage.setItem(SESSION_SEEN_KEY, '1')
    router.replace('/activate')
  }, [pathname, router])

  return null
}
