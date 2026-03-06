'use client'

import { useEffect } from 'react'
import { XCircle, Clock, X } from 'lucide-react'
import type { BlockAlert } from '@/hooks/useTraceStream'

const RISK_STYLE: Record<string, { bar: string; icon: string; badge: string }> = {
  CRITICAL: { bar: 'hsl(0 14% 46%)',   icon: 'hsl(0 14% 46%)',   badge: 'hsl(0 10% 94%)' },
  HIGH:     { bar: 'hsl(25 18% 44%)',  icon: 'hsl(25 18% 44%)',  badge: 'hsl(25 12% 94%)' },
  MEDIUM:   { bar: 'hsl(36 18% 44%)',  icon: 'hsl(36 18% 44%)',  badge: 'hsl(36 12% 94%)' },
  LOW:      { bar: 'hsl(150 14% 40%)', icon: 'hsl(150 14% 40%)', badge: 'hsl(150 10% 94%)' },
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
        const style  = RISK_STYLE[alert.risk_level] ?? RISK_STYLE.HIGH
        const isBlock = alert.event === 'block'

        return (
          <div
            key={alert.id}
            className="pointer-events-auto rounded-xl shadow-lg border overflow-hidden"
            style={{
              background:  '#fff',
              borderColor: 'hsl(36 12% 88%)',
              borderLeft:  `4px solid ${style.bar}`,
              animation:   'slideInRight 0.2s ease-out',
            }}
          >
            <div className="flex items-start gap-3 px-4 py-3">
              {/* Icon */}
              {isBlock
                ? <XCircle className="h-5 w-5 flex-shrink-0 mt-0.5" style={{ color: style.icon }} />
                : <Clock   className="h-5 w-5 flex-shrink-0 mt-0.5" style={{ color: style.icon }} />
              }

              {/* Content */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate" style={{ color: 'hsl(30 10% 15%)' }}>
                  {isBlock ? '🚫 Blocked' : '⏳ Pending Approval'}
                </p>
                <p className="text-xs font-mono truncate mt-0.5" style={{ color: 'hsl(30 8% 35%)' }}>
                  {alert.tool_name}
                </p>
                {alert.reason && (
                  <p className="text-[11px] mt-1 line-clamp-2" style={{ color: 'hsl(30 8% 50%)' }}>
                    {alert.reason}
                  </p>
                )}
                <div className="flex items-center gap-2 mt-2">
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase"
                    style={{ background: style.badge, color: style.icon }}
                  >
                    {alert.risk_level}
                  </span>
                  <span className="text-[10px]" style={{ color: 'hsl(30 8% 60%)' }}>
                    {alert.category} · {alert.agent_id}
                  </span>
                </div>
              </div>

              {/* Dismiss */}
              <button
                onClick={() => dismissAlert(alert.id)}
                className="flex-shrink-0 rounded p-0.5 hover:opacity-60 transition-opacity"
                style={{ color: 'hsl(30 8% 55%)' }}
              >
                <X className="h-3.5 w-3.5" />
              </button>
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
