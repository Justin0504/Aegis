'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { CheckCircle, XCircle, Clock, Shield, AlertTriangle } from 'lucide-react'

const BORDER = 'hsl(36 12% 88%)'
const MUTED  = 'hsl(30 8% 55%)'
const TEXT   = 'hsl(30 10% 15%)'

const RISK_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  CRITICAL: { bg: 'hsl(0 10% 96%)',  text: 'hsl(0 14% 42%)',  border: 'hsl(0 10% 82%)' },
  HIGH:     { bg: 'hsl(25 12% 96%)', text: 'hsl(25 18% 40%)', border: 'hsl(25 12% 82%)' },
  MEDIUM:   { bg: 'hsl(36 12% 96%)', text: 'hsl(36 18% 40%)', border: 'hsl(36 12% 82%)' },
  LOW:      { bg: 'hsl(150 10% 96%)',text: 'hsl(150 14% 38%)',border: 'hsl(150 10% 82%)' },
}

const CATEGORY_ICON: Record<string, string> = {
  database: '🗄',
  file:     '📄',
  network:  '🌐',
  shell:    '💻',
  communication: '✉️',
  data:     '📊',
  unknown:  '❓',
}

function timeAgo(ts: string) {
  const diff = Date.now() - new Date(ts).getTime()
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  return `${Math.round(diff / 3_600_000)}h ago`
}

export function PendingChecks() {
  const queryClient = useQueryClient()
  const [deciding, setDeciding] = useState<Record<string, 'allowing' | 'blocking'>>({})

  const { data, isLoading } = useQuery({
    queryKey: ['pending-checks'],
    queryFn: async () => {
      const res = await fetch('/api/gateway/check/pending')
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    refetchInterval: 3_000,
  })

  const checks: any[] = data?.checks ?? []

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
          <div key={i} className="h-20 rounded-lg animate-pulse" style={{ background: 'hsl(36 14% 91%)' }} />
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
        const catIcon = CATEGORY_ICON[check.category] ?? '❓'

        return (
          <div
            key={check.check_id}
            className="rounded-lg border p-4"
            style={{ borderColor: rc.border, background: rc.bg }}
          >
            <div className="flex items-start justify-between gap-4">
              {/* Left: tool info */}
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm">{catIcon}</span>
                  <span className="text-sm font-semibold" style={{ color: TEXT }}>
                    {check.tool_name}
                  </span>
                  <span
                    className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                    style={{ background: `${rc.text}18`, color: rc.text }}
                  >
                    {check.risk_level}
                  </span>
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{ background: 'hsl(36 14% 90%)', color: MUTED }}
                  >
                    {check.category}
                  </span>
                </div>

                {/* Violations / signals */}
                {check.violations?.length > 0 && (
                  <div className="flex items-start gap-1.5">
                    <AlertTriangle className="h-3 w-3 flex-shrink-0 mt-0.5" style={{ color: rc.text }} />
                    <p className="text-xs" style={{ color: rc.text }}>
                      {check.violations[0]}
                    </p>
                  </div>
                )}

                {/* Arguments preview */}
                {check.arguments && Object.keys(check.arguments).length > 0 && (
                  <pre
                    className="text-[10px] rounded px-2 py-1 max-h-16 overflow-hidden"
                    style={{ background: 'hsl(36 14% 93%)', color: MUTED }}
                  >
                    {JSON.stringify(check.arguments, null, 2).slice(0, 200)}
                  </pre>
                )}

                <div className="flex items-center gap-3 text-[10px]" style={{ color: MUTED }}>
                  <span className="flex items-center gap-1">
                    <Clock className="h-2.5 w-2.5" />
                    {timeAgo(check.created_at)}
                  </span>
                  <span>agent: {String(check.agent_id).substring(0, 10)}…</span>
                  <span>id: {check.check_id.substring(0, 8)}…</span>
                </div>
              </div>

              {/* Right: action buttons */}
              <div className="flex flex-col gap-2 flex-shrink-0">
                <button
                  onClick={() => decide(check.check_id, 'allow')}
                  disabled={!!loading}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md font-medium transition-colors disabled:opacity-40"
                  style={{ background: 'hsl(150 14% 45% / 0.68)', color: '#fff' }}
                >
                  <CheckCircle className="h-3.5 w-3.5" />
                  {loading === 'allowing' ? '…' : 'Allow'}
                </button>
                <button
                  onClick={() => decide(check.check_id, 'block')}
                  disabled={!!loading}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border font-medium transition-colors disabled:opacity-40"
                  style={{ borderColor: 'hsl(0 10% 82%)', color: 'hsl(0 14% 46%)', background: '#fff' }}
                >
                  <XCircle className="h-3.5 w-3.5" />
                  {loading === 'blocking' ? '…' : 'Block'}
                </button>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
