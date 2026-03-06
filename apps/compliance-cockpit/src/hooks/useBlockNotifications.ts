'use client'

import { useCallback, useEffect, useState } from 'react'
import type { BlockAlert } from './useTraceStream'

const ICON = '/favicon.ico'

export type NotifPermission = 'default' | 'granted' | 'denied'

export function useBlockNotifications() {
  const [permission, setPermission] = useState<NotifPermission>('default')

  // Sync current permission on mount
  useEffect(() => {
    if (typeof Notification !== 'undefined') {
      setPermission(Notification.permission as NotifPermission)
    }
  }, [])

  // Request permission — must be called from a user gesture
  const requestPermission = useCallback(async () => {
    if (typeof Notification === 'undefined') return
    const result = await Notification.requestPermission()
    setPermission(result as NotifPermission)
  }, [])

  // Fire a native OS notification for a block/pending alert
  const notify = useCallback((alert: BlockAlert) => {
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted') return

    const isBlock   = alert.event === 'block'
    const title     = isBlock ? '🚫 AEGIS — Tool Blocked' : '⏳ AEGIS — Approval Required'
    const body      = [
      `Tool: ${alert.tool_name}`,
      `Risk: ${alert.risk_level}  •  ${alert.category}`,
      alert.reason ?? '',
    ].filter(Boolean).join('\n')

    try {
      const n = new Notification(title, { body, icon: ICON, tag: alert.id })
      // Click on notification → focus the dashboard tab
      n.onclick = () => {
        window.focus()
        n.close()
      }
    } catch {
      // Notifications may be blocked by browser policy
    }
  }, [])

  return { permission, requestPermission, notify }
}
