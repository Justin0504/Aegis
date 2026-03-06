import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  const { webhookUrl, payload } = await request.json()

  if (!webhookUrl) {
    return NextResponse.json({ error: 'No webhook URL' }, { status: 400 })
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return NextResponse.json({ ok: res.ok, status: res.status })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 502 })
  }
}
