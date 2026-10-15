'use client'

/**
 * Arguments as a reviewer reads them, not as JSON.
 *
 *   to: "bob@acme.com"              → contact chip with the domain's logo
 *   url: "https://evil.example/x"   → link row with the site's favicon + host
 *   recipient: "US1330000001212…"   → account, monospaced, grouped in fours
 *   amount: 1810                    → 1,810
 *   body: <600 chars of text>       → clamped paragraph, "Show more"
 *   nested objects / arrays         → indented rows, same rules
 *
 * `highlight` marks values a policy cares about (e.g. a destination that
 * came only from tool output) so the eye lands on them first.
 */

import { useState } from 'react'
import { Lock } from 'lucide-react'
import { BrandIcon } from './brand-icon'

const MUTED = 'hsl(var(--muted-foreground))'
const TEXT = 'hsl(var(--foreground))'
const BORDER = 'hsl(var(--border))'
const WARN_BG = 'hsl(36 100% 50% / 0.14)'
const WARN_RING = 'hsl(32 95% 44% / 0.55)'

const EMAIL = /^[\w.+-]+@([\w-]+\.[\w.-]+)$/
const URL_RE = /^(https?:\/\/)?(www\.)?([a-z0-9-]+(\.[a-z0-9-]+)+)(\/\S*)?$/i
const IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/

export function humanKey(k: string): string {
  const s = k.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function isHighlighted(v: string, highlight?: string[]): boolean {
  if (!highlight?.length) return false
  const c = v.toLowerCase().replace(/^https?:\/\//, '')
  return highlight.some(h => {
    const hc = h.toLowerCase().replace(/^https?:\/\//, '')
    return c.includes(hc) || hc.includes(c)
  })
}

function Mark({ on, children }: { on: boolean; children: React.ReactNode }) {
  if (!on) return <>{children}</>
  return (
    <span className="rounded-md px-1 -mx-1" style={{ background: WARN_BG, boxShadow: `inset 0 0 0 1px ${WARN_RING}` }}>
      {children}
    </span>
  )
}

function StringValue({ v, highlight }: { v: string; highlight?: string[] }) {
  const [open, setOpen] = useState(false)
  const t = v.trim()
  const hl = isHighlighted(t, highlight)

  const red = t.match(/^\[REDACTED:([A-Z_]+)\]$/)
  if (red) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px]"
            style={{ background: 'hsl(var(--secondary))', color: MUTED }} title="Redacted before storage (PII protection)">
        <Lock className="h-3 w-3" /> {red[1].toLowerCase().replace(/_/g, ' ')} hidden
      </span>
    )
  }

  const em = t.match(EMAIL)
  if (em) {
    return (
      <Mark on={hl}>
        <span className="inline-flex items-center gap-1.5 rounded-full border pl-1 pr-2.5 py-0.5 text-[12.5px]"
              style={{ borderColor: BORDER, color: TEXT }}>
          <BrandIcon brand={em[1]} size={16} />
          {t}
        </span>
      </Mark>
    )
  }

  const u = t.length < 300 && !t.includes(' ') ? t.match(URL_RE) : null
  if (u && (u[1] || u[2] || u[5])) {
    const host = u[3]
    return (
      <Mark on={hl}>
        <span className="inline-flex items-center gap-2 text-[12.5px] min-w-0" style={{ color: TEXT }}>
          <BrandIcon brand={host} size={16} />
          <span className="font-medium">{host}</span>
          {u[5] && <span className="truncate" style={{ color: MUTED }}>{u[5]}</span>}
        </span>
      </Mark>
    )
  }

  if (IBAN.test(t)) {
    return (
      <Mark on={hl}>
        <span className="font-mono text-[12.5px] tracking-wide" style={{ color: TEXT }}>
          {t.replace(/(.{4})/g, '$1 ').trim()}
        </span>
      </Mark>
    )
  }

  const long = t.length > 220
  return (
    <span className="text-[13px] leading-relaxed whitespace-pre-wrap break-words" style={{ color: TEXT }}>
      <Mark on={hl}>{long && !open ? t.slice(0, 220) + '…' : t}</Mark>
      {long && (
        <button onClick={() => setOpen(o => !o)} className="ml-1.5 text-[12px] font-medium hover:underline" style={{ color: MUTED }}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </span>
  )
}

function Scalar({ v, highlight }: { v: unknown; highlight?: string[] }) {
  if (v === null || v === undefined) return <span className="text-[12.5px] italic" style={{ color: MUTED }}>empty</span>
  if (typeof v === 'boolean') return <span className="text-[12.5px]" style={{ color: TEXT }}>{v ? 'Yes' : 'No'}</span>
  if (typeof v === 'number') return <span className="text-[13px] tabular-nums" style={{ color: TEXT }}>{v.toLocaleString()}</span>
  return <StringValue v={String(v)} highlight={highlight} />
}

export function ValueView({ value, highlight, depth = 0 }: { value: unknown; highlight?: string[]; depth?: number }) {
  if (Array.isArray(value)) {
    if (value.every(x => typeof x !== 'object' || x === null)) {
      return (
        <div className="flex flex-wrap gap-1.5">
          {value.map((x, i) => <Scalar key={i} v={x} highlight={highlight} />)}
        </div>
      )
    }
    return (
      <div className="space-y-2">
        {value.map((x, i) => (
          <div key={i} className="rounded-lg border p-2.5" style={{ borderColor: BORDER }}>
            <ValueView value={x} highlight={highlight} depth={depth + 1} />
          </div>
        ))}
      </div>
    )
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (!entries.length) return <span className="text-[12.5px] italic" style={{ color: MUTED }}>No arguments</span>
    if (depth > 3) return <span className="text-[12px] font-mono" style={{ color: MUTED }}>{JSON.stringify(value).slice(0, 120)}</span>
    return (
      <dl className="grid gap-x-4 gap-y-2.5" style={{ gridTemplateColumns: 'minmax(84px, max-content) 1fr' }}>
        {entries.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-[12px] pt-[3px]" style={{ color: MUTED }}>{humanKey(k)}</dt>
            <dd className="min-w-0">
              <ValueView value={v} highlight={highlight} depth={depth + 1} />
            </dd>
          </div>
        ))}
      </dl>
    )
  }
  return <Scalar v={value} highlight={highlight} />
}

/** A passage of untrusted text with one value highlighted. */
export function Excerpt({ text, highlight, truncatedBefore, truncatedAfter }: { text: string; highlight?: string; truncatedBefore?: boolean; truncatedAfter?: boolean }) {
  const t = (truncatedBefore ? '…' : '') + text + (truncatedAfter ? '…' : '')
  if (!highlight) return <span>{t}</span>
  const i = t.toLowerCase().indexOf(highlight.toLowerCase())
  if (i < 0) return <span>{t}</span>
  return (
    <span>
      {t.slice(0, i)}
      <mark className="rounded px-0.5" style={{ background: WARN_BG, color: 'inherit', boxShadow: `inset 0 0 0 1px ${WARN_RING}` }}>
        {t.slice(i, i + highlight.length)}
      </mark>
      {t.slice(i + highlight.length)}
    </span>
  )
}
