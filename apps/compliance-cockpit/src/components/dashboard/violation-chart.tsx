'use client'

import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Cell, ResponsiveContainer,
} from 'recharts'

const RISK_COLOR: Record<string, { bar: string; bg: string; label: string }> = {
  CRITICAL: { bar: 'hsl(0 0% 28%)',  bg: 'hsl(0 0% 28% / 0.10)',  label: 'hsl(0 0% 35%)'  },
  HIGH:     { bar: 'hsl(0 0% 42%)',  bg: 'hsl(0 0% 42% / 0.10)',  label: 'hsl(0 0% 48%)' },
  MEDIUM:   { bar: 'hsl(0 0% 58%)',  bg: 'hsl(0 0% 58% / 0.10)',  label: 'hsl(0 0% 62%)' },
  LOW:      { bar: 'hsl(0 0% 72%)',  bg: 'hsl(0 0% 72% / 0.10)',  label: 'hsl(0 0% 75%)' },
}

interface ViolationEntry {
  policy: string
  count: number
  risk: string
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const { risk, count } = payload[0].payload
  const c = RISK_COLOR[risk] || RISK_COLOR.LOW
  return (
    <div style={{
      background: '#ffffff',
      border: `1px solid ${c.bar}40`,
      borderRadius: 8,
      padding: '10px 14px',
      minWidth: 140,
    }}>
      <p style={{ color: 'hsl(0 0% 75%)', fontSize: 12, marginBottom: 4 }}>{label}</p>
      <p style={{ color: c.label, fontSize: 22, fontWeight: 700, lineHeight: 1 }}>{count}</p>
      <p style={{
        color: c.label, fontSize: 10, fontWeight: 600,
        letterSpacing: '0.1em', marginTop: 4,
        background: c.bg, padding: '2px 6px', borderRadius: 4, display: 'inline-block',
      }}>{risk}</p>
    </div>
  )
}

export function ViolationChart() {
  const { data } = useQuery<ViolationEntry[]>({
    queryKey: ['violation-stats'],
    queryFn: async () => {
      const res = await fetch('/api/gateway/traces?limit=500')
      if (!res.ok) return []
      const json = await res.json()
      const traces = json.traces || []

      // Aggregate violations by tool category / risk level
      const map: Record<string, { count: number; risk: string }> = {}
      for (const t of traces) {
        const sv = t.safety_validation
        if (!sv || sv.passed !== false) continue
        const key = sv.policy_name || t.tool_call?.tool_name || 'Unknown'
        const risk = sv.risk_level || 'LOW'
        if (!map[key]) map[key] = { count: 0, risk }
        map[key].count++
        // Keep highest risk level seen
        const order = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
        if (order.indexOf(risk) > order.indexOf(map[key].risk)) map[key].risk = risk
      }

      return Object.entries(map)
        .map(([policy, { count, risk }]) => ({ policy, count, risk }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8)
    },
    refetchInterval: 15_000,
  })

  if (!data?.length) {
    return (
      <div className="flex items-center justify-center h-[280px]" style={{ color: 'hsl(30 8% 55%)' }}>
        <p className="text-sm">No violations recorded yet</p>
      </div>
    )
  }

  return (
    <div>
      {/* Risk legend */}
      <div className="flex items-center gap-4 mb-5 px-1">
        {Object.entries(RISK_COLOR).map(([level, c]) => (
          <div key={level} className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full" style={{ background: c.bar }} />
            <span style={{ color: 'hsl(0 0% 40%)', fontSize: 11, fontWeight: 600, letterSpacing: '0.08em' }}>
              {level}
            </span>
          </div>
        ))}
      </div>

      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={data} barSize={36} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid
            vertical={false}
            strokeDasharray="0"
            stroke="hsl(0 0% 14%)"
          />
          <XAxis
            dataKey="policy"
            tick={{ fill: 'hsl(30 8% 46%)', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: 'hsl(30 8% 46%)', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip content={<CustomTooltip />} cursor={{ fill: 'hsl(0 0% 100% / 0.03)' }} />
          <Bar dataKey="count" radius={[4, 4, 0, 0]}>
            {data?.map((entry, i) => {
              const c = RISK_COLOR[entry.risk] || RISK_COLOR.LOW
              return <Cell key={i} fill={c.bar} fillOpacity={0.85} />
            })}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
