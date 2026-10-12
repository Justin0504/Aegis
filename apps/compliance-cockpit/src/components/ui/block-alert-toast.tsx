'use client'

import { useEffect } from 'react'
import { XCircle, Clock, X } from 'lucide-react'
import type { BlockAlert } from '@/hooks/useTraceStream'

// Decision colour, not risk colour: a toast exists to say what the gateway
// did. Red = blocked before execution, amber = held for a person.
const DECISION_STYLE = {
  block:   { rail: 'hsl(0 100% 42%)',  chip: 'hsl(0 100% 42% / 0.08)',  title: 'Blocked before execution' },
  pending: { rail: 'hsl(40 100% 33%)', chip: 'hsl(40 100% 33% / 0.10)', title: 'Held for approval' },
}

const AUTO_DISMISS_MS = 8000

interface Props {
  alerts:        BlockAlert[]
  dismissAlert:  (id: string) => void
}

export function BlockAlertToast({ alerts, dismissAlert }: Props) {
  // Auto-dismiss each alert after 8s
  useEffect(() => {
    if (alerts.length === 0) return
    const latest = alerts[alerts.length - 1]
    const t = setTimeout(() => dismissAlert(latest.id), AUTO_DISMISS_MS)
    return () => clearTimeout(t)
  }, [alerts, dismissAlert])

  if (alerts.length === 0) return null

  return (
    <div
      className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 pointer-events-none"
      style={{ maxWidth: 360 }}
    >
      {alerts.map((alert) => {
        const isBlock = alert.event === 'block'
        const style   = isBlock ? DECISION_STYLE.block : DECISION_STYLE.pending

        return (
          <div
            key={alert.id}
            className="pointer-events-auto rounded-xl border overflow-hidden"
            style={{
              background: 'hsl(var(--card))',
              borderColor: 'hsl(var(--border))',
              boxShadow: '0 8px 24px -12px rgb(0 0 0 / 0.18), 0 1px 2px rgb(0 0 0 / 0.04)',
              animation: 'slideInRight 0.18s ease-out',
            }}
          >
            <div className="flex items-stretch">
              <div style={{ width: 3, background: style.rail }} />
              <div className="flex-1 min-w-0 px-3.5 py-3">
                <div className="flex items-start gap-2.5">
                  {isBlock
                    ? <XCircle className="h-4 w-4 flex-shrink-0 mt-[1px]" style={{ color: style.rail }} />
                    : <Clock   className="h-4 w-4 flex-shrink-0 mt-[1px]" style={{ color: style.rail }} />}
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-medium leading-tight" style={{ color: 'hsl(var(--foreground))' }}>
                      {style.title}
                    </p>
                    <p className="text-[12px] font-mono truncate mt-1" style={{ color: 'hsl(var(--foreground))' }}>
                      {alert.tool_name}
                    </p>
                    {alert.reason && (
                      <p className="text-[11.5px] mt-1 line-clamp-2 leading-snug" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        {alert.reason}
                      </p>
                    )}
                    <div className="flex items-center gap-2 mt-2">
                      <span
                        className="text-[10px] font-semibold tracking-wide px-1.5 py-[2px] rounded-md"
                        style={{ background: style.chip, color: style.rail }}
                      >
                        {alert.risk_level}
                      </span>
                      <span className="text-[10.5px] font-mono truncate" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        {alert.category} · {alert.agent_id}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => dismissAlert(alert.id)}
                    aria-label="Dismiss"
                    className="flex-shrink-0 rounded-md p-1 hover:bg-[hsl(var(--secondary))] transition-colors"
                    style={{ color: 'hsl(var(--muted-foreground))' }}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      })}

      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(110%); opacity: 0; }
          to   { transform: translateX(0);   opacity: 1; }
        }
      `}</style>
    </div>
  )
}
