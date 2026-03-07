'use client'

import { useQuery } from '@tanstack/react-query'
import { formatDate, getStatusColor } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { traceSummary } from '@/lib/trace-summary'

export function RecentTraces() {
  const { data: traces, isLoading } = useQuery({
    queryKey: ['recent-traces'],
    queryFn: async () => {
      const response = await fetch('/api/gateway/traces?limit=5')
      if (!response.ok) throw new Error('Failed to fetch traces')
      return response.json()
    },
    refetchInterval: 5000, // Refresh every 5 seconds
  })

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading traces...</div>
  }

  return (
    <div className="space-y-4">
      {traces?.traces?.map((trace: any) => (
        <div key={trace.trace_id} className="flex items-center space-x-4">
          <div className="flex-1 space-y-1">
            <p className="text-sm font-medium leading-none">
              {traceSummary(trace)}
            </p>
            <p className="text-xs text-muted-foreground">
              {(trace.agent_id ?? '').substring(0, 8)}… • {formatDate(trace.timestamp)}
            </p>
          </div>
          <Badge className={getStatusColor(trace.approval_status || 'PENDING')}>
            {trace.approval_status || 'PENDING'}
          </Badge>
        </div>
      ))}
      {(!traces?.traces || traces.traces.length === 0) && (
        <p className="text-sm text-muted-foreground">No traces yet</p>
      )}
    </div>
  )
}