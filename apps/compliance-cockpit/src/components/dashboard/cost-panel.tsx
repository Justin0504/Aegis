'use client'

import { useQuery } from '@tanstack/react-query'
import { DollarSign, Cpu, TrendingUp, BarChart2 } from 'lucide-react'
import { ToolIcon } from '@/lib/tool-icons'

const MUTED  = 'hsl(var(--muted-foreground))'
const TEXT   = 'hsl(var(--foreground))'
const BORDER = 'hsl(var(--border))'
// Muted background tints used for inline progress bars + cards.
// Pull from the theme's secondary/muted surface so they auto-flip
// instead of staying beige on dark mode.
const SOFT   = 'hsl(var(--secondary))'
const SOFT_2 = 'hsl(var(--muted))'

// Monochrome palette for model bars. Mid-lightness band (40–82)
// reads on both light and dark backgrounds; the extreme dark end
// would disappear on dark bg, the extreme light end on light bg.
const BAR_COLORS = [
  'hsl(0 0% 42%)',
  'hsl(0 0% 52%)',
  'hsl(0 0% 60%)',
  'hsl(0 0% 68%)',
  'hsl(0 0% 75%)',
  'hsl(0 0% 82%)',
]

function fmt$(n: number) {
  if (n === 0) return '$0.00'
  if (n < 0.0001) return `$${n.toFixed(6)}`
  if (n < 0.01)   return `$${n.toFixed(4)}`
  if (n < 1)      return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

function fmtK(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function CostPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ['cost-stats'],
    queryFn: async () => {
      const res = await fetch('/api/gateway/traces/stats/cost')
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    refetchInterval: 15_000,
  })

  const rows: any[] = data?.by_agent_model ?? []
  const byTool: any[] = data?.by_tool ?? []
  const totalCost   = data?.total_cost_usd    ?? 0
  const totalInput  = data?.total_input_tokens  ?? 0
  const totalOutput = data?.total_output_tokens ?? 0
  const totalTokens = totalInput + totalOutput

  const topTools = byTool.slice(0, 8)
  const maxToolCost = Math.max(...topTools.map((t: any) => t.total_cost_usd ?? 0), 0.000001)
  const totalToolCalls = byTool.reduce((s: number, t: any) => s + (t.trace_count ?? 0), 0)

  // Aggregate by model for the bar chart
  const byModel = Object.values(
    rows.reduce((acc: Record<string, any>, r: any) => {
      const m = r.model || 'unknown'
      if (!acc[m]) acc[m] = { model: m, cost: 0, tokens: 0 }
      acc[m].cost   += r.total_cost_usd ?? 0
      acc[m].tokens += (r.total_input_tokens ?? 0) + (r.total_output_tokens ?? 0)
      return acc
    }, {})
  ).sort((a: any, b: any) => b.cost - a.cost)

  const maxCost = Math.max(...byModel.map((m: any) => m.cost), 0.000001)

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-12 rounded-lg animate-pulse" style={{ background: 'hsl(var(--secondary))' }} />
        ))}
      </div>
    )
  }

  if (totalCost === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-2" style={{ color: MUTED }}>
        <DollarSign className="h-8 w-8 opacity-40" />
        <p className="text-sm">No token cost data yet.</p>
        <p className="text-xs">Token usage is captured automatically from Anthropic / OpenAI responses.</p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* Top stats */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Total Spend',    value: fmt$(totalCost),         icon: DollarSign,  color: 'hsl(0 0% 42%)' },
          { label: 'Total Tokens',   value: fmtK(totalTokens),       icon: Cpu,         color: 'hsl(0 0% 42%)' },
          { label: 'Avg per Trace',  value: fmt$(totalCost / Math.max(rows.reduce((s: number, r: any) => s + (r.trace_count ?? 0), 0), 1)),
            icon: TrendingUp, color: 'hsl(0 0% 42%)' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} style={{ border: `1px solid ${BORDER}`, background: 'hsl(var(--card))', borderRadius: '10px', padding: '14px 16px' }}>
            <div className="flex items-center gap-2 mb-1">
              <Icon className="h-3.5 w-3.5" style={{ color }} />
              <span className="text-[11px] font-medium" style={{ color: MUTED }}>{label}</span>
            </div>
            <div className="text-xl font-bold" style={{ color: TEXT }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Cost by model */}
      {byModel.length > 0 && (
        <div>
          <p className="text-xs font-semibold mb-3" style={{ color: MUTED }}>Cost by Model</p>
          <div className="space-y-2.5">
            {byModel.map((m: any, i: number) => {
              const pct = (m.cost / maxCost) * 100
              const color = BAR_COLORS[i % BAR_COLORS.length]
              return (
                <div key={m.model}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-mono truncate max-w-[200px]" style={{ color: TEXT }}>
                      {m.model}
                    </span>
                    <div className="flex items-center gap-3 text-xs" style={{ color: MUTED }}>
                      <span>{fmtK(m.tokens)} tok</span>
                      <span className="font-semibold" style={{ color: TEXT }}>{fmt$(m.cost)}</span>
                    </div>
                  </div>
                  <div style={{ height: '6px', background: SOFT_2, borderRadius: '3px', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: '3px',
                      transition: 'width 0.4s ease' }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Cost by tool (brand). Answers "which downstream services are
          my agents actually spending inference on?" — the model view
          above answers "which LLM vendor is billing me". Different
          questions; keep both. */}
      {topTools.length > 0 && (
        <div>
          <div className="flex items-baseline justify-between mb-3">
            <p className="text-xs font-semibold" style={{ color: MUTED }}>Cost by Tool</p>
            <p className="text-[10px]" style={{ color: MUTED }}>
              {fmtK(totalToolCalls)} calls across {byTool.length} tool{byTool.length === 1 ? '' : 's'}
            </p>
          </div>
          <div className="space-y-2">
            {topTools.map((t: any) => {
              const cost = t.total_cost_usd ?? 0
              const pct  = (cost / maxToolCost) * 100
              const name = t.tool_name ?? '(unknown)'
              return (
                <div key={name}
                  style={{ border: `1px solid ${BORDER}`, borderRadius: 8, padding: '9px 12px',
                           background: 'hsl(var(--card))' }}
                  className="flex items-center gap-3">
                  <ToolIcon name={name} size={22} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-xs font-mono truncate" style={{ color: TEXT }} title={name}>
                        {name}
                      </span>
                      <div className="flex items-center gap-3 text-[11px]" style={{ color: MUTED }}>
                        <span>{fmtK(t.trace_count ?? 0)} calls</span>
                        <span className="font-semibold tabular-nums" style={{ color: TEXT }}>{fmt$(cost)}</span>
                      </div>
                    </div>
                    <div style={{ height: 4, background: SOFT_2, borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: 'hsl(0 0% 52%)',
                                    borderRadius: 2, transition: 'width 0.4s ease' }} />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
          {byTool.length > topTools.length && (
            <p className="text-[10px] mt-2" style={{ color: MUTED }}>
              + {byTool.length - topTools.length} more tools not shown
            </p>
          )}
        </div>
      )}

      {/* Token breakdown */}
      <div style={{ border: `1px solid ${BORDER}`, borderRadius: '10px', padding: '14px 16px', background: SOFT }}>
        <p className="text-[11px] font-semibold mb-3" style={{ color: MUTED }}>Token Breakdown</p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-[10px]" style={{ color: MUTED }}>Input tokens</p>
            <p className="text-sm font-bold" style={{ color: TEXT }}>{fmtK(totalInput)}</p>
          </div>
          <div>
            <p className="text-[10px]" style={{ color: MUTED }}>Output tokens</p>
            <p className="text-sm font-bold" style={{ color: TEXT }}>{fmtK(totalOutput)}</p>
          </div>
        </div>
        {totalTokens > 0 && (
          <div className="mt-3">
            <div style={{ height: '8px', background: SOFT_2, borderRadius: '4px', overflow: 'hidden', display: 'flex' }}>
              <div style={{ height: '100%', width: `${(totalInput / totalTokens) * 100}%`,
                background: 'hsl(0 0% 48%)', transition: 'width 0.4s ease' }} />
              <div style={{ height: '100%', flex: 1, background: 'hsl(0 0% 72%)' }} />
            </div>
            <div className="flex justify-between mt-1">
              <span className="text-[9px]" style={{ color: 'hsl(0 0% 48%)' }}>● Input</span>
              <span className="text-[9px]" style={{ color: 'hsl(0 0% 60%)' }}>Output ●</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
