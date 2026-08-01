/**
 * First-launch activation gate for the AEGIS desktop app.
 *
 * Users land here on very first boot (root layout redirects when no
 * license is present AND we're running inside Tauri). Presents:
 *
 *   1. Two-line welcome so it doesn't feel like a paywall.
 *   2. The LicensePanel — same component as Settings, so users only
 *      ever learn one form.
 *   3. A "Continue on Free tier" escape hatch, so paid activation is
 *      never blocking. Free tier is a real product; we're not IBM.
 *
 * Route is public: reachable from Settings ("Change license") too.
 */
'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { LicensePanel, readLicense } from '@/components/settings/license-panel'
import { useEffect, useState } from 'react'

const BG      = 'hsl(var(--background))'
const TEXT    = 'hsl(var(--foreground))'
const MUTED   = 'hsl(var(--muted-foreground))'
const SURFACE = 'hsl(var(--card))'
const BORDER  = 'hsl(var(--border))'
const PRIMARY = 'hsl(var(--primary))'

export default function ActivatePage() {
  const router = useRouter()
  const [licenseValid, setLicenseValid] = useState(false)

  useEffect(() => {
    const check = () => setLicenseValid(readLicense()?.valid === true)
    check()
    window.addEventListener('aegis-license-change', check)
    return () => window.removeEventListener('aegis-license-change', check)
  }, [])

  return (
    <div style={{ minHeight: '100vh', background: BG, color: TEXT }}>
      <div className="max-w-2xl mx-auto px-6 py-16">
        <div className="mb-10 text-center">
          <div className="text-xs font-semibold tracking-widest uppercase mb-3" style={{ color: MUTED }}>
            AEGIS · Activation
          </div>
          <h1 className="text-3xl font-serif tracking-tight mb-2" style={{ fontFamily: 'var(--font-serif), Georgia, serif' }}>
            Welcome. Let's get you set up.
          </h1>
          <p className="text-sm" style={{ color: MUTED }}>
            AEGIS runs entirely on your machine. Enter your license key to unlock paid features, or continue on the free tier.
          </p>
        </div>

        <div className="rounded-lg border p-6 mb-4" style={{ borderColor: BORDER, background: SURFACE }}>
          <LicensePanel />
        </div>

        <div className="flex items-center justify-between gap-4 mt-8">
          <Link href="https://aegistraces.com/pricing" target="_blank" rel="noopener"
                className="text-xs underline" style={{ color: MUTED }}>
            Don't have a key? See pricing →
          </Link>
          <button
            onClick={() => router.push('/')}
            className="text-sm px-4 py-2 rounded-md font-medium"
            style={{
              background: licenseValid ? PRIMARY : 'transparent',
              color:      licenseValid ? 'hsl(var(--primary-foreground))' : TEXT,
              border:    `1px solid ${licenseValid ? PRIMARY : BORDER}`,
            }}>
            {licenseValid ? 'Open Cockpit →' : 'Continue on Free tier →'}
          </button>
        </div>

        <p className="mt-10 text-center text-xs" style={{ color: MUTED }}>
          AEGIS gateway is running on <code className="font-mono">localhost:18080</code>.
          Point your agents at that URL — see the{' '}
          <Link href="/welcome" className="underline">Welcome guide</Link> for one-line SDK setup.
        </p>
      </div>
    </div>
  )
}
