'use client'

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Layers, Clock, AlertCircle, ChevronRight, CheckCircle } from 'lucide-react'
import { traceSummary } from '@/lib/trace-summary'

const TOOL_VERBS: Record<string, string> = {
  web_search: 'Search', read_file: 'Read', write_file: 'Write', delete_file: 'Delete',
  execute_sql: 'Query', run_query: 'Query', send_request: 'Request', run_cmd: 'Shell',
  process_text: 'Process', send_email: 'Email',
}

function sessionFlowLabel(toolNames: string | undefined): string {
  if (!toolNames) return ''
  const tools = toolNames.split(',').filter(Boolean)
  const seen = new Set<string>()
  const steps: string[] = []
  for (const t of tools) {
    const verb = TOOL_VERBS[t] || t.replace(/_/g, ' ')
    if (!seen.has(verb)) { seen.add(verb); steps.push(verb) }
  }
  if (steps.length <= 4) return steps.join(' → ')
  return steps.slice(0, 3).join(' → ') + ` +${steps.length - 3}`
}

const MUTED  = 'hsl(30 8% 55%)'
const TEXT   = 'hsl(30 10% 15%)'
const BORDER = 'hsl(36 12% 88%)'

function fmt$(n: number) {
  if (!n) return '$0.00'
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

function fmtK(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`
  return String(n ?? 0)
}

function fmtDuration(startedAt: string, lastSeenAt: string) {
  const ms = new Date(lastSeenAt).getTime() - new Date(startedAt).getTime()
  if (ms < 60_000)    return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

function timeAgo(ts: string) {
  const diff = Date.now() - new Date(ts).getTime()
  if (diff < 60_000)    return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / 86_400_000)}d ago`
}

function SessionTraces({ sessionId }: { sessionId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['session-traces', sessionId],
    queryFn: async () => {
      const res = await fetch(`/api/gateway/traces?limit=200`)
      if (!res.ok) return []
      const d = await res.json()
      return (d.traces ?? []).filter((t: any) => t.session_id === sessionId)
    },
  })

  if (isLoading) return <div className="py-2 text-[11px]" style={{ color: MUTED }}>Loading...</div>
  const traces: any[] = data ?? []
  if (traces.length === 0) return <div className="py-2 text-[11px]" style={{ color: MUTED }}>No traces found</div>

  return (
    <div className="space-y-1 pt-2">
      {traces.map((t: any, i: number) => {
        const hasError = !!t.observation?.error
        return (
          <div key={t.trace_id} className="flex items-center gap-2 py-1.5 px-2 rounded" style={{ background: 'hsl(36 14% 96%)' }}>
            <span className="text-[10px] font-mono w-4 text-right flex-shrink-0" style={{ color: MUTED }}>{i + 1}</span>
            {hasError
              ? <AlertCircle className="h-3 w-3 flex-shrink-0" style={{ color: 'hsl(0 18% 50%)' }} />
              : <CheckCircle className="h-3 w-3 flex-shrink-0" style={{ color: 'hsl(150 18% 44%)' }} />
            }
            <span className="text-[11px] font-medium truncate" style={{ color: TEXT }}>{traceSummary(t)}</span>
            <span className="text-[10px] ml-auto flex-shrink-0" style={{ color: MUTED }}>{t.observation?.duration_ms ?? 0}ms</span>
          </div>
        )
      })}
    </div>
  )
}

export function SessionsPanel() {
  const [expanded, setExpanded] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['sessions'],
    queryFn: async () => {
      const res = await fetch('/api/gateway/traces/sessions')
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    refetchInterval: 15_000,
  })

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-14 rounded-lg animate-pulse" style={{ background: 'hsl(36 14% 91%)' }} />
        ))}
      </div>
    )
  }

  const sessions: any[] = data?.sessions ?? []

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-2" style={{ color: MUTED }}>
        <Layers className="h-8 w-8 opacity-40" />
        <p className="text-sm">No sessions yet.</p>
        <p className="text-xs">Pass <code className="font-mono">session_id</code> in your SDK config to group traces into sessions.</p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* Summary */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Sessions',     value: String(sessions.length),                    color: 'hsl(0 0% 35%)' },
          { label: 'Total Traces', value: fmtK(sessions.reduce((s: number, x: any) => s + (x.trace_count ?? 0), 0)), color: 'hsl(0 0% 35%)' },
          { label: 'Total Cost',   value: fmt$(sessions.reduce((s: number, x: any) => s + (x.total_cost_usd ?? 0), 0)), color: 'hsl(0 0% 35%)' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ border: `1px solid ${BORDER}`, background: '#fff', borderRadius: '10px', padding: '14px 16px' }}>
            <p className="text-[11px] font-medium mb-1" style={{ color: MUTED }}>{label}</p>
            <p className="text-xl font-bold" style={{ color }}>{value}</p>
          </div>
        ))}
      </div>

      {/* Session list */}
      <div className="space-y-2">
        {sessions.map((s: any) => {
          const dur = fmtDuration(s.started_at, s.last_seen_at)
          const hasErrors = s.error_count > 0
          const isOpen = expanded === s.session_id
          return (
            <div
              key={`${s.session_id}-${s.agent_id}`}
              style={{ border: `1px solid ${isOpen ? 'hsl(38 20% 46% / 0.3)' : BORDER}`, borderRadius: '10px', padding: '12px 14px', background: '#fff', cursor: 'pointer', transition: 'border-color 0.15s' }}
              onClick={() => setExpanded(isOpen ? null : s.session_id)}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-0.5">
                    <ChevronRight
                      className="h-3 w-3 flex-shrink-0 transition-transform duration-150"
                      style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', color: MUTED }}
                    />
                    <span className="text-xs font-medium truncate" style={{ color: TEXT }}>
                      {sessionFlowLabel(s.tool_names) || s.session_id}
                    </span>
                    {hasErrors && (
                      <AlertCircle className="h-3 w-3 flex-shrink-0" style={{ color: 'hsl(0 0% 55%)' }} />
                    )}
                  </div>
                  <p className="text-[10px] ml-5" style={{ color: MUTED }}>
                    {String(s.agent_id ?? '').substring(0, 12)}… · <code className="font-mono">{(s.session_id ?? '').substring(0, 8)}</code>
                  </p>
                </div>
                <div className="text-right flex-shrink-0 space-y-0.5">
                  <p className="text-xs font-medium" style={{ color: TEXT }}>
                    {s.trace_count} traces
                  </p>
                  <p className="text-[10px]" style={{ color: MUTED }}>
                    {timeAgo(s.last_seen_at)}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-4 mt-2 pt-2" style={{ borderTop: `1px solid ${BORDER}` }}>
                <span className="flex items-center gap-1 text-[10px]" style={{ color: MUTED }}>
                  <Clock className="h-2.5 w-2.5" /> {dur}
                </span>
                {s.total_tokens > 0 && (
                  <span className="text-[10px]" style={{ color: MUTED }}>
                    {fmtK(s.total_tokens)} tokens
                  </span>
                )}
                {s.total_cost_usd > 0 && (
                  <span className="text-[10px] font-medium" style={{ color: TEXT }}>
                    {fmt$(s.total_cost_usd)}
                  </span>
                )}
                {hasErrors && (
                  <span className="text-[10px]" style={{ color: 'hsl(0 0% 55%)' }}>
                    {s.error_count} error{s.error_count > 1 ? 's' : ''}
                  </span>
                )}
              </div>
              {isOpen && <SessionTraces sessionId={s.session_id} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}
