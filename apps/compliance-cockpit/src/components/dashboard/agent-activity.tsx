'use client'

import { useQuery } from '@tanstack/react-query'
import { CheckCircle, AlertCircle, ShieldAlert, Hourglass } from 'lucide-react'
import { ToolIcon } from '@/lib/tool-icons'
import { describeActivity } from '@/lib/activity-description'
import { EmailAvatar } from '@/lib/avatar'
import { USE_MOCK, mockTraces } from '@/lib/mock-traces'

export function AgentActivity() {
  const { data, isLoading } = useQuery({
    enabled: !USE_MOCK,
    queryKey: ['agent-activity-real'],
    queryFn: async () => {
      const res = await fetch('/api/gateway/traces?limit=50')
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    staleTime: 0,
  })

  const traces: any[] = USE_MOCK ? mockTraces() : (data?.traces || [])

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-9 rounded animate-pulse" style={{ background: 'hsl(var(--secondary))' }} />
        ))}
      </div>
    )
  }

  if (traces.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
        No activity yet
      </div>
    )
  }

  return (
    <div className="space-y-1 overflow-y-auto max-h-72">
      {traces.slice(0, 20).map((trace: any) => {
        const rich = describeActivity(trace)
        const hasError = !!trace.observation?.error
        const decision = String(trace.decision ?? '').toUpperCase()
        const blocked = decision === 'BLOCK'
        const held = decision === 'PENDING'
        const durationMs = trace.observation?.duration_ms

        return (
          <div
            key={trace.trace_id}
            className="flex items-center gap-3 px-3 py-2 rounded-md transition-colors"
            style={{ background: 'hsl(var(--secondary))' }}
          >
            {/* Tool badge — brand icon driven by rich.iconKey when available */}
            <ToolIcon name={rich.iconKey ?? trace.tool_call?.tool_name ?? 'unknown'} size={22} />

            {/* Plain-English description */}
            <span className="flex-1 text-[12.5px] truncate" style={{ color: 'hsl(var(--foreground))' }}>
              {rich.text}
            </span>

            {/* Recipient avatar (email path only) */}
            {rich.recipientEmail && (
              <EmailAvatar email={rich.recipientEmail} size={20} />
            )}

            {/* Duration — only when defined */}
            {typeof durationMs === 'number' && Number.isFinite(durationMs) && (
              <span className="text-[11px] flex-shrink-0 tabular-nums" style={{ color: 'hsl(0 0% 56%)' }}>
                {durationMs < 1 ? '<1ms' : `${Math.round(durationMs)}ms`}
              </span>
            )}

            {/* Status */}
            <div className="flex-shrink-0">
              {blocked
                ? <ShieldAlert className="h-3.5 w-3.5" style={{ color: 'hsl(0 45% 45%)' }} />
                : held
                  ? <Hourglass className="h-3.5 w-3.5" style={{ color: 'hsl(32 95% 40%)' }} />
                : hasError
                  ? <AlertCircle className="h-3.5 w-3.5" style={{ color: 'hsl(0 18% 50%)' }} />
                  : <CheckCircle className="h-3.5 w-3.5" style={{ color: 'hsl(150 18% 44%)' }} />}
            </div>
          </div>
        )
      })}
    </div>
  )
}
