'use client'

import { useQuery } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { CheckCircle, AlertCircle, Globe, FileText, Database, Send, Zap } from 'lucide-react'

const TOOL_ICONS: Record<string, React.ElementType> = {
  web_search:   Globe,
  read_file:    FileText,
  execute_sql:  Database,
  send_request: Send,
}

function ToolIcon({ name }: { name: string }) {
  const Icon = TOOL_ICONS[name] || Zap
  return <Icon className="h-3.5 w-3.5" />
}

const TOOL_COLORS: Record<string, string> = {
  web_search:   'hsl(200 80% 55%)',
  read_file:    'hsl(260 70% 65%)',
  execute_sql:  'hsl(43 80% 55%)',
  send_request: 'hsl(140 60% 50%)',
}

export function AgentActivity() {
  const { data, isLoading } = useQuery({
    queryKey: ['agent-activity-real'],
    queryFn: async () => {
      const res = await fetch('/api/gateway/traces?limit=50')
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    refetchInterval: 5000,
  })

  const traces: any[] = data?.traces || []

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-9 rounded animate-pulse" style={{ background: 'hsl(0 0% 14%)' }} />
        ))}
      </div>
    )
  }

  if (traces.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm" style={{ color: 'hsl(0 0% 40%)' }}>
        No activity yet
      </div>
    )
  }

  return (
    <div className="space-y-1 overflow-y-auto max-h-72">
      {traces.slice(0, 20).map((trace: any) => {
        const toolName = trace.tool_call?.tool_name || 'unknown'
        const color = TOOL_COLORS[toolName] || 'hsl(0 0% 50%)'
        const hasError = !!trace.observation?.error
        const durationMs = trace.observation?.duration_ms
        const prompt = trace.input_context?.prompt || ''

        return (
          <div
            key={trace.trace_id}
            className="flex items-center gap-3 px-3 py-2 rounded-md transition-colors"
            style={{ background: 'hsl(0 0% 12%)' }}
          >
            {/* Tool badge */}
            <div
              className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium flex-shrink-0"
              style={{ background: `${color}18`, color }}
            >
              <ToolIcon name={toolName} />
              <span>{toolName}</span>
            </div>

            {/* Prompt preview */}
            <span className="flex-1 text-xs truncate" style={{ color: 'hsl(0 0% 55%)' }}>
              {String(prompt).slice(0, 60)}
            </span>

            {/* Duration */}
            {durationMs !== undefined && (
              <span className="text-[11px] flex-shrink-0" style={{ color: 'hsl(0 0% 35%)' }}>
                {durationMs < 1 ? '<1ms' : `${Math.round(durationMs)}ms`}
              </span>
            )}

            {/* Status */}
            <div className="flex-shrink-0">
              {hasError
                ? <AlertCircle className="h-3.5 w-3.5" style={{ color: 'hsl(0 62% 50%)' }} />
                : <CheckCircle className="h-3.5 w-3.5" style={{ color: 'hsl(140 60% 45%)' }} />
              }
            </div>
          </div>
        )
      })}
    </div>
  )
}
