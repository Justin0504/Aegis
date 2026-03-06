'use client'

import { useQuery } from '@tanstack/react-query'
import { DollarSign, Cpu, TrendingUp, BarChart2 } from 'lucide-react'

const MUTED  = 'hsl(30 8% 55%)'
const TEXT   = 'hsl(30 10% 15%)'
const BORDER = 'hsl(36 12% 88%)'

// Monochrome palette for model bars
const BAR_COLORS = [
  'hsl(0 0% 35%)',
  'hsl(0 0% 48%)',
  'hsl(0 0% 58%)',
  'hsl(0 0% 68%)',
  'hsl(0 0% 76%)',
  'hsl(0 0% 84%)',
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
  const totalCost   = data?.total_cost_usd    ?? 0
  const totalInput  = data?.total_input_tokens  ?? 0
  const totalOutput = data?.total_output_tokens ?? 0
  const totalTokens = totalInput + totalOutput

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
          <div key={i} className="h-12 rounded-lg animate-pulse" style={{ background: 'hsl(36 14% 91%)' }} />
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
          <div key={label} style={{ border: `1px solid ${BORDER}`, background: '#fff', borderRadius: '10px', padding: '14px 16px' }}>
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
                  <div style={{ height: '6px', background: 'hsl(36 14% 92%)', borderRadius: '3px', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: '3px',
                      transition: 'width 0.4s ease' }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Token breakdown */}
      <div style={{ border: `1px solid ${BORDER}`, borderRadius: '10px', padding: '14px 16px', background: 'hsl(36 14% 98%)' }}>
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
            <div style={{ height: '8px', background: 'hsl(36 14% 91%)', borderRadius: '4px', overflow: 'hidden', display: 'flex' }}>
              <div style={{ height: '100%', width: `${(totalInput / totalTokens) * 100}%`,
                background: 'hsl(0 0% 38%)', transition: 'width 0.4s ease' }} />
              <div style={{ height: '100%', flex: 1, background: 'hsl(0 0% 72%)' }} />
            </div>
            <div className="flex justify-between mt-1">
              <span className="text-[9px]" style={{ color: 'hsl(0 0% 38%)' }}>● Input</span>
              <span className="text-[9px]" style={{ color: 'hsl(0 0% 58%)' }}>Output ●</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
