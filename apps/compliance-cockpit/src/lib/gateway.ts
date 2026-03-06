'use client'

/** Read the dashboard API key from localStorage */
export function getApiKey(): string {
  if (typeof window === 'undefined') return ''
  return localStorage.getItem('aegis:api_key') ?? ''
}

/** Headers for all gateway fetch calls */
export function gatewayHeaders(): HeadersInit {
  const key = getApiKey()
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (key) h['x-api-key'] = key
  return h
}

/** Convenience wrapper: fetch /api/gateway/... with auth header */
export async function gw(path: string, init?: RequestInit): Promise<Response> {
  const key = getApiKey()
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> ?? {}),
    'Content-Type': 'application/json',
  }
  if (key) headers['x-api-key'] = key
  return fetch(`/api/gateway/${path}`, { ...init, headers, cache: 'no-store' })
}
