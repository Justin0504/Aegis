import { NextRequest, NextResponse } from 'next/server'

const BASE = process.env['GATEWAY_URL'] || 'http://localhost:8080'

// Server-side key cache — resolved once, reused for all requests
let _cachedKey: string | null = null

async function getGatewayKey(): Promise<string> {
  // 1. Env var takes highest priority (Docker/production deployments)
  if (process.env['GATEWAY_API_KEY']) return process.env['GATEWAY_API_KEY']
  // 2. Cached from previous auto-fetch
  if (_cachedKey) return _cachedKey
  // 3. Auto-fetch from bootstrap endpoint
  try {
    const res = await fetch(`${BASE}/api/v1/auth/key`, { cache: 'no-store' })
    if (res.ok) {
      const data = await res.json()
      if (data.api_key) { _cachedKey = data.api_key; return _cachedKey! }
    }
  } catch {}
  return ''
}

async function gatewayHeaders(request: NextRequest): Promise<Record<string, string>> {
  // Client can override with its own key (e.g. after regeneration)
  const clientKey = request.headers.get('x-api-key')
  const key = clientKey || await getGatewayKey()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (key) headers['x-api-key'] = key
  return headers
}

export async function GET(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  const path   = params.path.join('/')
  const search = request.nextUrl.search
  const url    = `${BASE}/api/v1/${path}${search}`
  try {
    const response = await fetch(url, { cache: 'no-store', headers: await gatewayHeaders(request) })
    const data = await response.json()
    return NextResponse.json(data, { status: response.status })
  } catch {
    return NextResponse.json({ error: 'Gateway unavailable' }, { status: 502 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  const path = params.path.join('/')
  const url  = `${BASE}/api/v1/${path}`
  const body = await request.text()
  try {
    const response = await fetch(url, { method: 'POST', headers: await gatewayHeaders(request), body })
    const data = await response.json()
    return NextResponse.json(data, { status: response.status })
  } catch {
    return NextResponse.json({ error: 'Gateway unavailable' }, { status: 502 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  const path = params.path.join('/')
  const url  = `${BASE}/api/v1/${path}`
  const body = await request.text()
  try {
    const response = await fetch(url, { method: 'PATCH', headers: await gatewayHeaders(request), body })
    const data = await response.json()
    return NextResponse.json(data, { status: response.status })
  } catch {
    return NextResponse.json({ error: 'Gateway unavailable' }, { status: 502 })
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  const path = params.path.join('/')
  const url  = `${BASE}/api/v1/${path}`
  const body = await request.text()
  try {
    const response = await fetch(url, { method: 'PUT', headers: await gatewayHeaders(request), body })
    const data = await response.json()
    return NextResponse.json(data, { status: response.status })
  } catch {
    return NextResponse.json({ error: 'Gateway unavailable' }, { status: 502 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  const path = params.path.join('/')
  const url  = `${BASE}/api/v1/${path}`
  try {
    const response = await fetch(url, { method: 'DELETE', headers: await gatewayHeaders(request) })
    const data = await response.json()
    return NextResponse.json(data, { status: response.status })
  } catch {
    return NextResponse.json({ error: 'Gateway unavailable' }, { status: 502 })
  }
}
