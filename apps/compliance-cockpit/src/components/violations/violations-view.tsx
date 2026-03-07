'use client'

import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Shield } from 'lucide-react'

const TEXT   = 'hsl(30 10% 15%)'
const MUTED  = 'hsl(30 8% 46%)'
const BORDER = 'hsl(36 12% 88%)'

const RISK_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  CRITICAL: { bg: 'hsl(0 10% 97%)',  border: 'hsl(0 12% 82%)',  text: 'hsl(0 14% 42%)' },
  HIGH:     { bg: 'hsl(0 8% 97%)',   border: 'hsl(0 10% 85%)',  text: 'hsl(0 12% 46%)' },
  MEDIUM:   { bg: 'hsl(36 12% 97%)', border: 'hsl(36 12% 85%)', text: 'hsl(36 18% 40%)' },
  LOW:      { bg: 'hsl(36 10% 97%)', border: BORDER,             text: MUTED },
}

export function ViolationsView() {
  const { data, isLoading } = useQuery({
    queryKey: ['violations'],
    queryFn: async () => {
      const res = await fetch('/api/gateway/traces?limit=100')
      if (!res.ok) throw new Error('Failed to fetch traces')
      return res.json()
    },
    refetchInterval: 3000,
  })

  const violations = (data?.traces ?? []).filter(
    (t: any) => t.safety_validation && !t.safety_validation.passed
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Violations</h1>
        <p className="text-muted-foreground">Agent actions that failed safety policy checks</p>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-20 rounded-lg animate-pulse" style={{ background: 'hsl(36 14% 91%)' }} />
          ))}
        </div>
      ) : violations.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-16" style={{ color: MUTED }}>
          <Shield className="h-8 w-8" style={{ color: 'hsl(150 18% 50%)' }} />
          <p className="text-sm">No violations detected. All traces passed policy checks.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {violations.map((trace: any) => {
            const risk = trace.safety_validation?.risk_level || 'LOW'
            const rc = RISK_COLORS[risk] || RISK_COLORS.LOW
            return (
              <div
                key={trace.trace_id}
                className="rounded-lg border p-4"
                style={{ borderColor: rc.border, background: rc.bg }}
              >
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-md flex-shrink-0 mt-0.5" style={{ background: `${rc.text}12` }}>
                    <AlertTriangle className="h-4 w-4" style={{ color: rc.text }} />
                  </div>
                  <div className="min-w-0 space-y-1 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold" style={{ color: rc.text }}>
                        {trace.tool_call?.tool_name || 'Unknown tool'}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                        style={{ background: `${rc.text}15`, color: rc.text }}>
                        {risk}
                      </span>
                    </div>
                    <div className="text-xs space-y-0.5" style={{ color: TEXT }}>
                      <p><span style={{ color: MUTED }}>Policy:</span> {trace.safety_validation?.policy_name || 'Unknown'}</p>
                      {trace.safety_validation?.violations?.length > 0 && (
                        <p><span style={{ color: MUTED }}>Details:</span> {trace.safety_validation.violations.join(', ')}</p>
                      )}
                    </div>
                    <p className="text-[10px]" style={{ color: MUTED }}>
                      Agent {trace.agent_id?.substring(0, 8)}...
                      {' · '}{new Date(trace.timestamp).toLocaleString()}
                    </p>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
