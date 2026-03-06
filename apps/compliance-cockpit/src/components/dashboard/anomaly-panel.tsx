'use client'

import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { detectAnomalies, Anomaly, AnomalyType } from '@/lib/anomaly'
import { TrendingUp, Clock, XCircle, BarChart2, CheckCircle } from 'lucide-react'

const TYPE_META: Record<AnomalyType, { icon: React.ElementType; label: string }> = {
  frequency_spike:     { icon: TrendingUp, label: 'Frequency Spike'  },
  latency_spike:       { icon: Clock,      label: 'Latency Spike'    },
  consecutive_failures:{ icon: XCircle,    label: 'Consec. Failures' },
  error_rate_spike:    { icon: BarChart2,  label: 'Error Rate Spike' },
}

const SEV_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  high:   { bg: 'hsl(0 10% 96%)',   text: 'hsl(0 14% 44%)',   dot: 'hsl(0 14% 52%)'   },
  medium: { bg: 'hsl(36 12% 96%)',  text: 'hsl(36 18% 40%)',  dot: 'hsl(36 18% 50%)'  },
  low:    { bg: 'hsl(210 10% 96%)', text: 'hsl(210 14% 42%)', dot: 'hsl(210 14% 50%)' },
}

export function AnomalyPanel() {
  const { data } = useQuery({
    queryKey: ['agent-activity-real'],
    queryFn: async () => {
      const res = await fetch('/api/gateway/traces?limit=200')
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    staleTime: 0,
  })

  const traces: any[] = data?.traces || []
  const anomalies = useMemo(() => detectAnomalies(traces), [traces])

  if (anomalies.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 h-32 text-sm" style={{ color: 'hsl(30 8% 55%)' }}>
        <CheckCircle className="h-5 w-5" style={{ color: 'hsl(150 18% 44%)' }} />
        No anomalies detected
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {anomalies.map(a => {
        const meta   = TYPE_META[a.type]
        const Icon   = meta.icon
        const colors = SEV_COLORS[a.severity]

        return (
          <div
            key={a.id}
            className="flex items-start gap-3 rounded-lg p-3 border"
            style={{ background: colors.bg, borderColor: `${colors.dot}40` }}
          >
            {/* Severity dot + icon */}
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
    </div>
  )
}
