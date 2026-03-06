import { NextRequest, NextResponse } from 'next/server'

const GATEWAY = process.env['GATEWAY_URL'] || 'http://localhost:8080'

export async function POST(request: NextRequest) {
  const body = await request.json()
  const { trace } = body

  if (!trace) {
    return NextResponse.json({ error: 'No trace provided' }, { status: 400 })
  }

  // Re-submit the trace's input as a new trace to the gateway
  const payload = {
    agent_id:        trace.agent_id,
    input_context:   trace.input_context,
    thought_chain:   { raw_tokens: '[AEGIS Replay]', parsed_steps: [] },
    tool_call: {
      ...trace.tool_call,
      timestamp: new Date().toISOString(),
    },
    observation: {
      raw_output: null,
      error: null,
      duration_ms: 0,
      metadata: { replayed_from: trace.trace_id },
    },
    environment:     trace.environment || 'replay',
    sequence_number: 0,
  }

  try {
    const res = await fetch(`${GATEWAY}/api/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await res.json().catch(() => ({}))
    return NextResponse.json({ ok: res.ok, status: res.status, data })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 502 })
  }
}
