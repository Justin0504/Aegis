'use client'

/**
 * License-key panel for Settings.
 *
 * The desktop app / self-hosted gateway is free-tier by default.
 * Paid features unlock when the operator pastes a valid license key
 * issued after purchase on aegistraces.com/pricing.
 *
 * We validate against the marketing site's public endpoint
 *   POST https://aegistraces.com/api/desktop/validate-license
 * so the key check works without a running Supabase project on the
 * operator's side. In dev, you can override the endpoint via the
 * `NEXT_PUBLIC_AEGIS_LICENSE_ENDPOINT` env var (points to your local
 * astro dev server).
 *
 * The last-known-good validation is persisted to localStorage so a
 * paid user doesn't need to be online at every launch — reappears
 * in the header chip on next boot even if the marketing site is
 * unreachable (offline-tolerant, still expires when the key does).
 */

import { useEffect, useState } from 'react'
import { Loader2, CheckCircle, XCircle, ExternalLink, KeyRound, CreditCard } from 'lucide-react'

const MUTED = 'hsl(var(--muted-foreground))'
const TEXT  = 'hsl(var(--foreground))'
const OK    = 'hsl(150 30% 40%)'
const BAD   = 'hsl(0 42% 40%)'

const LICENSE_ENDPOINT =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_AEGIS_LICENSE_ENDPOINT) ||
  'https://aegistraces.com/api/desktop/validate-license'

const STORAGE_KEY = 'aegis:license'

export interface LicenseState {
  key: string
  valid: boolean
  plan?: string
  email?: string
  expires_at?: string | null
  issued_at?: string | null
  subscription_id?: string | null
  last_validated_at: string
  error?: string
}

export function readLicense(): LicenseState | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as LicenseState
  } catch { return null }
}

function writeLicense(state: LicenseState | null): void {
  if (typeof window === 'undefined') return
  if (!state) { localStorage.removeItem(STORAGE_KEY); return }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  // Custom event so the header chip (or any other consumer) can
  // re-render without a full page reload.
  window.dispatchEvent(new CustomEvent('aegis-license-change', { detail: state }))
}

export function LicensePanel() {
  const [state, setState] = useState<LicenseState | null>(null)
  const [input, setInput] = useState('')
  const [validating, setValidating] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    const cached = readLicense()
    if (cached) {
      setState(cached)
      setInput(cached.key)
    }
  }, [])

  async function validate() {
    const key = input.trim()
    if (!key.startsWith('AEGIS-')) {
      setMessage({ ok: false, text: 'License keys start with AEGIS-' })
      return
    }
    setValidating(true)
    setMessage(null)
    try {
      const res = await fetch(LICENSE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ license_key: key }),
      })
      const body = await res.json() as any

      if (!body.valid) {
        const next: LicenseState = {
          key,
          valid: false,
          last_validated_at: new Date().toISOString(),
          error: body.error || `HTTP ${res.status}`,
        }
        writeLicense(next)
        setState(next)
        setMessage({ ok: false, text: body.error || 'validation failed' })
        return
      }

      const next: LicenseState = {
        key,
        valid: true,
        plan: body.plan,
        email: body.email,
        expires_at: body.expires_at,
        issued_at: body.issued_at,
        subscription_id: body.subscription_id,
        last_validated_at: new Date().toISOString(),
      }
      writeLicense(next)
      setState(next)

      // Hand the license off to the local gateway. Without this,
      // requireFeature() on the server side still returns 403 for
      // paid features because the gateway process only knows about
      // AEGIS_LICENSE_TIER env — Cockpit's localStorage alone
      // doesn't reach it. Best-effort: a gateway that's offline
      // won't kill activation (UI still gates locally); the next
      // gateway boot will pick up the persisted key via
      // /api/v1/license/status flow.
      fetch('/api/gateway/license/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ license_key: key }),
      }).catch(() => { /* gateway may be down; UI gate still works */ })

      setMessage({ ok: true, text: `${body.plan.toUpperCase()} tier active — signed in as ${body.email ?? 'unknown'}` })
    } catch (err) {
      setMessage({ ok: false, text: `Network error: ${(err as Error).message}` })
    } finally {
      setValidating(false)
    }
  }

  function clearLicense() {
    writeLicense(null)
    setState(null)
    setInput('')
    // Also tell the gateway to forget — otherwise a stale key would
    // keep unlocking paid API routes even after the UI shows Free.
    fetch('/api/gateway/license/deactivate', { method: 'POST' }).catch(() => {})
    setMessage({ ok: true, text: 'License removed' })
  }

  const activeChip = state?.valid ? (
    <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded"
          style={{ background: 'hsl(150 30% 92%)', color: OK }}>
      <CheckCircle className="h-3.5 w-3.5" />
      {state.plan?.toUpperCase()} tier · {state.email ?? '—'}
    </span>
  ) : state ? (
    <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded"
          style={{ background: 'hsl(0 28% 92%)', color: BAD }}>
      <XCircle className="h-3.5 w-3.5" />
      Invalid · {state.error ?? 'not activated'}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded"
          style={{ background: 'hsl(0 0% 94%)', color: MUTED }}>
      Free tier
    </span>
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm" style={{ color: MUTED }}>
          Paid features (SSO, custom detectors, longer retention, priority support)
          unlock when you paste a license key issued after purchase on{' '}
          <a href="https://aegistraces.com/pricing" target="_blank" rel="noopener"
             className="inline-flex items-center gap-1 underline">
            aegistraces.com/pricing <ExternalLink className="h-3 w-3" />
          </a>.
        </div>
        {activeChip}
      </div>

      <div className="flex gap-2 items-start">
        <div className="flex-1 min-w-0">
          <label className="text-xs font-medium block mb-1" style={{ color: TEXT }}>
            License key
          </label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <KeyRound className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4"
                        style={{ color: MUTED }} />
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="AEGIS-PRO-…"
                className="w-full pl-8 pr-3 py-2 text-sm rounded border font-mono"
                style={{ borderColor: 'hsl(var(--border))', background: 'hsl(var(--card))', color: TEXT }}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <button onClick={validate} disabled={validating || !input.trim()}
              className="text-sm px-3 py-2 rounded font-medium"
              style={{
                background: 'hsl(var(--primary))', color: 'white',
                opacity: (validating || !input.trim()) ? 0.5 : 1,
              }}>
              {validating
                ? (<><Loader2 className="h-4 w-4 inline mr-1 animate-spin" /> Validating</>)
                : 'Validate'}
            </button>
            {state && (
              <button onClick={clearLicense}
                className="text-sm px-3 py-2 rounded border"
                style={{ borderColor: 'hsl(var(--border))', color: MUTED }}>
                Remove
              </button>
            )}
          </div>
        </div>
      </div>

      {message && (
        <div className="text-xs p-2 rounded"
          style={{
            background: message.ok ? 'hsl(150 30% 95%)' : 'hsl(0 28% 95%)',
            color: message.ok ? OK : BAD,
            border: `1px solid ${message.ok ? 'hsl(150 30% 82%)' : 'hsl(0 28% 82%)'}`,
          }}>
          {message.text}
        </div>
      )}

      {state?.valid && state.expires_at && (
        <div className="text-xs" style={{ color: MUTED }}>
          Expires {new Date(state.expires_at).toISOString().slice(0, 10)}
          {state.subscription_id && (
            <> · subscription <code className="font-mono">{state.subscription_id}</code></>
          )}
        </div>
      )}

      {/* Manage subscription — opens Stripe's billing portal so the
          customer can update card, download invoices, cancel, or
          switch plan without our team touching anything. Requires an
          active license (there's no subscription to manage otherwise)
          AND the marketing site to know the Stripe customer, which
          it does once a purchase has completed on this account. */}
      {state?.valid && (
        <div className="pt-1">
          <a
            href="https://aegistraces.com/api/stripe/portal"
            target="_blank"
            rel="noopener"
            onClick={async (e) => {
              // Try to fetch the portal URL server-side + open it in
              // a new tab. Fall back to the raw href (which will
              // 401 → the marketing site will bounce to /login) if
              // the fetch fails. Prevents an ugly redirect chain
              // when the user is already signed in.
              e.preventDefault()
              try {
                const res = await fetch('https://aegistraces.com/api/stripe/portal', {
                  method: 'POST',
                  credentials: 'include',
                })
                const body = await res.json()
                if (res.ok && body.url) {
                  window.open(body.url, '_blank', 'noopener')
                } else {
                  window.open(`https://aegistraces.com/login?next=${encodeURIComponent('/account')}`, '_blank')
                }
              } catch {
                window.open('https://aegistraces.com/account', '_blank')
              }
            }}
            className="text-xs inline-flex items-center gap-1 underline"
            style={{ color: MUTED }}
          >
            <CreditCard className="h-3 w-3" />
            Manage subscription <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}
    </div>
  )
}
