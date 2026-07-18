'use client'

import { useEffect, useState } from 'react'
import { Shield, ShieldAlert, Link2 } from 'lucide-react'
import { gw } from '@/lib/gateway'
import { USE_MOCK, mockTotalActions, mockPendingChecks, mockViolations, mockAgents } from '@/lib/mock-traces'
import { readLicense, type LicenseState } from '@/components/settings/license-panel'

const BORDER  = 'hsl(var(--border))'
const TEXT    = 'hsl(var(--foreground))'
const MUTED   = 'hsl(var(--muted-foreground))'
const BG      = 'hsl(var(--background))'
const OK      = 'hsl(150 22% 38%)'   // moss, matches /welcome decision color
const ALERT   = 'hsl(0 50% 38%)'     // oxblood
const PENDING = 'hsl(36 60% 32%)'    // mustard

interface Stats {
  totalTraces: number
  pendingChecks: number
  violations24h: number
  activeAgents: number
  tracesTrend: number
}

interface IntegritySummary {
  total: number
  ok: number
  broken: number
}

export function StatusBar() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [reachable, setReachable] = useState(true)
  const [integrity, setIntegrity] = useState<IntegritySummary | null>(null)
  const [license, setLicense] = useState<LicenseState | null>(null)

  // Re-read license from localStorage on mount + whenever the settings
  // panel dispatches an update event. Cheap enough to just re-read.
  useEffect(() => {
    setLicense(readLicense())
    const handler = () => setLicense(readLicense())
    window.addEventListener('aegis-license-change', handler)
    return () => window.removeEventListener('aegis-license-change', handler)
  }, [])

  useEffect(() => {
    if (USE_MOCK) {
      setStats({
        totalTraces:   mockTotalActions(),
        pendingChecks: mockPendingChecks().length,
        violations24h: mockViolations().length,
        activeAgents:  mockAgents().filter(a => a.status === 'active').length,
        tracesTrend:   12,
      })
      setReachable(true)
      return
    }
    let cancelled = false
    const tick = async () => {
      try {
        const res = await gw('stats')
        if (cancelled) return
        if (!res.ok) {
          setReachable(false)
          return
        }
        const data = await res.json()
        setStats(data)
        setReachable(true)
      } catch {
        if (!cancelled) setReachable(false)
      }
    }
    tick()
    const id = setInterval(tick, 10_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // Integrity bulk-verify is heavier than /stats (full chain walk over
  // every agent's history) — poll on a much slower cadence. 60s is a
  // sweet spot: short enough that a Cockpit watcher sees a breach
  // within a minute, long enough that a 50-agent deployment doesn't
  // burn CPU on every dashboard tick.
  useEffect(() => {
    if (USE_MOCK) {
      const totalAgents = mockAgents().length
      setIntegrity({ total: totalAgents, ok: totalAgents, broken: 0 })
      return
    }
    let cancelled = false
    const tick = async () => {
      try {
        const res = await gw('integrity/verify-all')
        if (cancelled) return
        if (!res.ok) return
        const data = await res.json()
        setIntegrity({
          total: data.total_agents ?? 0,
          ok: data.ok_agents ?? 0,
          broken: data.broken_agents ?? 0,
        })
      } catch {
        /* leave previous value sticky on transient failures */
      }
    }
    tick()
    const id = setInterval(tick, 60_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  const protectionOn = reachable && stats !== null
  const blocked = stats?.violations24h ?? 0
  const pending = stats?.pendingChecks ?? 0
  const traces  = stats?.totalTraces ?? 0
  const agents  = stats?.activeAgents ?? 0

  return (
    <div
      className="flex items-center gap-4 px-4 py-1.5 text-xs flex-wrap"
      style={{
        background: BG,
        borderBottom: `1px solid ${BORDER}`,
        color: MUTED,
      }}
    >
      <span className="inline-flex items-center gap-1.5" style={{ color: protectionOn ? OK : ALERT }}>
        {protectionOn ? (
          <Shield className="h-3.5 w-3.5" />
        ) : (
          <ShieldAlert className="h-3.5 w-3.5" />
        )}
        <span className="font-medium">
          {protectionOn ? 'Protected' : 'Gateway unreachable'}
        </span>
      </span>

      {protectionOn && (
        <>
          <span className="opacity-50">·</span>
          <Stat label="traces" value={fmt(traces)} />

          <span className="opacity-50">·</span>
          <Stat label="agents (24h)" value={fmt(agents)} />

          <span className="opacity-50">·</span>
          <Stat
            label="blocked (24h)"
            value={fmt(blocked)}
            tint={blocked > 0 ? ALERT : MUTED}
          />

          {pending > 0 && (
            <>
              <span className="opacity-50">·</span>
              <Stat
                label="pending"
                value={fmt(pending)}
                tint={PENDING}
              />
            </>
          )}

          {integrity && integrity.total > 0 && (
            <>
              <span className="opacity-50">·</span>
              <a
                href="/audit-log"
                className="inline-flex items-baseline gap-1 hover:underline"
                title="Open /audit-log to drill in"
                style={{ color: 'inherit' }}
              >
                <Link2
                  className="h-3 w-3 self-center -mt-0.5"
                  style={{ color: integrity.broken === 0 ? OK : ALERT }}
                />
                <span
                  className="font-medium tabular-nums"
                  style={{ color: integrity.broken === 0 ? OK : ALERT }}
                >
                  {integrity.ok}/{integrity.total}
                </span>
                <span style={{ color: MUTED }}>chains</span>
              </a>
            </>
          )}
        </>
      )}

      <span className="opacity-50 ml-auto hidden sm:inline">·</span>
      <a href="/settings" className="hidden sm:inline-flex items-center gap-1 text-xs"
         title={license?.valid ? `Signed in as ${license.email ?? 'unknown'}` : 'Activate a license on aegistraces.com'}
         style={{
           padding: '2px 8px', borderRadius: 4,
           background: license?.valid ? 'hsl(150 30% 92%)' : 'hsl(0 0% 94%)',
           color: license?.valid ? OK : MUTED,
           textDecoration: 'none',
         }}>
        {license?.valid ? `${license.plan?.toUpperCase()} · ${license.email ?? '—'}` : 'Free tier'}
      </a>
      <span className="opacity-50 hidden sm:inline">·</span>
      <span className="hidden sm:inline" style={{ color: MUTED, opacity: 0.7 }}>
        live · refresh 10s
      </span>
    </div>
  )
}

function Stat({ label, value, tint }: { label: string; value: string; tint?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span style={{ color: tint ?? TEXT, fontFeatureSettings: '"tnum"' }} className="font-medium">
        {value}
      </span>
      <span style={{ color: MUTED }}>{label}</span>
    </span>
  )
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}
