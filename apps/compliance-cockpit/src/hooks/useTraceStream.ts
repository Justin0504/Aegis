'use client'

import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

export function useTraceStream() {
  const queryClient = useQueryClient()
  const [connected, setConnected] = useState(false)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    const es = new EventSource('/api/stream')
    esRef.current = es

    es.addEventListener('connected', () => {
      setConnected(true)
    })

    es.addEventListener('traces', (e) => {
      try {
        const payload = JSON.parse(e.data)
        const newTraces: any[] = payload.traces || []
        if (newTraces.length === 0) return

        setLastUpdate(new Date())

        // Merge new traces into all relevant query caches
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

        // Also invalidate activity feed
        queryClient.invalidateQueries({ queryKey: ['agent-activity-real'] })
        queryClient.invalidateQueries({ queryKey: ['stats'] })
        queryClient.invalidateQueries({ queryKey: ['violations'] })
      } catch {
        // ignore parse errors
      }
    })

    es.onerror = () => {
      setConnected(false)
      // Browser will auto-reconnect for EventSource
    }

    return () => {
      es.close()
      esRef.current = null
      setConnected(false)
    }
  }, [queryClient])

  return { connected, lastUpdate }
}
