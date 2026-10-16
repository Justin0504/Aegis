'use client'

/**
 * Runs — one agent session, told as a story.
 *
 * Left: recent runs, each with the apps it touched as a row of logos.
 * Right: the selected run as a vertical timeline. Every step is a
 * sentence ("Emailed bob@acme.com", "Opened www.example.com") with the
 * app's or website's logo, what AEGIS decided, and how long it took.
 * Arguments and results open in place, rendered as fields — never as a
 * wall of JSON.
 */

import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Clock, ShieldCheck, ShieldAlert, ShieldX, Hourglass, Layers } from 'lucide-react'
import { ToolIcon } from '@/lib/tool-icons'
import { describeActivity } from '@/lib/activity-description'
import { friendlyAgent } from '@/lib/friendly-names'
import { BrandIcon } from '@/components/ui/brand-icon'
import { ValueView } from '@/components/ui/value-view'
import { fmtWhen } from '@/lib/time'

const MUTED = 'hsl(var(--muted-foreground))'
const TEXT = 'hsl(var(--foreground))'
const BORDER = 'hsl(var(--border))'

type Tone = 'allow' | 'held' | 'block' | 'error'

const TONE: Record<Tone, { label: string; fg: string; bg: string; Icon: typeof ShieldCheck }> = {
  allow: { label: 'Allowed', fg: 'hsl(152 60% 30%)', bg: 'hsl(152 60% 36% / 0.10)', Icon: ShieldCheck },
  held:  { label: 'Held for review', fg: 'hsl(32 95% 36%)', bg: 'hsl(36 100% 50% / 0.13)', Icon: Hourglass },
  block: { label: 'Blocked', fg: 'hsl(0 72% 42%)', bg: 'hsl(0 72% 50% / 0.10)', Icon: ShieldX },
  error: { label: 'Failed', fg: 'hsl(0 0% 40%)', bg: 'hsl(var(--secondary))', Icon: ShieldAlert },
}

export function toneOf(t: any): Tone {
  if (t.observation?.error) return 'error'
  const d = String(t.decision ?? '').toLowerCase()
  const a = String(t.approval_status ?? '').toUpperCase()
  if (d === 'block' || a === 'REJECTED' || t.safety_validation?.passed === false) return 'block'
  if (d === 'pending' || a.startsWith('PENDING')) return 'held'
  return 'allow'
}

function hostOf(args: any): string | null {
  for (const v of Object.values(args ?? {})) {
    if (typeof v !== 'string') continue
    const m = v.match(/^(?:https?:\/\/)?((?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:\/|$)/i)
    if (m && (v.startsWith('http') || v.startsWith('www.'))) return m[1]
  }
  return null
}

function fmtDur(ms?: number): string {
  if (ms == null) return ''
  if (ms < 1) return '<1 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

function fmtTime(ts?: string): string {
  if (!ts) return ''
  const d = new Date(ts.endsWith('Z') || ts.includes('+') ? ts : ts + 'Z')
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

function requestOf(traces: any[]): string | null {
  for (const t of traces) {
    const c = t.input_context
    const v = typeof c === 'string' ? c : c?.prompt ?? c?.user_input ?? c?.task ?? c?.goal
    if (typeof v === 'string' && v.trim() && v.length < 2000) return v.trim()
  }
  return null
}

function resultOf(obs: any): unknown {
  if (!obs) return null
  if (obs.error) return { error: obs.error }
  const raw = obs.raw_output ?? obs.output ?? obs.result
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return raw }
  }
  return raw ?? null
}

/** A run is named by what it was asked to do, the way a chat is named by
 *  its first message; the agent id is secondary. */
function runTitle(s: any): string {
  const r = typeof s?.request === 'string' ? s.request.trim() : ''
  if (!r || /^[a-z_]+$/.test(r)) return friendlyAgent(s?.agent_id, s?.agent_name)
  return r.length > 70 ? r.slice(0, 68) + '\u2026' : r
}

function Step({ t, last }: { t: any; last: boolean }) {
  const [open, setOpen] = useState(false)
  const rich = describeActivity(t)
  const tone = TONE[toneOf(t)]
  const args = t.tool_call?.arguments ?? {}
  const host = rich.recipientHost ?? hostOf(args)
  const reason = t.safety_validation?.violations?.[0] ?? t.safety_validation?.reason
  const result = resultOf(t.observation)

  return (
    <li className="relative pl-12">
      {!last && <span className="absolute left-[17px] top-10 bottom-0 w-px" style={{ background: BORDER }} />}
      <span className="absolute left-0 top-1 inline-flex h-9 w-9 items-center justify-center rounded-full border"
            style={{ borderColor: BORDER, background: 'hsl(var(--card))' }}>
        <ToolIcon name={rich.iconKey ?? t.tool_call?.tool_name} size={22} />
      </span>

      <button onClick={() => setOpen(o => !o)} className="w-full text-left group">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 pt-1">
            <p className="text-[14px] font-medium leading-snug" style={{ color: TEXT }}>
              {rich.text || t.tool_call?.tool_name}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px]" style={{ color: MUTED }}>
              <span className="font-mono">{t.tool_call?.tool_name}</span>
              {host && (
                <span className="inline-flex items-center gap-1">
                  <BrandIcon brand={host} size={13} /> {host}
                </span>
              )}
              <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{fmtTime(t.timestamp)}</span>
              {t.observation?.duration_ms != null && <span>{fmtDur(t.observation.duration_ms)}</span>}
            </div>
          </div>
          <span className="mt-1 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-medium flex-shrink-0"
                style={{ color: tone.fg, background: tone.bg }}>
            <tone.Icon className="h-3.5 w-3.5" /> {tone.label}
          </span>
          <ChevronDown className="mt-2 h-4 w-4 flex-shrink-0 transition-transform"
                       style={{ color: MUTED, transform: open ? 'rotate(180deg)' : undefined }} />
        </div>
      </button>

      {reason && toneOf(t) !== 'allow' && (
        <p className="mt-2 text-[12.5px] leading-snug" style={{ color: tone.fg }}>{reason}</p>
      )}

      {open && (
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <section className="rounded-xl border p-3.5" style={{ borderColor: BORDER }}>
            <h4 className="text-[11px] font-semibold uppercase tracking-wider mb-2.5" style={{ color: MUTED }}>Asked for</h4>
            <ValueView value={args} />
          </section>
          <section className="rounded-xl border p-3.5" style={{ borderColor: BORDER }}>
            <h4 className="text-[11px] font-semibold uppercase tracking-wider mb-2.5" style={{ color: MUTED }}>Got back</h4>
            {result == null
              ? <p className="text-[12.5px] italic" style={{ color: MUTED }}>{toneOf(t) === 'allow' ? 'Nothing recorded' : 'Did not run'}</p>
              : <ValueView value={result} />}
          </section>
        </div>
      )}
      <div className={last ? 'pb-1' : 'pb-6'} />
    </li>
  )
}

export function RunTimeline() {
  const { data: sdata, isLoading } = useQuery({
    queryKey: ['sessions'],
    queryFn: async () => {
      const r = await fetch('/api/gateway/traces/sessions?limit=40')
      if (!r.ok) throw new Error('sessions')
      return r.json()
    },
    refetchInterval: 10_000,
  })
  const sessions: any[] = sdata?.sessions ?? []
  const [sel, setSel] = useState<string | null>(null)
  useEffect(() => { if (!sel && sessions[0]) setSel(sessions[0].session_id) }, [sel, sessions])

  const { data: tdata } = useQuery({
    queryKey: ['session-traces', sel],
    enabled: !!sel,
    queryFn: async () => {
      const r = await fetch(`/api/gateway/traces?session_id=${encodeURIComponent(sel!)}&limit=200`)
      if (!r.ok) throw new Error('traces')
      return r.json()
    },
    refetchInterval: 10_000,
  })
  const steps = useMemo(
    () => [...(tdata?.traces ?? [])].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))),
    [tdata],
  )
  const counts = useMemo(() => {
    const c: Record<Tone, number> = { allow: 0, held: 0, block: 0, error: 0 }
    for (const s of steps) c[toneOf(s)]++
    return c
  }, [steps])
  const current = sessions.find(s => s.session_id === sel)
  const request = requestOf(steps)

  if (!isLoading && sessions.length === 0) {
    return (
      <div className="rounded-2xl border py-16 text-center" style={{ borderColor: BORDER }}>
        <Layers className="mx-auto h-7 w-7 opacity-40" style={{ color: MUTED }} />
        <p className="mt-3 text-[14px] font-medium" style={{ color: TEXT }}>No runs yet</p>
        <p className="mt-1 text-[12.5px]" style={{ color: MUTED }}>
          Runs appear when your SDK reports a session id with each call.
        </p>
      </div>
    )
  }

  return (
    <div className="grid gap-4 md:grid-cols-12">
      <aside className="md:col-span-4 md:sticky md:top-4 self-start rounded-2xl border overflow-hidden" style={{ borderColor: BORDER, background: 'hsl(var(--card))' }}>
        <p className="px-4 pt-3.5 pb-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: MUTED }}>Recent runs</p>
        <ul className="max-h-[70vh] overflow-auto pb-2">
          {sessions.map(s => {
            const tools = Array.from(new Set(String(s.tool_names ?? '').split(',').filter(Boolean))).slice(0, 6)
            const active = s.session_id === sel
            return (
              <li key={`${s.session_id}-${s.agent_id}`}>
                <button onClick={() => setSel(s.session_id)}
                        className="w-full text-left px-4 py-3 transition-colors"
                        style={{ background: active ? 'hsl(var(--secondary))' : undefined }}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13.5px] font-medium truncate" style={{ color: TEXT }}>{runTitle(s)}</span>
                    <span className="text-[11.5px] flex-shrink-0" style={{ color: MUTED }}>{fmtWhen(s.last_seen_at)}</span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    {tools.map(tn => <ToolIcon key={tn} name={tn} size={16} />)}
                    <span className="ml-1 text-[11.5px]" style={{ color: MUTED }}>
                      {s.trace_count} step{s.trace_count === 1 ? '' : 's'}
                      {s.error_count ? ` · ${s.error_count} failed` : ''}
                    </span>
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      </aside>

      <section className="md:col-span-8 rounded-2xl border p-5" style={{ borderColor: BORDER, background: 'hsl(var(--card))' }}>
        {current && (
          <header className="mb-5">
            <h3 className="text-[17px] font-semibold" style={{ color: TEXT }}>{runTitle(current)}</h3>
            <p className="mt-0.5 text-[12.5px]" style={{ color: MUTED }}>{friendlyAgent(current.agent_id, current.agent_name)}</p>
            <p className="mt-1 text-[12.5px]" style={{ color: MUTED }}>
              {steps.length} steps · {counts.allow} allowed
              {counts.held ? ` · ${counts.held} held` : ''}
              {counts.block ? ` · ${counts.block} blocked` : ''}
              {counts.error ? ` · ${counts.error} failed` : ''}
            </p>
            {request && (
              <div className="mt-4 rounded-2xl px-4 py-3 text-[13.5px] leading-relaxed"
                   style={{ background: 'hsl(var(--secondary))', color: TEXT }}>
                <span className="block text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: MUTED }}>Request</span>
                {request}
              </div>
            )}
          </header>
        )}
        <ol>
          {steps.map((t, i) => <Step key={t.trace_id} t={t} last={i === steps.length - 1} />)}
        </ol>
      </section>
    </div>
  )
}
