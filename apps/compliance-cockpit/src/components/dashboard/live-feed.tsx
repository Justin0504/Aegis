'use client'

import { useQuery } from '@tanstack/react-query'
import { useRef, useEffect, useState } from 'react'
import { CheckCircle, AlertCircle, Shield, Clock } from 'lucide-react'
import { traceSummary } from '@/lib/trace-summary'

const TEXT   = 'hsl(30 10% 15%)'
const MUTED  = 'hsl(30 8% 55%)'
const BORDER = 'hsl(36 12% 88%)'

const TOOL_COLORS: Record<string, string> = {
  web_search:   'hsl(210 20% 48%)',
  read_file:    'hsl(270 14% 48%)',
  write_file:   'hsl(270 14% 48%)',
  execute_sql:  'hsl(38 20% 42%)',
  send_request: 'hsl(180 14% 40%)',
}

export function LiveFeed() {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const prevCountRef = useRef(0)

  const { data } = useQuery({
    queryKey: ['live-feed'],
    queryFn: async () => {
      const res = await fetch('/api/gateway/traces?limit=50')
      if (!res.ok) return []
      const d = await res.json()
      return (d.traces ?? []).reverse()  // oldest first
    },
    refetchInterval: 2000,
  })

  const traces: any[] = data ?? []

  // Auto-scroll to bottom when new items arrive
  useEffect(() => {
    if (autoScroll && scrollRef.current && traces.length > prevCountRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
    prevCountRef.current = traces.length
  }, [traces.length, autoScroll])

  function handleScroll() {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40)
  }

  if (traces.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-2" style={{ color: MUTED }}>
        <Shield className="h-8 w-8 opacity-40" />
        <p className="text-sm">Waiting for traces...</p>
        <p className="text-xs">Activity will appear here in real-time</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: 'hsl(150 18% 44%)', boxShadow: '0 0 0 3px hsl(150 18% 44% / 0.2)' }} />
          <span className="text-xs font-medium" style={{ color: 'hsl(150 18% 40%)' }}>Live</span>
        </div>
        <span className="text-[10px]" style={{ color: MUTED }}>{traces.length} events</span>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="rounded-lg border overflow-y-auto font-mono"
        style={{
          background: 'hsl(36 14% 96%)',
          borderColor: BORDER,
          height: 380,
        }}
      >
        <div className="p-3 space-y-0">
          {traces.map((t: any, i: number) => {
            const tool = t.tool_call?.tool_name || 'unknown'
            const hasError = !!t.observation?.error
            const isBlocked = t.approval_status === 'REJECTED'
            const dur = t.observation?.duration_ms
            const ts = new Date(t.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
            const toolColor = TOOL_COLORS[tool] || 'hsl(30 10% 38%)'

            return (
              <div
                key={t.trace_id}
                className="flex items-center gap-2 py-1 px-2 rounded text-[11px] leading-relaxed"
                style={{
                  animation: i >= traces.length - 3 ? 'trace-slide-in 0.3s ease-out' : undefined,
                  background: i % 2 === 0 ? 'transparent' : 'hsl(36 12% 93%)',
                }}
              >
                <span className="flex-shrink-0" style={{ color: 'hsl(30 8% 42%)' }}>{ts}</span>
                {isBlocked ? (
                  <span className="flex-shrink-0 font-bold" style={{ color: 'hsl(0 30% 40%)' }}>BLOCK</span>
                ) : hasError ? (
                  <span className="flex-shrink-0 font-bold" style={{ color: 'hsl(0 25% 42%)' }}>ERROR</span>
                ) : (
                  <span className="flex-shrink-0 font-bold" style={{ color: 'hsl(150 22% 32%)' }}>{'  OK '}</span>
                )}
                <span className="truncate font-medium" style={{ color: TEXT }}>{traceSummary(t)}</span>
                <span className="flex-shrink-0" style={{ color: 'hsl(30 8% 45%)' }}>
                  {(t.agent_id ?? '').substring(0, 10)}
                </span>
                {dur != null && dur > 0 && (
                  <span className="ml-auto flex-shrink-0" style={{ color: 'hsl(30 8% 42%)' }}>{Math.round(dur)}ms</span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {!autoScroll && (
        <button
          onClick={() => { setAutoScroll(true); if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight }}
          className="text-[11px] px-3 py-1 rounded-full"
          style={{ background: 'hsl(38 20% 46% / 0.12)', color: 'hsl(38 20% 42%)' }}
        >
          Scroll to latest
        </button>
      )}
    </div>
  )
}
