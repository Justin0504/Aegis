'use client'

import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { detectAnomalies, Anomaly, AnomalyType } from '@/lib/anomaly'
import { gw } from '@/lib/gateway'
import { TrendingUp, Clock, XCircle, BarChart2, CheckCircle, Activity, Layers, FileText, Zap, Brain } from 'lucide-react'

// ── Client-side anomaly types (legacy) ────────────────────────────────────

const CLIENT_TYPE_META: Record<AnomalyType, { icon: React.ElementType; label: string }> = {
  frequency_spike:     { icon: TrendingUp, label: 'Frequency Spike'  },
  latency_spike:       { icon: Clock,      label: 'Latency Spike'    },
  consecutive_failures:{ icon: XCircle,    label: 'Consec. Failures' },
  error_rate_spike:    { icon: BarChart2,  label: 'Error Rate Spike' },
}

// ── Backend anomaly signal types ──────────────────────────────────────────

const SIGNAL_META: Record<string, { icon: React.ElementType; label: string }> = {
  tool_never_seen:      { icon: Zap,        label: 'Unknown Tool'     },
  tool_frequency_spike: { icon: TrendingUp, label: 'Frequency Spike'  },
  arg_shape_drift:      { icon: Layers,     label: 'Arg Shape Drift'  },
  arg_length_outlier:   { icon: FileText,   label: 'Arg Length Outlier'},
  temporal_anomaly:     { icon: Clock,      label: 'Temporal Anomaly' },
  sequence_anomaly:     { icon: Activity,   label: 'Sequence Anomaly' },
  cost_spike:           { icon: BarChart2,  label: 'Cost Spike'       },
  risk_escalation:      { icon: XCircle,    label: 'Risk Escalation'  },
  session_burst:        { icon: Zap,        label: 'Session Burst'    },
}

const SEV_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  high:     { bg: 'hsl(0 10% 96%)',   text: 'hsl(0 14% 44%)',   dot: 'hsl(0 14% 52%)'   },
  block:    { bg: 'hsl(0 10% 96%)',   text: 'hsl(0 14% 44%)',   dot: 'hsl(0 14% 52%)'   },
  medium:   { bg: 'hsl(36 12% 96%)',  text: 'hsl(36 18% 40%)',  dot: 'hsl(36 18% 50%)'  },
  escalate: { bg: 'hsl(36 12% 96%)',  text: 'hsl(36 18% 40%)',  dot: 'hsl(36 18% 50%)'  },
  low:      { bg: 'hsl(210 10% 96%)', text: 'hsl(210 14% 42%)', dot: 'hsl(210 14% 50%)' },
  flag:     { bg: 'hsl(210 10% 96%)', text: 'hsl(210 14% 42%)', dot: 'hsl(210 14% 50%)' },
}

function decisionToSeverity(decision: string): string {
  if (decision === 'block') return 'high'
  if (decision === 'escalate') return 'medium'
  return 'low'
}

export function AnomalyPanel() {
  // Fetch backend anomaly events
  const { data: backendData } = useQuery({
    queryKey: ['anomaly-events'],
    queryFn: async () => {
      const res = await gw('anomalies?min_score=0.3&limit=20')
      if (!res.ok) return { events: [] }
      return res.json()
    },
    refetchInterval: 10_000,
  })

  // Fetch traces for client-side detection (fallback / complement)
  const { data: traceData } = useQuery({
    queryKey: ['agent-activity-real'],
    queryFn: async () => {
      const res = await fetch('/api/gateway/traces?limit=200')
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    staleTime: 0,
  })

  const traces: any[] = traceData?.traces || []
  const clientAnomalies = useMemo(() => detectAnomalies(traces), [traces])
  const backendEvents: any[] = backendData?.events || []

  const hasAny = backendEvents.length > 0 || clientAnomalies.length > 0

  if (!hasAny) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 h-32 text-sm" style={{ color: 'hsl(30 8% 55%)' }}>
        <CheckCircle className="h-5 w-5" style={{ color: 'hsl(150 18% 44%)' }} />
        No anomalies detected
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {/* Backend behavioral anomalies (learning-based) */}
      {backendEvents.length > 0 && (
        <>
          <p className="text-[10px] uppercase font-bold tracking-wider flex items-center gap-1.5 pb-1"
            style={{ color: 'hsl(30 8% 52%)' }}>
            <Brain className="h-3 w-3" />
            Behavioral Anomalies
          </p>
          {backendEvents.map((evt: any) => {
            const severity = decisionToSeverity(evt.decision)
            const colors = SEV_COLORS[severity] || SEV_COLORS.low
            const signals: any[] = evt.signals || []
            const topSignal = signals[0]
            const meta = topSignal ? (SIGNAL_META[topSignal.type] || { icon: Activity, label: topSignal.type }) : { icon: Activity, label: 'Anomaly' }
            const Icon = meta.icon

            return (
              <div
                key={evt.id}
                className="flex items-start gap-3 rounded-lg p-3 border"
                style={{ background: colors.bg, borderColor: `${colors.dot}40` }}
              >
                <div className="flex items-center gap-1.5 flex-shrink-0 mt-0.5">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: colors.dot }} />
                  <Icon className="h-3.5 w-3.5" style={{ color: colors.text }} />
                </div>
                <div className="flex-1 min-w-0 space-y-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold" style={{ color: colors.text }}>
                      {meta.label}
                      {signals.length > 1 && ` +${signals.length - 1}`}
                    </p>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <span
                        className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                        style={{ background: `${colors.dot}18`, color: colors.text }}
                      >
                        {evt.composite_score.toFixed(2)}
                      </span>
                      <span
                        className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded flex-shrink-0"
                        style={{ background: `${colors.dot}20`, color: colors.text }}
                      >
                        {evt.decision}
                      </span>
                    </div>
                  </div>
                  <p className="text-xs truncate" style={{ color: 'hsl(30 8% 35%)' }}>
                    {topSignal?.detail || 'behavioral deviation detected'}
                  </p>
                  <p className="text-[10px]" style={{ color: 'hsl(30 8% 58%)' }}>
                    {evt.agent_id?.substring(0, 12)}
                    {evt.created_at && ` · ${new Date(evt.created_at).toLocaleTimeString()}`}
                  </p>
                </div>
              </div>
            )
          })}
        </>
      )}

      {/* Client-side statistical anomalies (legacy real-time) */}
      {clientAnomalies.length > 0 && (
        <>
          {backendEvents.length > 0 && (
            <p className="text-[10px] uppercase font-bold tracking-wider flex items-center gap-1.5 pt-2 pb-1"
              style={{ color: 'hsl(30 8% 52%)' }}>
              <BarChart2 className="h-3 w-3" />
              Real-time Statistical
            </p>
          )}
          {clientAnomalies.map(a => {
            const meta   = CLIENT_TYPE_META[a.type]
            const Icon   = meta.icon
            const colors = SEV_COLORS[a.severity]

            return (
              <div
                key={a.id}
                className="flex items-start gap-3 rounded-lg p-3 border"
                style={{ background: colors.bg, borderColor: `${colors.dot}40` }}
              >
                <div className="flex items-center gap-1.5 flex-shrink-0 mt-0.5">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: colors.dot }} />
                  <Icon className="h-3.5 w-3.5" style={{ color: colors.text }} />
                </div>
                <div className="flex-1 min-w-0 space-y-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold" style={{ color: colors.text }}>
                      {a.title}
                    </p>
                    <span
                      className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded flex-shrink-0"
                      style={{ background: `${colors.dot}20`, color: colors.text }}
                    >
                      {a.severity}
                    </span>
                  </div>
                  <p className="text-xs" style={{ color: 'hsl(30 8% 35%)' }}>{a.detail}</p>
                  <p className="text-[10px]" style={{ color: 'hsl(30 8% 58%)' }}>
                    {a.detectedAt.toLocaleTimeString()}
                    {a.baseline > 0 && ` · baseline ${a.baseline}${a.type === 'latency_spike' ? 'ms' : a.type === 'error_rate_spike' ? '%' : 'x'}`}
                  </p>
                </div>
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}
