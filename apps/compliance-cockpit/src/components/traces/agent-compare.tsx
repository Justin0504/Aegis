'use client'

import { useMemo, useState } from 'react'
import { CheckCircle, AlertCircle, Clock, Zap, BarChart2 } from 'lucide-react'

const BORDER = 'hsl(36 12% 88%)'
const MUTED  = 'hsl(30 8% 55%)'
const TEXT   = 'hsl(30 10% 15%)'
const GOLD   = 'hsl(38 20% 42%)'

interface AgentStats {
  agentId: string
  traceCount: number
  errorCount: number
  errorRate: number
  avgLatency: number
  p95Latency: number
  toolBreakdown: Record<string, number>
  totalDuration: number
  firstSeen: Date
  lastSeen: Date
}

function computeStats(traces: any[]): AgentStats[] {
  const byAgent: Record<string, any[]> = {}
  for (const t of traces) {
    if (!t.agent_id) continue
    if (!byAgent[t.agent_id]) byAgent[t.agent_id] = []
    byAgent[t.agent_id].push(t)
  }

  return Object.entries(byAgent).map(([agentId, ts]) => {
    const errors = ts.filter(t => t.observation?.error).length
    const withDur = ts.filter(t => t.observation?.duration_ms !== undefined)
    const durs = withDur.map(t => t.observation.duration_ms).sort((a, b) => a - b)
    const avgLatency = durs.length ? Math.round(durs.reduce((s, d) => s + d, 0) / durs.length) : 0
    const p95Latency = durs.length ? Math.round(durs[Math.floor(durs.length * 0.95)] ?? durs[durs.length - 1]) : 0

    const toolBreakdown: Record<string, number> = {}
    for (const t of ts) {
      const tool = t.tool_call?.tool_name || 'unknown'
      toolBreakdown[tool] = (toolBreakdown[tool] || 0) + 1
    }

    const timestamps = ts.map(t => new Date(t.timestamp).getTime()).filter(Boolean)

    return {
      agentId,
      traceCount: ts.length,
      errorCount: errors,
      errorRate: ts.length > 0 ? Math.round((errors / ts.length) * 100) : 0,
      avgLatency,
      p95Latency,
      toolBreakdown,
      totalDuration: durs.reduce((s, d) => s + d, 0),
      firstSeen: new Date(Math.min(...timestamps)),
      lastSeen:  new Date(Math.max(...timestamps)),
    }
  }).sort((a, b) => b.traceCount - a.traceCount)
}

function StatCell({ value, label, isWinner, isLoser }: { value: string; label: string; isWinner?: boolean; isLoser?: boolean }) {
  return (
    <div className="text-center py-2">
      <p
        className="text-base font-bold"
        style={{ color: isWinner ? 'hsl(150 18% 38%)' : isLoser ? 'hsl(0 14% 46%)' : TEXT }}
      >
        {value}
        {isWinner && <span className="ml-1 text-xs">↑</span>}
        {isLoser  && <span className="ml-1 text-xs">↓</span>}
      </p>
      <p className="text-[10px]" style={{ color: MUTED }}>{label}</p>
    </div>
  )
}

interface AgentCompareProps {
  traces: any[]
}

export function AgentCompare({ traces }: AgentCompareProps) {
  const allStats = useMemo(() => computeStats(traces), [traces])
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  // Default: top 3
  const candidates = allStats.slice(0, 6)
  const comparing  = selectedIds.length >= 2
    ? allStats.filter(s => selectedIds.includes(s.agentId))
    : allStats.slice(0, Math.min(3, allStats.length))

  if (allStats.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm" style={{ color: MUTED }}>
        No agent data to compare
      </div>
    )
  }

  function toggleAgent(id: string) {
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    )
  }

  // Find best/worst for each metric
  const best = {
    errorRate:   Math.min(...comparing.map(s => s.errorRate)),
    avgLatency:  Math.min(...comparing.map(s => s.avgLatency)),
    traceCount:  Math.max(...comparing.map(s => s.traceCount)),
  }
  const worst = {
    errorRate:   Math.max(...comparing.map(s => s.errorRate)),
    avgLatency:  Math.max(...comparing.map(s => s.avgLatency)),
    traceCount:  Math.min(...comparing.map(s => s.traceCount)),
  }

  return (
    <div className="space-y-4">
      {/* Agent selector */}
      {candidates.length > 2 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: MUTED }}>
            Select agents to compare (or leave blank for top 3)
          </p>
          <div className="flex flex-wrap gap-2">
            {candidates.map(s => (
              <button
                key={s.agentId}
                onClick={() => toggleAgent(s.agentId)}
                className="text-xs px-2.5 py-1 rounded-md border transition-colors"
                style={{
                  borderColor: selectedIds.includes(s.agentId) ? GOLD : BORDER,
                  color:       selectedIds.includes(s.agentId) ? GOLD : MUTED,
                  background:  selectedIds.includes(s.agentId) ? 'hsl(38 20% 46% / 0.08)' : '#fff',
                }}
              >
                {s.agentId.substring(0, 8)}… <span style={{ color: MUTED }}>({s.traceCount})</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Comparison table */}
      <div className="rounded-lg border overflow-hidden" style={{ borderColor: BORDER }}>
        {/* Header row */}
        <div
          className="grid border-b"
          style={{
            gridTemplateColumns: `160px repeat(${comparing.length}, 1fr)`,
            borderColor: BORDER,
            background: 'hsl(36 14% 97%)',
          }}
        >
          <div className="px-3 py-2.5" />
          {comparing.map(s => (
            <div key={s.agentId} className="px-3 py-2.5 text-center border-l" style={{ borderColor: BORDER }}>
              <p className="text-xs font-semibold" style={{ color: TEXT }}>
                {s.agentId.substring(0, 8)}…
              </p>
              <p className="text-[10px]" style={{ color: MUTED }}>
                {s.lastSeen.toLocaleDateString()}
              </p>
            </div>
          ))}
        </div>

        {/* Metric rows */}
        {[
          {
            label: 'Total Traces',
            icon: BarChart2,
            render: (s: AgentStats) => (
              <StatCell
                value={String(s.traceCount)}
                label="traces"
                isWinner={comparing.length > 1 && s.traceCount === best.traceCount}
                isLoser ={comparing.length > 1 && s.traceCount === worst.traceCount && best.traceCount !== worst.traceCount}
              />
            ),
          },
          {
            label: 'Error Rate',
            icon: AlertCircle,
            render: (s: AgentStats) => (
              <StatCell
                value={`${s.errorRate}%`}
                label={`${s.errorCount} errors`}
                isWinner={comparing.length > 1 && s.errorRate === best.errorRate}
                isLoser ={comparing.length > 1 && s.errorRate === worst.errorRate && best.errorRate !== worst.errorRate}
              />
            ),
          },
          {
            label: 'Avg Latency',
            icon: Clock,
            render: (s: AgentStats) => (
              <StatCell
                value={s.avgLatency > 0 ? `${s.avgLatency}ms` : '—'}
                label="average"
                isWinner={comparing.length > 1 && s.avgLatency > 0 && s.avgLatency === best.avgLatency}
                isLoser ={comparing.length > 1 && s.avgLatency === worst.avgLatency && best.avgLatency !== worst.avgLatency}
              />
            ),
          },
          {
            label: 'P95 Latency',
            icon: Zap,
            render: (s: AgentStats) => (
              <StatCell value={s.p95Latency > 0 ? `${s.p95Latency}ms` : '—'} label="p95" />
            ),
          },
          {
            label: 'Success Rate',
            icon: CheckCircle,
            render: (s: AgentStats) => (
              <StatCell value={`${100 - s.errorRate}%`} label="successful" />
            ),
          },
        ].map(({ label, icon: Icon, render }) => (
          <div
            key={label}
            className="grid border-b last:border-b-0"
            style={{ gridTemplateColumns: `160px repeat(${comparing.length}, 1fr)`, borderColor: BORDER }}
          >
            <div className="flex items-center gap-2 px-3 py-2" style={{ background: 'hsl(36 14% 97%)' }}>
              <Icon className="h-3.5 w-3.5 flex-shrink-0" style={{ color: MUTED }} />
              <span className="text-xs font-medium" style={{ color: TEXT }}>{label}</span>
            </div>
            {comparing.map(s => (
              <div key={s.agentId} className="border-l" style={{ borderColor: BORDER }}>
                {render(s)}
              </div>
            ))}
          </div>
        ))}

        {/* Tool breakdown row */}
        <div
          className="grid"
          style={{ gridTemplateColumns: `160px repeat(${comparing.length}, 1fr)` }}
        >
          <div className="flex items-center gap-2 px-3 py-3" style={{ background: 'hsl(36 14% 97%)' }}>
            <Zap className="h-3.5 w-3.5 flex-shrink-0" style={{ color: MUTED }} />
            <span className="text-xs font-medium" style={{ color: TEXT }}>Tools Used</span>
          </div>
          {comparing.map(s => (
            <div key={s.agentId} className="border-l px-3 py-3 space-y-1" style={{ borderColor: BORDER }}>
              {Object.entries(s.toolBreakdown)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 4)
                .map(([tool, count]) => (
                  <div key={tool} className="flex items-center justify-between gap-2">
                    <span className="text-[11px] truncate" style={{ color: MUTED }}>{tool}</span>
                    <span className="text-[11px] font-medium flex-shrink-0" style={{ color: TEXT }}>{count}</span>
                  </div>
                ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
