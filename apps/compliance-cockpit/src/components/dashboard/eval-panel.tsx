'use client'

import { useQuery } from '@tanstack/react-query'
import { ThumbsUp, ThumbsDown, Star } from 'lucide-react'

const MUTED  = 'hsl(30 8% 55%)'
const TEXT   = 'hsl(30 10% 15%)'
const BORDER = 'hsl(36 12% 88%)'
const GREEN  = 'hsl(0 0% 35%)'
const RED    = 'hsl(0 0% 62%)'

function pct(n: number, total: number) {
  if (!total) return 0
  return Math.round((n / total) * 100)
}

export function EvalPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ['eval-stats'],
    queryFn: async () => {
      const res = await fetch('/api/gateway/traces/stats/eval')
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    refetchInterval: 15_000,
  })

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-12 rounded-lg animate-pulse" style={{ background: 'hsl(36 14% 91%)' }} />
        ))}
      </div>
    )
  }

  const scored     = data?.scored_count  ?? 0
  const thumbsUp   = data?.thumbs_up     ?? 0
  const thumbsDown = data?.thumbs_down   ?? 0
  const byAgent: any[] = data?.by_agent ?? []
  const recent: any[]  = data?.recent_scored ?? []

  if (scored === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-2" style={{ color: MUTED }}>
        <Star className="h-8 w-8 opacity-40" />
        <p className="text-sm">No scored traces yet.</p>
        <p className="text-xs">Open a trace in the Traces view and click 👍 or 👎 to score it.</p>
      </div>
    )
  }

  const upPct   = pct(thumbsUp, scored)
  const downPct = pct(thumbsDown, scored)

  return (
    <div className="space-y-5">
      {/* Summary chips */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Scored',      value: String(scored),               icon: Star,       color: 'hsl(0 0% 40%)' },
          { label: 'Good',        value: `${thumbsUp} (${upPct}%)`,   icon: ThumbsUp,   color: GREEN },
          { label: 'Bad',         value: `${thumbsDown} (${downPct}%)`, icon: ThumbsDown, color: RED },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} style={{ border: `1px solid ${BORDER}`, background: '#fff', borderRadius: '10px', padding: '14px 16px' }}>
            <div className="flex items-center gap-2 mb-1">
              <Icon className="h-3.5 w-3.5" style={{ color }} />
              <span className="text-[11px] font-medium" style={{ color: MUTED }}>{label}</span>
            </div>
            <div className="text-xl font-bold" style={{ color: TEXT }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Score bar */}
      {scored > 0 && (
        <div>
          <p className="text-xs font-semibold mb-2" style={{ color: MUTED }}>Good vs Bad</p>
          <div style={{ height: '10px', background: 'hsl(36 14% 91%)', borderRadius: '5px', overflow: 'hidden', display: 'flex' }}>
            <div style={{ height: '100%', width: `${upPct}%`, background: GREEN, transition: 'width 0.4s ease' }} />
            <div style={{ height: '100%', width: `${downPct}%`, background: RED, transition: 'width 0.4s ease' }} />
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-[9px]" style={{ color: GREEN }}>● Good</span>
            <span className="text-[9px]" style={{ color: RED }}>Bad ●</span>
          </div>
        </div>
      )}

      {/* By agent */}
      {byAgent.length > 0 && (
        <div>
          <p className="text-xs font-semibold mb-3" style={{ color: MUTED }}>Score by Agent</p>
          <div className="space-y-2.5">
            {byAgent.slice(0, 6).map((a: any) => {
              const total = (a.good ?? 0) + (a.bad ?? 0)
              const goodPct = pct(a.good ?? 0, total)
              return (
                <div key={a.agent_id}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-mono truncate max-w-[200px]" style={{ color: TEXT }}>
                      {String(a.agent_id).substring(0, 12)}…
                    </span>
                    <div className="flex items-center gap-3 text-xs" style={{ color: MUTED }}>
                      <span className="flex items-center gap-1">
                        <ThumbsUp className="h-3 w-3" style={{ color: GREEN }} />{a.good ?? 0}
                      </span>
                      <span className="flex items-center gap-1">
                        <ThumbsDown className="h-3 w-3" style={{ color: RED }} />{a.bad ?? 0}
                      </span>
                    </div>
                  </div>
                  <div style={{ height: '6px', background: 'hsl(36 14% 92%)', borderRadius: '3px', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${goodPct}%`, background: GREEN, borderRadius: '3px', transition: 'width 0.4s ease' }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Recent scored traces */}
      {recent.length > 0 && (
        <div>
          <p className="text-xs font-semibold mb-3" style={{ color: MUTED }}>Recently Scored</p>
          <div className="space-y-2">
            {recent.slice(0, 8).map((r: any) => (
              <div key={r.trace_id} className="flex items-center gap-3 py-1.5 border-b" style={{ borderColor: BORDER }}>
                {r.score > 0
                  ? <ThumbsUp className="h-3.5 w-3.5 flex-shrink-0" style={{ color: GREEN }} />
                  : <ThumbsDown className="h-3.5 w-3.5 flex-shrink-0" style={{ color: RED }} />
                }
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium truncate" style={{ color: TEXT }}>
                    {r.tool_call?.tool_name ?? 'unknown'}
                  </p>
                  {r.feedback && (
                    <p className="text-[10px] truncate" style={{ color: MUTED }}>{r.feedback}</p>
                  )}
                </div>
                <span className="text-[10px] flex-shrink-0" style={{ color: MUTED }}>
                  {String(r.agent_id).substring(0, 8)}…
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
