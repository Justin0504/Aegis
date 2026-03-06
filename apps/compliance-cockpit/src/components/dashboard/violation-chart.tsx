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

const MOCK_DATA = [
  { policy: 'SQL Injection',     count: 12, risk: 'HIGH'     },
  { policy: 'File Access',       count: 23, risk: 'MEDIUM'   },
  { policy: 'Network Access',    count: 8,  risk: 'MEDIUM'   },
  { policy: 'Command Injection', count: 5,  risk: 'CRITICAL' },
  { policy: 'Data Exposure',     count: 15, risk: 'HIGH'     },
]

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

function CustomXAxisTick({ x, y, payload }: any) {
  const item = MOCK_DATA.find(d => d.policy === payload.value)
  const c = RISK_COLOR[item?.risk || 'LOW']
  return (
    <text x={x} y={y + 12} textAnchor="middle" style={{ fontSize: 11, fill: 'hsl(30 8% 46%)' }}>
      {payload.value}
    </text>
  )
}

export function ViolationChart() {
  const { data } = useQuery({
    queryKey: ['violation-stats'],
    queryFn: async () => MOCK_DATA,
  })

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
            tick={<CustomXAxisTick />}
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
