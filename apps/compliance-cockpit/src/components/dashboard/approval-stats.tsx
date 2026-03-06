'use client'

import { useQuery } from '@tanstack/react-query'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts'

const SEGMENTS = [
  { key: 'Auto-Approved', color: 'hsl(220 22% 44%)', bg: 'hsl(220 22% 44% / 0.10)' },
  { key: 'Approved',      color: 'hsl(160 18% 46%)', bg: 'hsl(160 18% 46% / 0.10)' },
  { key: 'Pending',       color: 'hsl(36  28% 52%)', bg: 'hsl(36  28% 52% / 0.10)' },
  { key: 'Rejected',      color: 'hsl(355 18% 54%)', bg: 'hsl(355 18% 54% / 0.10)' },
]

const MOCK = [
  { name: 'Auto-Approved', value: 456 },
  { name: 'Approved',      value: 234 },
  { name: 'Pending',       value: 12  },
  { name: 'Rejected',      value: 45  },
]

function CustomTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const { name, value } = payload[0].payload
  const seg = SEGMENTS.find(s => s.key === name)
  return (
    <div style={{
      background: '#ffffff',
      border: `1px solid ${seg?.color ?? '#fff'}30`,
      borderRadius: 8,
      padding: '8px 14px',
    }}>
      <p style={{ color: 'hsl(0 0% 55%)', fontSize: 11, marginBottom: 2 }}>{name}</p>
      <p style={{ color: seg?.color, fontSize: 20, fontWeight: 700, lineHeight: 1 }}>{value.toLocaleString()}</p>
    </div>
  )
}

export function ApprovalStats() {
  const { data = MOCK } = useQuery({
    queryKey: ['approval-stats'],
    queryFn: async () => MOCK,
  })

  const total = data.reduce((s, d) => s + d.value, 0)
  const autoApproved = data.find(d => d.name === 'Auto-Approved')?.value ?? 0
  const approved     = data.find(d => d.name === 'Approved')?.value ?? 0
  const rejected     = data.find(d => d.name === 'Rejected')?.value ?? 0
  const pending      = data.find(d => d.name === 'Pending')?.value ?? 0
  const approvalRate = total ? (((autoApproved + approved) / total) * 100).toFixed(1) : '0'

  return (
    <div className="flex items-center gap-8">
      {/* Donut */}
      <div className="relative flex-shrink-0" style={{ width: 180, height: 180 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={58}
              outerRadius={82}
              paddingAngle={2}
              dataKey="value"
              strokeWidth={0}
            >
              {data.map((entry, i) => {
                const seg = SEGMENTS.find(s => s.key === entry.name)
                return <Cell key={i} fill={seg?.color ?? '#888'} />
              })}
            </Pie>
            <Tooltip content={<CustomTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        {/* Center label */}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span style={{ color: 'hsl(220 22% 40%)', fontSize: 26, fontWeight: 700, lineHeight: 1, letterSpacing: '-0.04em' }}>
            {approvalRate}%
          </span>
          <span style={{ color: 'hsl(0 0% 38%)', fontSize: 10, fontWeight: 500, letterSpacing: '0.06em', marginTop: 2 }}>
            APPROVED
          </span>
        </div>
      </div>

      {/* Stats */}
      <div className="flex-1 space-y-2.5">
        {SEGMENTS.map(seg => {
          const item = data.find(d => d.name === seg.key)
          const val  = item?.value ?? 0
          const pct  = total ? Math.round((val / total) * 100) : 0
          return (
            <div key={seg.key}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full" style={{ background: seg.color }} />
                  <span style={{ color: 'hsl(0 0% 55%)', fontSize: 12 }}>{seg.key}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span style={{ color: seg.color, fontSize: 13, fontWeight: 600 }}>{val.toLocaleString()}</span>
                  <span style={{ color: 'hsl(0 0% 30%)', fontSize: 11 }}>{pct}%</span>
                </div>
              </div>
              {/* Progress bar */}
              <div className="h-1 rounded-full overflow-hidden" style={{ background: 'hsl(36 12% 91%)' }}>
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{ width: `${pct}%`, background: seg.color, opacity: 0.8 }}
                />
              </div>
            </div>
          )
        })}

        {/* Footer metrics */}
        <div className="flex items-center gap-4 pt-2" style={{ borderTop: '1px solid hsl(0 0% 14%)' }}>
          <div>
            <p style={{ color: 'hsl(0 0% 35%)', fontSize: 10, letterSpacing: '0.08em' }}>AVG RESPONSE</p>
            <p style={{ color: 'hsl(0 0% 75%)', fontSize: 13, fontWeight: 600 }}>2.5 min</p>
          </div>
          <div>
            <p style={{ color: 'hsl(0 0% 35%)', fontSize: 10, letterSpacing: '0.08em' }}>PENDING CRITICAL</p>
            <p style={{ color: 'hsl(355 18% 50%)', fontSize: 13, fontWeight: 600 }}>3</p>
          </div>
          <div>
            <p style={{ color: 'hsl(0 0% 35%)', fontSize: 10, letterSpacing: '0.08em' }}>TOTAL</p>
            <p style={{ color: 'hsl(0 0% 75%)', fontSize: 13, fontWeight: 600 }}>{total.toLocaleString()}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
