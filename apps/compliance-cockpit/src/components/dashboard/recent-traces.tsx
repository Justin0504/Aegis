'use client'

import { useQuery } from '@tanstack/react-query'
import { formatDate, getStatusColor } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { traceSummary } from '@/lib/trace-summary'
import { describeActivity } from '@/lib/activity-description'
import { ToolIcon } from '@/lib/tool-icons'
import { friendlyAgent, friendlyDecision } from '@/lib/friendly-names'
import { USE_MOCK, mockTraces } from '@/lib/mock-traces'
import { SkeletonRows } from '@/components/ui/skeleton'

export function RecentTraces() {
  const { data: liveTraces, isLoading } = useQuery({
    enabled: !USE_MOCK,
    queryKey: ['recent-traces'],
    queryFn: async () => {
      const response = await fetch('/api/gateway/traces?limit=5')
      if (!response.ok) throw new Error('Failed to fetch traces')
      return response.json()
    },
    refetchInterval: 5000,
  })
  const traces = USE_MOCK ? { traces: mockTraces().slice(0, 5) } : liveTraces

  if (isLoading) {
    return <SkeletonRows count={5} rowHeight={36} />
  }

  return (
    <div className="space-y-4">
      {traces?.traces?.map((trace: any) => (
        <div key={trace.trace_id} className="flex items-center space-x-4">
          <ToolIcon name={describeActivity(trace).iconKey ?? trace.tool_call?.tool_name} size={22} />
          <div className="flex-1 min-w-0 space-y-1">
            <p className="text-sm font-medium leading-snug truncate">
              {describeActivity(trace).text || traceSummary(trace)}
            </p>
            <p className="text-xs text-muted-foreground">
              {friendlyAgent(trace.agent_id)} · {formatDate(trace.timestamp)}
            </p>
          </div>
          {(() => {
            const d = friendlyDecision(trace.decision, !!trace.observation?.error)
            const c = { allow: ['hsl(152 60% 30%)', 'hsl(152 60% 36% / 0.10)'], block: ['hsl(0 72% 42%)', 'hsl(0 72% 50% / 0.10)'],
                        review: ['hsl(32 95% 36%)', 'hsl(36 100% 50% / 0.13)'], error: ['hsl(0 0% 40%)', 'hsl(var(--secondary))'] }[d.tone]
            return <span className="rounded-full px-2.5 py-1 text-[11.5px] font-medium flex-shrink-0" style={{ color: c[0], background: c[1] }}>{d.label}</span>
          })()}
        </div>
      ))}
      {(!traces?.traces || traces.traces.length === 0) && (
        <p className="text-sm text-muted-foreground">No traces yet</p>
      )}
    </div>
  )
}