'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useBlockNotifications } from './useBlockNotifications'

export interface BlockAlert {
  id:         string
  event:      'block' | 'pending'
  agent_id:   string
  tool_name:  string
  category:   string
  risk_level: string
  reason?:    string
  timestamp:  string
}

export function useTraceStream() {
  const queryClient = useQueryClient()
  const { notify, permission, requestPermission } = useBlockNotifications()
  const [connected,  setConnected]  = useState(false)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [alerts,     setAlerts]     = useState<BlockAlert[]>([])
  const esRef = useRef<EventSource | null>(null)

  const dismissAlert = useCallback((id: string) => {
    setAlerts(prev => prev.filter(a => a.id !== id))
  }, [])

  useEffect(() => {
    const es = new EventSource('/api/stream')
    esRef.current = es

    es.addEventListener('connected', () => setConnected(true))

    es.addEventListener('traces', (e) => {
      try {
        const payload = JSON.parse(e.data)
        const newTraces: any[] = payload.traces || []
        if (newTraces.length === 0) return

        setLastUpdate(new Date())

        queryClient.setQueriesData(
          { queryKey: ['traces'] },
          (old: any) => {
            if (!old) return old
            const existing: any[] = old.traces || []
            const existingIds = new Set(existing.map((t: any) => t.trace_id))
            const fresh = newTraces.filter((t: any) => !existingIds.has(t.trace_id))
            if (fresh.length === 0) return old
            return { ...old, traces: [...fresh, ...existing].slice(0, 500) }
          }
        )

        queryClient.invalidateQueries({ queryKey: ['agent-activity-real'] })
        queryClient.invalidateQueries({ queryKey: ['stats'] })
        queryClient.invalidateQueries({ queryKey: ['violations'] })
      } catch { /* ignore */ }
    })

    es.addEventListener('alert', (e) => {
      try {
        const alert: BlockAlert = JSON.parse(e.data)
        // OS-level notification (works even when tab is in background)
        notify(alert)
        setAlerts(prev => {
          if (prev.some(a => a.id === alert.id)) return prev
          return [...prev, alert].slice(-10)
        })
      } catch { /* ignore */ }
    })

    es.onerror = () => setConnected(false)

    return () => {
      es.close()
      esRef.current = null
      setConnected(false)
    }
  }, [queryClient])

  return { connected, lastUpdate, alerts, dismissAlert, notifPermission: permission, requestNotifPermission: requestPermission }
}
