'use client'

import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Shield } from 'lucide-react'
import { useState, useMemo } from 'react'
import { friendlyAgent } from '@/lib/friendly-names'
import { traceSummary } from '@/lib/trace-summary'
import { ToolIcon } from '@/lib/tool-icons'
import { USE_MOCK, mockViolations } from '@/lib/mock-traces'

const TEXT   = 'hsl(var(--foreground))'
const MUTED  = 'hsl(var(--muted-foreground))'
const BORDER = 'hsl(var(--border))'

const RISK_LEVELS = ['ALL', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const
// OpenAI-platform style: every row uses the same neutral --card surface
// with the same hairline border. Risk severity reads ONLY through the
// small text-color of the label, never through the row background.
const RISK_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  CRITICAL: { bg: 'hsl(var(--card))', border: BORDER, text: 'hsl(var(--status-drift))' },
  HIGH:     { bg: 'hsl(var(--card))', border: BORDER, text: 'hsl(var(--status-drift))' },
  MEDIUM:   { bg: 'hsl(var(--card))', border: BORDER, text: 'hsl(var(--status-attn))' },
  LOW:      { bg: 'hsl(var(--card))', border: BORDER, text: MUTED },
}

export function ViolationsView() {
  const [riskFilter, setRiskFilter] = useState<string>('ALL')
  const [groupByPolicy, setGroupByPolicy] = useState(true)

  const { data, isLoading } = useQuery({
    enabled: !USE_MOCK,
    queryKey: ['violations'],
    queryFn: async () => {
      const res = await fetch('/api/gateway/traces?limit=200')
      if (!res.ok) throw new Error('Failed to fetch traces')
      return res.json()
    },
    refetchInterval: 3000,
  })

  const violations = useMemo(() => {
    const all = USE_MOCK
      ? mockViolations()
      : (data?.traces ?? []).filter(
        (t: any) => t.safety_validation && !t.safety_validation.passed
      )
    if (riskFilter === 'ALL') return all
    return all.filter((t: any) => (t.safety_validation?.risk_level || 'LOW') === riskFilter)
  }, [data, riskFilter])

  // Count per risk level for filter chips
  const riskCounts = useMemo(() => {
    const all = USE_MOCK
      ? mockViolations()
      : (data?.traces ?? []).filter(
        (t: any) => t.safety_validation && !t.safety_validation.passed
      )
    const counts: Record<string, number> = { ALL: all.length, CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }
    for (const t of all) counts[t.safety_validation?.risk_level || 'LOW'] = (counts[t.safety_validation?.risk_level || 'LOW'] || 0) + 1
    return counts
  }, [data])

  // Group by policy name
  const grouped = useMemo(() => {
    if (!groupByPolicy) return { '': violations }
    const groups: Record<string, any[]> = {}
    for (const v of violations) {
      const policy = v.safety_validation?.policy_name || 'Unknown'
      if (!groups[policy]) groups[policy] = []
      groups[policy].push(v)
    }
    return groups
  }, [violations, groupByPolicy])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Violations</h1>
      </div>

      {/* Filter chips + group toggle */}
      <div className="flex items-center gap-2 flex-wrap">
        {RISK_LEVELS.map(level => {
          const count = riskCounts[level] || 0
          const isActive = riskFilter === level
          const rc = level !== 'ALL' ? RISK_COLORS[level] : null
          return (
            <button
              key={level}
              onClick={() => setRiskFilter(level)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all"
              style={{
                background: isActive ? (rc?.text ? `${rc.text}15` : 'hsl(30 10% 15% / 0.08)') : 'transparent',
                color: isActive ? (rc?.text || TEXT) : MUTED,
                border: `1px solid ${isActive ? (rc?.border || 'hsl(30 10% 15% / 0.2)') : BORDER}`,
              }}
            >
              {level === 'ALL' ? 'All' : level}
              <span className="text-[10px] opacity-70">{count}</span>
            </button>
          )
        })}
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-[11px]" style={{ color: MUTED }}>Group by policy</span>
          <button
            onClick={() => setGroupByPolicy(v => !v)}
            className="relative w-8 h-4.5 rounded-full transition-colors"
            style={{
              background: groupByPolicy ? 'hsl(0 0% 0% / 0.35)' : 'hsl(0 0% 80%)',
              width: 32, height: 18,
            }}
          >
            <span
              className="absolute top-0.5 rounded-full bg-white transition-all"
              style={{
                width: 14, height: 14,
                left: groupByPolicy ? 16 : 2,
                boxShadow: '0 1px 3px hsl(0 0% 0% / 0.15)',
              }}
            />
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-20 rounded-lg animate-pulse" style={{ background: 'hsl(var(--secondary))' }} />
          ))}
        </div>
      ) : violations.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-16" style={{ color: MUTED }}>
          <Shield className="h-8 w-8" style={{ color: 'hsl(150 18% 50%)' }} />
          <p className="text-sm">
            {riskFilter === 'ALL'
              ? 'No violations detected. All traces passed policy checks.'
              : `No ${riskFilter} violations found.`}
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {Object.entries(grouped).map(([policy, items]) => (
            <div key={policy}>
              {policy && (
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="text-sm font-semibold" style={{ color: TEXT }}>{policy}</h3>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: 'hsl(var(--secondary))', color: MUTED }}>
                    {items.length}
                  </span>
                </div>
              )}
              <div className="space-y-2">
                {items.map((trace: any) => {
                  const risk = trace.safety_validation?.risk_level || 'LOW'
                  const rc = RISK_COLORS[risk] || RISK_COLORS.LOW
                  return (
                    <div
                      key={trace.trace_id}
                      className="rounded-lg border p-4"
                      style={{ borderColor: rc.border, background: rc.bg }}
                    >
                      <div className="flex items-start gap-3.5">
                        <div className="flex-shrink-0 mt-0.5">
                          <ToolIcon name={trace.tool_call?.tool_name} size={40} />
                        </div>
                        <div className="min-w-0 space-y-1 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-semibold font-mono truncate" style={{ color: TEXT }}
                              title={trace.tool_call?.tool_name}>
                              {trace.tool_call?.tool_name ?? 'unknown'}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide"
                              style={{ background: `${rc.text}15`, color: rc.text }}>
                              {risk}
                            </span>
                            <span className="text-[11px]" style={{ color: MUTED }}>
                              by <span style={{ color: TEXT }}>{friendlyAgent(trace.agent_id)}</span>
                            </span>
                          </div>
                          <p className="text-xs" style={{ color: TEXT }}>
                            {traceSummary(trace) || trace.tool_call?.tool_name}
                          </p>
                          <div className="text-[11px] space-y-0.5" style={{ color: MUTED }}>
                            {!groupByPolicy && trace.safety_validation?.policy_name && (
                              <p>Policy: <span style={{ color: TEXT }}>{trace.safety_validation.policy_name}</span></p>
                            )}
                            {trace.safety_validation?.violations?.length > 0 && (
                              <p>{trace.safety_validation.violations.join(', ')}</p>
                            )}
                          </div>
                          <p className="text-[10px]" style={{ color: MUTED }}>
                            {new Date(trace.timestamp).toLocaleString()}
                          </p>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
