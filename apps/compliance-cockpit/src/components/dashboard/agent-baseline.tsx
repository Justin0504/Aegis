'use client'

import { useQuery } from '@tanstack/react-query'
import { gw } from '@/lib/gateway'

const TEXT  = 'hsl(30 10% 15%)'
const MUTED = 'hsl(30 8% 55%)'
const BORDER = 'hsl(36 12% 88%)'

const RISK_COLORS: Record<string, string> = {
  LOW:      'hsl(150 14% 42%)',
  MEDIUM:   'hsl(36 18% 44%)',
  HIGH:     'hsl(25 18% 44%)',
  CRITICAL: 'hsl(0 14% 46%)',
}

interface Props {
  agentId: string
}

export function AgentBaseline({ agentId }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ['agent-baseline', agentId],
    queryFn: async () => {
      const res = await gw(`agents/${agentId}/baseline`)
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    refetchInterval: 60_000,
  })

  if (isLoading) {
    return <div className="h-24 rounded-lg animate-pulse" style={{ background: 'hsl(36 14% 91%)' }} />
  }

  if (!data || data.total === 0) {
    return (
      <div className="rounded-lg p-4 text-xs text-center" style={{ background: 'hsl(36 14% 97%)', color: MUTED, border: `1px solid ${BORDER}` }}>
        No baseline data for <span className="font-mono">{agentId}</span> yet (needs 7 days of traces).
      </div>
    )
  }

  const maxCount = Math.max(...(data.top_tools as any[]).map((t: any) => t.count), 1)

  return (
    <div className="rounded-xl border p-4 space-y-4" style={{ borderColor: BORDER, background: '#fff' }}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold" style={{ color: TEXT }}>Behavior Profile — last 7 days</p>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded" style={{ background: 'hsl(36 14% 94%)', color: MUTED }}>{agentId}</span>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-2">
        {[
          { label: 'Traces',    value: data.total },
          { label: 'Sessions',  value: data.sessions },
          { label: 'PII rate',  value: `${data.pii_rate}%` },
          { label: 'Block rate',value: `${data.block_rate}%` },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-lg p-2.5 text-center" style={{ background: 'hsl(36 14% 95%)' }}>
            <p className="text-[10px] font-semibold uppercase tracking-wider mb-0.5" style={{ color: MUTED }}>{label}</p>
            <p className="text-sm font-bold" style={{ color: TEXT }}>{value}</p>
          </div>
        ))}
      </div>

      {/* Risk distribution */}
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: MUTED }}>Risk Distribution</p>
        <div className="flex items-center gap-1.5">
          {(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const).map(level => {
            const count = data.risk_distribution?.[level] ?? 0
            const pct   = data.total > 0 ? Math.round((count / data.total) * 100) : 0
            return (
              <div key={level} className="flex items-center gap-1">
                <span style={{ fontSize: '10px', color: RISK_COLORS[level], fontWeight: 600 }}>{level[0]}</span>
                <div className="rounded-full" style={{ width: '60px', height: '5px', background: 'hsl(36 14% 90%)' }}>
                  <div className="rounded-full h-full" style={{ width: `${pct}%`, background: RISK_COLORS[level] }} />
                </div>
                <span style={{ fontSize: '10px', color: MUTED }}>{pct}%</span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Top tools */}
      {data.top_tools?.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: MUTED }}>Top Tools</p>
          <div className="space-y-1">
            {(data.top_tools as any[]).slice(0, 5).map((t: any) => (
              <div key={t.tool_name} className="flex items-center gap-2">
                <span className="text-xs font-mono truncate" style={{ color: TEXT, minWidth: '120px', maxWidth: '140px' }}>{t.tool_name}</span>
                <div className="flex-1 rounded-full" style={{ height: '5px', background: 'hsl(36 14% 90%)' }}>
                  <div className="rounded-full h-full" style={{ width: `${Math.round((t.count / maxCount) * 100)}%`, background: 'hsl(38 20% 52%)' }} />
                </div>
                <span className="text-[10px]" style={{ color: MUTED, minWidth: '20px', textAlign: 'right' }}>{t.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
