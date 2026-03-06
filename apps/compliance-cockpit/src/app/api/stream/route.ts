import { NextRequest } from 'next/server'

const GATEWAY = process.env['GATEWAY_URL'] || 'http://localhost:8080'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const encoder = new TextEncoder()
  let lastTimestamp: string | null = null
  let closed = false

  const stream = new ReadableStream({
    async start(controller) {
      // Send initial connection event
      controller.enqueue(encoder.encode('event: connected\ndata: {}\n\n'))

      const poll = async () => {
        if (closed) return

        try {
          const url = lastTimestamp
            ? `${GATEWAY}/api/v1/traces?limit=20&since=${encodeURIComponent(lastTimestamp)}`
            : `${GATEWAY}/api/v1/traces?limit=20`

          const res = await fetch(url, { cache: 'no-store' })
          if (res.ok) {
            const data = await res.json()
            const traces: any[] = data.traces || []

            if (traces.length > 0) {
              // Update cursor to newest trace timestamp
              const newest = traces[0]
              if (newest?.timestamp) lastTimestamp = newest.timestamp

              const payload = JSON.stringify({ traces })
              controller.enqueue(encoder.encode(`event: traces\ndata: ${payload}\n\n`))
            }
          }
        } catch {
          // Gateway unavailable — keep stream open, retry next tick
        }

        if (!closed) setTimeout(poll, 2000)
      }

      // Start polling after a short delay
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
