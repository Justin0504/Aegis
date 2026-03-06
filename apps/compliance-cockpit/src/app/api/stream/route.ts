import { NextRequest } from 'next/server'

const GATEWAY = process.env['GATEWAY_URL'] || 'http://localhost:8080'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const encoder = new TextEncoder()
  let lastTimestamp: string | null = null
  let lastEventTimestamp: string | null = null
  let closed = false

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode('event: connected\ndata: {}\n\n'))

      const poll = async () => {
        if (closed) return

        // ── Trace feed ─────────────────────────────────────────────────────
        try {
          const url = lastTimestamp
            ? `${GATEWAY}/api/v1/traces?limit=20&since=${encodeURIComponent(lastTimestamp)}`
            : `${GATEWAY}/api/v1/traces?limit=20`

          const res = await fetch(url, { cache: 'no-store' })
          if (res.ok) {
            const data = await res.json()
            const traces: any[] = data.traces || []
            if (traces.length > 0) {
              const newest = traces[0]
              if (newest?.timestamp) lastTimestamp = newest.timestamp
              controller.enqueue(encoder.encode(
                `event: traces\ndata: ${JSON.stringify({ traces })}\n\n`
              ))
            }
          }
        } catch { /* gateway unavailable */ }

        // ── Block/pending alert feed ────────────────────────────────────────
        try {
          const alertUrl = lastEventTimestamp
            ? `${GATEWAY}/api/v1/check/events?since=${encodeURIComponent(lastEventTimestamp)}`
            : `${GATEWAY}/api/v1/check/events`

          const res = await fetch(alertUrl, { cache: 'no-store' })
          if (res.ok) {
            const data = await res.json()
            const events: any[] = data.events || []
            if (events.length > 0) {
              lastEventTimestamp = events[events.length - 1].timestamp
              for (const evt of events) {
                controller.enqueue(encoder.encode(
                  `event: alert\ndata: ${JSON.stringify(evt)}\n\n`
                ))
              }
            }
          }
        } catch { /* gateway unavailable */ }

        if (!closed) setTimeout(poll, 2000)
      }

      setTimeout(poll, 500)
    },
    cancel() {
      closed = true
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
