import { NextRequest, NextResponse } from 'next/server'

const BASE = process.env['GATEWAY_URL'] || 'http://localhost:8080'

// Demo mode: when this is a public-facing demo build without a real
// gateway behind it, short-circuit gateway-proxy calls with sensible
// empty responses so the UI renders "no data" states cleanly instead
// of red banners + toasts. Set by build env in the Vercel demo deploy.
const DEMO_MODE =
  process.env['NEXT_PUBLIC_DEMO_MODE'] === 'true' ||
  process.env['DEMO_MODE'] === 'true';

/**
 * Best-effort empty-shape reply for known gateway endpoints. The
 * shapes here match what the real gateway returns on empty data,
 * so downstream React components render their empty-state UI
 * (rather than throwing on missing fields).
 */
function demoEmptyShape(path: string): unknown {
  // Common list endpoints — return the wrapper the real gateway uses.
  if (path === 'traces' || path.startsWith('traces?'))    return { traces: [], total: 0 };
  if (path === 'agents' || path.startsWith('agents?'))    return { items: [] };
  if (path.startsWith('policies'))                        return [];
  if (path.startsWith('violations'))                      return { violations: [] };
  if (path.startsWith('approvals'))                       return { approvals: [] };
  if (path.startsWith('stats'))                           return {};
  if (path.startsWith('sessions'))                        return { sessions: [] };
  if (path.startsWith('audit-log'))                       return { items: [] };
  if (path.startsWith('compliance'))                      return { rows: [], mappings: [] };
  if (path.startsWith('rollbacks'))                       return { items: [] };
  if (path.startsWith('coverage'))                        return { agents: [], rules: [] };
  // Fallback — well-shaped empty object; every React component in
  // the codebase treats `undefined`/`null` fields as absence.
  return {};
}

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
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  // Forward Bearer if the browser presented one — preferred over X-API-Key
  // so the gateway resolves a real user session and audit rows carry the
  // human's email instead of the API key name.
  const bearer = request.headers.get('authorization')
  if (bearer && bearer.startsWith('Bearer ')) {
    headers['authorization'] = bearer
  }
  // Always include X-API-Key as well: either the one the client overrode
  // with, or our cached/bootstrapped one. The gateway's auth middleware
  // tries Bearer first and falls back to X-API-Key, so this is a safe
  // belt-and-suspenders for routes that should work in either mode.
  const clientKey = request.headers.get('x-api-key')
  const key = clientKey || await getGatewayKey()
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
    if (DEMO_MODE) {
      return NextResponse.json(demoEmptyShape(params.path.join('/')), { status: 200 })
    }
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
    if (DEMO_MODE) {
      return NextResponse.json(demoEmptyShape(params.path.join('/')), { status: 200 })
    }
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
    if (DEMO_MODE) {
      return NextResponse.json(demoEmptyShape(params.path.join('/')), { status: 200 })
    }
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
    if (DEMO_MODE) {
      return NextResponse.json(demoEmptyShape(params.path.join('/')), { status: 200 })
    }
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
    if (DEMO_MODE) {
      return NextResponse.json(demoEmptyShape(params.path.join('/')), { status: 200 })
    }
    return NextResponse.json({ error: 'Gateway unavailable' }, { status: 502 })
  }
}
