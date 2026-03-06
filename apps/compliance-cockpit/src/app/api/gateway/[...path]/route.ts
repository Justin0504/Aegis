import { NextRequest, NextResponse } from 'next/server'

export async function GET(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  const base = process.env['GATEWAY_URL'] || 'http://localhost:8080'
  const path = params.path.join('/')
  const search = request.nextUrl.search
  const url = `${base}/api/v1/${path}${search}`

  try {
    const response = await fetch(url, { cache: 'no-store' })
    const data = await response.json()
    return NextResponse.json(data, { status: response.status })
  } catch (err) {
    return NextResponse.json({ error: 'Gateway unavailable' }, { status: 502 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  const base = process.env['GATEWAY_URL'] || 'http://localhost:8080'
  const path = params.path.join('/')
  const url = `${base}/api/v1/${path}`
  const body = await request.text()

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    const data = await response.json()
    return NextResponse.json(data, { status: response.status })
  } catch (err) {
    return NextResponse.json({ error: 'Gateway unavailable' }, { status: 502 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  const base = process.env['GATEWAY_URL'] || 'http://localhost:8080'
  const path = params.path.join('/')
  const url = `${base}/api/v1/${path}`
  const body = await request.text()

  try {
    const response = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    const data = await response.json()
    return NextResponse.json(data, { status: response.status })
  } catch (err) {
    return NextResponse.json({ error: 'Gateway unavailable' }, { status: 502 })
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  const base = process.env['GATEWAY_URL'] || 'http://localhost:8080'
  const path = params.path.join('/')
  const url = `${base}/api/v1/${path}`
  const body = await request.text()

  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    const data = await response.json()
    return NextResponse.json(data, { status: response.status })
  } catch (err) {
    return NextResponse.json({ error: 'Gateway unavailable' }, { status: 502 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  const base = process.env['GATEWAY_URL'] || 'http://localhost:8080'
  const path = params.path.join('/')
  const url = `${base}/api/v1/${path}`

  try {
    const response = await fetch(url, { method: 'DELETE' })
    const data = await response.json()
    return NextResponse.json(data, { status: response.status })
  } catch (err) {
    return NextResponse.json({ error: 'Gateway unavailable' }, { status: 502 })
  }
}
