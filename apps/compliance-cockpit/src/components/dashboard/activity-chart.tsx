'use client'

import { useQuery } from '@tanstack/react-query'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import { USE_MOCK, mockHourlyBuckets } from '@/lib/mock-traces'

const BORDER = 'hsl(var(--border))'
const MUTED  = 'hsl(var(--muted-foreground))'
const TEXT   = 'hsl(var(--foreground))'

const COLOR_ACTIONS = 'hsl(22 22% 24%)'   // espresso — total
const COLOR_BLOCKED = 'hsl(0 45% 38%)'    // soft red — blocked

interface HourBucket {
  hour: number          // 0-23 representing hours-ago bucket
  label: string         // 'HH:00'
  actions: number       // all decisions counted
  blocked: number       // subset that ended up BLOCK / error
}

/** Fetch raw traces and bucket them into 24 hourly bins. */
function useActivity24h(): { data: HourBucket[]; isLoading: boolean } {
  // Hooks must run unconditionally — call always, ignore result in mock mode.
  const q = useQuery({
    enabled: !USE_MOCK,
    queryKey: ['dashboard', 'activity-24h'],
    queryFn: async () => {
      // Larger limit so we get enough coverage over 24h. Gateway caps
      // at 1000 per page — going higher returns an empty list, so we
      // stay at the cap. (At ~120 traces/hr a 24h window fits.)
      const res = await fetch('/api/gateway/traces?limit=1000')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      return (data.traces || []) as any[]
    },
    refetchInterval: 30_000,
    staleTime: 25_000,
  })

  // Mock mode short-circuit — deterministic shape, no backend needed.
  if (USE_MOCK) return { data: mockHourlyBuckets(), isLoading: false }

  // Build 24 buckets, indexed from oldest (23h ago) to newest (now).
  const buckets: HourBucket[] = []
  const nowHour = Math.floor(Date.now() / 3_600_000)
  for (let i = 23; i >= 0; i--) {
    const ts = (nowHour - i) * 3_600_000
    const d = new Date(ts)
    buckets.push({
      hour: i,
      label: d.toLocaleTimeString('en-US', { hour: '2-digit', hour12: false }),
      actions: 0,
      blocked: 0,
    })
  }

  for (const t of q.data ?? []) {
    const ts = t.timestamp ? Date.parse(t.timestamp) : NaN
    if (!Number.isFinite(ts)) continue
    const tsHour = Math.floor(ts / 3_600_000)
    const idx = 23 - (nowHour - tsHour)
    if (idx < 0 || idx > 23) continue
    buckets[idx].actions += 1
    const decision = (t.decision || '').toLowerCase()
    const hasError = !!t.observation?.error
    if (decision === 'block' || hasError) buckets[idx].blocked += 1
  }

  return { data: buckets, isLoading: q.isLoading }
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const actions = payload.find((p: any) => p.dataKey === 'actions')?.value ?? 0
  const blocked = payload.find((p: any) => p.dataKey === 'blocked')?.value ?? 0
  return (
    <div style={{
      background: 'hsl(var(--card))',
      border: `1px solid ${BORDER}`,
      borderRadius: 8,
      padding: '8px 12px',
      fontSize: 12,
      color: TEXT,
      minWidth: 120,
      boxShadow: '0 4px 16px hsl(0 0% 0% / 0.06)',
    }}>
      <p style={{ color: MUTED, fontSize: 11, marginBottom: 4 }}>{label}:00</p>
      <p style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
        <span style={{ color: COLOR_ACTIONS }}>● actions</span>
        <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{actions}</span>
      </p>
      {blocked > 0 && (
        <p style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginTop: 2 }}>
          <span style={{ color: COLOR_BLOCKED }}>● blocked</span>
          <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{blocked}</span>
        </p>
      )}
    </div>
  )
}

export function ActivityChart() {
  const { data, isLoading } = useActivity24h()
  const totalActions = data.reduce((s, b) => s + b.actions, 0)
  const totalBlocked = data.reduce((s, b) => s + b.blocked, 0)

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-sm font-semibold" style={{ color: TEXT }}>Activity · last 24h</h3>
        <div className="text-xs tabular-nums" style={{ color: MUTED }}>
          <span>{totalActions.toLocaleString()} actions</span>
          {totalBlocked > 0 && (
            <span style={{ color: COLOR_BLOCKED, marginLeft: 10 }}>
              {totalBlocked} blocked
            </span>
          )}
        </div>
      </div>
      <div style={{ width: '100%', height: 220 }}>
        {isLoading && data.every(b => b.actions === 0) ? (
          <div className="h-full flex items-center justify-center text-xs" style={{ color: MUTED }}>
            Loading…
          </div>
        ) : (
          <ResponsiveContainer>
            <ComposedChart data={data} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={BORDER} strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="label"
                stroke={MUTED}
                fontSize={10}
                tickLine={false}
                axisLine={false}
                interval={3}
              />
              <YAxis
                stroke={MUTED}
                fontSize={10}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
                width={36}
              />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: 'hsl(var(--sidebar-active))', opacity: 0.4 }} />
              <Bar dataKey="blocked" fill={COLOR_BLOCKED} radius={[2, 2, 0, 0]} maxBarSize={14} />
              <Line
                type="monotone"
                dataKey="actions"
                stroke={COLOR_ACTIONS}
                strokeWidth={1.8}
                dot={false}
                activeDot={{ r: 3, fill: COLOR_ACTIONS }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}

/** Export a typed pair (actions[], blocked[]) for the stat cards' sparklines. */
export function useSparklineSeries(): { actions: number[]; blocked: number[]; isLoading: boolean } {
  const { data, isLoading } = useActivity24h()
  return {
    actions: data.map(b => b.actions),
    blocked: data.map(b => b.blocked),
    isLoading,
  }
}
