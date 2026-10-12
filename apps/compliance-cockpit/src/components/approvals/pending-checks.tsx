'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, useEffect } from 'react'
import { CheckCircle, XCircle, Clock, Shield, AlertTriangle, Database, FileText, Globe, Terminal, Mail, BarChart3, HelpCircle } from 'lucide-react'
import { USE_MOCK, mockPendingChecks, mockTraces } from '@/lib/mock-traces'

const BORDER = 'hsl(var(--border))'
const MUTED  = 'hsl(var(--muted-foreground))'
const TEXT   = 'hsl(var(--foreground))'

// Semantic colour only where it carries meaning: red = will be blocked unless a
// person allows it; amber = held; everything else is ink on paper.
const RISK_COLORS: Record<string, { text: string; bg: string }> = {
  CRITICAL: { text: 'hsl(0 100% 42%)',  bg: 'hsl(0 100% 42% / 0.08)' },
  HIGH:     { text: 'hsl(0 100% 42%)',  bg: 'hsl(0 100% 42% / 0.08)' },
  MEDIUM:   { text: 'hsl(40 100% 33%)', bg: 'hsl(40 100% 33% / 0.10)' },
  LOW:      { text: 'hsl(var(--muted-foreground))', bg: 'hsl(var(--secondary))' },
}
const CATEGORY_ICON: Record<string, typeof Database> = {
  database: Database,
  file:     FileText,
  network:  Globe,
  shell:    Terminal,
  communication: Mail,
  data:     BarChart3,
  unknown:  HelpCircle,
}
function timeAgo(ts: string) {
  const diff = Date.now() - new Date(ts).getTime()
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  return `${Math.round(diff / 3_600_000)}h ago`
}

function LiveTimer({ since }: { since: string }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const diff = Math.max(0, Date.now() - new Date(since).getTime())
  const secs = Math.floor(diff / 1000) % 60
  const mins = Math.floor(diff / 60_000) % 60
  const hrs  = Math.floor(diff / 3_600_000)
  const label = hrs > 0 ? `${hrs}h ${mins}m ${secs}s` : mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
  const isLong = diff > 5 * 60_000 // > 5 min
  return (
    <span
      className="text-[11px] font-mono tabular-nums"
      style={{ color: isLong ? 'hsl(40 100% 33%)' : MUTED }}
    >
      held {label}
    </span>
  )
}

export function PendingChecks() {
  const queryClient = useQueryClient()
  const [deciding, setDeciding] = useState<Record<string, 'allowing' | 'blocking'>>({})

  const { data, isLoading } = useQuery({
    enabled: !USE_MOCK,
    queryKey: ['pending-checks'],
    queryFn: async () => {
      const res = await fetch('/api/gateway/check/pending')
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    refetchInterval: 3_000,
  })

  const checks: any[] = USE_MOCK ? mockPendingChecks() : (data?.checks ?? [])

  async function decide(checkId: string, decision: 'allow' | 'block') {
    setDeciding(prev => ({ ...prev, [checkId]: decision === 'allow' ? 'allowing' : 'blocking' }))
    try {
      await fetch(`/api/gateway/check/${checkId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, decided_by: 'dashboard-user' }),
      })
      queryClient.invalidateQueries({ queryKey: ['pending-checks'] })
    } finally {
      setDeciding(prev => { const n = { ...prev }; delete n[checkId]; return n })
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-20 rounded-lg animate-pulse" style={{ background: 'hsl(var(--secondary))' }} />
        ))}
      </div>
    )
  }

  if (checks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-2" style={{ color: MUTED }}>
        <Shield className="h-7 w-7 opacity-40" />
        <p className="text-sm">No pending checks</p>
        <p className="text-xs">Blocked tool calls will appear here for review</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {checks.map((check: any) => {
        const rc = RISK_COLORS[check.risk_level] ?? RISK_COLORS.MEDIUM
        const loading = deciding[check.check_id]
        const CatIcon = CATEGORY_ICON[check.category] ?? CATEGORY_ICON.unknown
        const args = check.arguments && Object.keys(check.arguments).length > 0
          ? JSON.stringify(check.arguments, null, 2)
          : null

        return (
          <div
            key={check.check_id}
            className="rounded-xl border"
            style={{ borderColor: BORDER, background: 'hsl(var(--card))' }}
          >
            {/* header: what is being asked, and how risky the layers think it is */}
            <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-2">
              <CatIcon className="h-4 w-4 flex-shrink-0" style={{ color: MUTED }} />
              <span className="text-[13px] font-mono font-medium" style={{ color: TEXT }}>
                {check.tool_name}
              </span>
              <span
                className="text-[10px] font-semibold tracking-wide px-1.5 py-[2px] rounded-md"
                style={{ background: rc.bg, color: rc.text }}
              >
                {check.risk_level}
              </span>
              <span className="text-[11px]" style={{ color: MUTED }}>{check.category}</span>
              <span className="ml-auto"><LiveTimer since={check.created_at} /></span>
            </div>

            {/* why it was held */}
            {check.violations?.length > 0 && (
              <p className="px-4 pb-2 text-[13px] leading-snug" style={{ color: TEXT }}>
                {check.violations[0]}
              </p>
            )}

            {/* the call, exactly as the agent emitted it */}
            {args && (
              <pre
                className="mx-4 mb-3 text-[11.5px] leading-[1.5] rounded-lg px-3 py-2.5 max-h-32 overflow-auto"
                style={{ background: 'hsl(var(--secondary))', color: TEXT }}
              >
                {args}
              </pre>
            )}

            {/* footer: provenance + the two decisions */}
            <div
              className="flex items-center gap-3 px-4 py-2.5 border-t"
              style={{ borderColor: BORDER }}
            >
              <span className="text-[11px] font-mono truncate" style={{ color: MUTED }}>
                {String(check.agent_id)} · {check.check_id.substring(0, 8)}
              </span>
              <div className="ml-auto flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={() => decide(check.check_id, 'block')}
                  disabled={!!loading}
                  className="inline-flex items-center gap-1.5 text-[12.5px] font-medium px-3 h-8 rounded-lg border transition-colors hover:bg-[hsl(var(--secondary))] disabled:opacity-40"
                  style={{ borderColor: BORDER, color: TEXT, background: 'hsl(var(--card))' }}
                >
                  <XCircle className="h-3.5 w-3.5" />
                  {loading === 'blocking' ? 'Blocking…' : 'Block'}
                  <kbd className="ml-1 text-[10px] font-mono opacity-50">B</kbd>
                </button>
                <button
                  onClick={() => decide(check.check_id, 'allow')}
                  disabled={!!loading}
                  className="inline-flex items-center gap-1.5 text-[12.5px] font-medium px-3 h-8 rounded-lg transition-opacity hover:opacity-85 disabled:opacity-40"
                  style={{ background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}
                >
                  <CheckCircle className="h-3.5 w-3.5" />
                  {loading === 'allowing' ? 'Allowing…' : 'Allow'}
                  <kbd className="ml-1 text-[10px] font-mono opacity-60">A</kbd>
                </button>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
