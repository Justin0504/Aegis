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
import { Zap, Code2 } from 'lucide-react'

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

        <div className="rounded-lg border p-6 mb-6" style={{ borderColor: BORDER, background: SURFACE }}>
          <div className="text-xs font-semibold tracking-widest uppercase mb-3" style={{ color: MUTED }}>
            Step 1 · License
          </div>
          <LicensePanel />
        </div>

        <div className="text-xs font-semibold tracking-widest uppercase mb-3" style={{ color: MUTED }}>
          Step 2 · Choose your integration path
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
          <PathCard
            icon={<Zap className="h-5 w-5" />}
            title="Zero-code (recommended)"
            body="Install a root cert and route your OS proxy through AEGIS. Every agent on this machine — Claude Code, Cursor, custom — gets traced. Two admin prompts, five minutes."
            cta="Open proxy setup"
            onClick={() => router.push('/proxy')}
          />
          <PathCard
            icon={<Code2 className="h-5 w-5" />}
            title="SDK"
            body="Wrap your agent client with one line of code. Full observability including LLM prompt context and per-agent attribution. Best for CI/CD-managed agents."
            cta="Open Welcome guide"
            onClick={() => router.push('/welcome')}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <Link href="https://aegistraces.com/pricing" target="_blank" rel="noopener"
                className="text-xs underline" style={{ color: MUTED }}>
            Don't have a key? See pricing →
          </Link>
          <button
            onClick={() => router.push('/')}
            className="text-xs px-3 py-2 rounded-md"
            style={{ color: MUTED, border: `1px solid ${BORDER}` }}>
            Skip — open Cockpit
          </button>
        </div>

        <p className="mt-10 text-center text-xs" style={{ color: MUTED }}>
          AEGIS gateway is running on <code className="font-mono">localhost:18080</code>.
          {licenseValid ? ` License: ${readLicense()?.plan?.toUpperCase() ?? 'active'}.` : ''}
        </p>
      </div>
    </div>
  )
}

function PathCard({
  icon, title, body, cta, onClick,
}: {
  icon: React.ReactNode; title: string; body: string; cta: string; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="text-left rounded-lg border p-5 hover:border-current transition-colors"
      style={{
        background: 'hsl(var(--card))',
        borderColor: 'hsl(var(--border))',
        color: 'hsl(var(--foreground))',
      }}>
      <div className="flex items-center gap-2 mb-2">
        <span style={{ color: 'hsl(var(--primary))' }}>{icon}</span>
        <div className="font-medium text-sm">{title}</div>
      </div>
      <p className="text-xs mb-3" style={{ color: 'hsl(var(--muted-foreground))' }}>
        {body}
      </p>
      <div className="text-xs font-medium" style={{ color: 'hsl(var(--primary))' }}>
        {cta} →
      </div>
    </button>
  )
}
