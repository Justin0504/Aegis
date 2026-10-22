'use client'

/**
 * Security 360 — every way an agent can be turned against its owner,
 * and whether THIS deployment covers it right now.
 *
 * Status is read from the live gateway, not asserted: the injection
 * surface is "on" only when the provenance pack is applied AND SDKs are
 * reporting context (without context the pack is inert by design); the
 * audit surface reflects whether the hash chains actually verify. A
 * surface that is available but not switched on says so, with the one
 * step that switches it on.
 */

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import {
  Syringe, Wrench, Upload, Trash2, UserCheck, Compass, Plug, KeyRound, Brain, Link2, ArrowRight,
} from 'lucide-react'

const MUTED = 'hsl(var(--muted-foreground))'
const TEXT = 'hsl(var(--foreground))'
const BORDER = 'hsl(var(--border))'

type Status = 'on' | 'partial' | 'off' | 'alert'
const STATUS: Record<Status, { label: string; color: string }> = {
  on:      { label: 'Protected',   color: 'hsl(152 58% 38%)' },
  partial: { label: 'Partial',     color: 'hsl(36 92% 46%)' },
  off:     { label: 'Not enabled', color: 'hsl(0 0% 70%)' },
  alert:   { label: 'Attention',   color: 'hsl(0 72% 50%)' },
}

interface Surface {
  key: string
  title: string
  threat: string
  Icon: typeof Syringe
  status: Status
  detail: string
  action: { label: string; href: string }
}

async function getJson(path: string): Promise<any> {
  try {
    const r = await fetch(`/api/gateway/${path}`)
    return r.ok ? await r.json() : null
  } catch {
    return null
  }
}

function useSignals() {
  return useQuery({
    queryKey: ['security-360'],
    refetchInterval: 15_000,
    queryFn: async () => {
      const [dsl, ctx, proxy, integ, align, mcp] = await Promise.all([
        getJson('dsl'), getJson('context/stats'), getJson('proxy/stats'),
        getJson('integrity/verify-all'), getJson('alignment/recent?limit=1'), getJson('mcp/tools'),
      ])
      const rules: string[] = (dsl?.dsl?.rules ?? []).map((r: any) => String(r.name ?? ''))
      return {
        rules,
        sessions: Number(ctx?.sessions ?? 0),
        proxied: Array.isArray(proxy) ? proxy.length : Array.isArray(proxy?.servers) ? proxy.servers.length : 0,
        chains: { total: Number(integ?.total_agents ?? integ?.total ?? 0), broken: Number(integ?.broken_agents ?? integ?.broken ?? 0) },
        audited: (align?.items ?? []).length > 0,
        mcp: { tools: (mcp?.tools ?? []).length, servers: Number(mcp?.servers ?? 0),
               changed: Number(mcp?.changed ?? 0), suspicious: Number(mcp?.suspicious ?? 0) },
      }
    },
  })
}

function surfaces(s: NonNullable<ReturnType<typeof useSignals>['data']>): Surface[] {
  const has = (frag: string) => s.rules.some(r => r.includes(frag))
  const provenance = has('provenance-')
  return [
    {
      key: 'injection', title: 'Prompt injection', Icon: Syringe,
      threat: 'Instructions hidden in web pages, files, email and tool output.',
      status: provenance && s.sessions > 0 ? 'on' : provenance ? 'partial' : 'off',
      detail: provenance && s.sessions > 0
        ? `Instruction provenance on; ${s.sessions} live session${s.sessions === 1 ? '' : 's'} reporting context.`
        : provenance ? 'Pack applied, but no SDK is reporting context yet, so it cannot attribute calls.'
        : 'Calls are not checked for where their authority came from.',
      action: provenance ? { label: 'Report context from the SDK', href: '/welcome' } : { label: 'Apply the provenance pack', href: '/dsl/packs' },
    },
    {
      key: 'actions', title: 'Tool calls', Icon: Wrench,
      threat: 'Dangerous commands, SQL, file access and shell injection.',
      status: 'on', detail: 'Every call is checked before it runs, in under a millisecond.',
      action: { label: 'Review policies', href: '/policies' },
    },
    {
      key: 'exfil', title: 'Data exfiltration', Icon: Upload,
      threat: 'Sending data or money to a destination the user never named.',
      status: has('destination-from-untrusted') ? 'on' : has('exfil') ? 'partial' : 'off',
      detail: has('destination-from-untrusted')
        ? 'Destinations that appear only in untrusted content are held or blocked.'
        : 'Outbound calls are not checked against where their destination came from.',
      action: { label: 'Policy packs', href: '/dsl/packs' },
    },
    {
      key: 'destructive', title: 'Irreversible actions', Icon: Trash2,
      threat: 'Deletes, drops, revocations and transfers that cannot be undone.',
      status: has('destructive') ? 'on' : 'partial',
      detail: has('destructive') ? 'Blocked when their authority traces to untrusted content; rollbacks recorded.' : 'Rollbacks recorded; no rule ties deletes to their authority.',
      action: { label: 'Rollbacks', href: '/rollbacks' },
    },
    {
      key: 'oversight', title: 'Human oversight', Icon: UserCheck,
      threat: 'High-stakes actions taken with nobody watching.',
      status: 'on', detail: 'Held calls pause the agent and wait for a decision, with the evidence attached.',
      action: { label: 'Approvals', href: '/approvals' },
    },
    {
      key: 'drift', title: 'Goal drift', Icon: Compass,
      threat: 'An agent pursuing something other than what it was asked.',
      status: s.audited ? 'on' : 'off',
      detail: s.audited ? 'The alignment auditor reviews held calls against the request and what the agent read.'
        : 'No alignment checks recorded. Held calls go straight to a person.',
      action: { label: 'Alignment auditor', href: '/alignment' },
    },
    {
      key: 'mcp', title: 'MCP & tool supply chain', Icon: Plug,
      threat: 'Malicious or tampered MCP servers and tool descriptions.',
      status: s.mcp.changed + s.mcp.suspicious > 0 ? 'alert' : (s.mcp.tools > 0 || s.proxied > 0) ? 'on' : 'off',
      detail: s.mcp.changed + s.mcp.suspicious > 0
        ? `${s.mcp.changed ? `${s.mcp.changed} tool${s.mcp.changed === 1 ? '' : 's'} changed after approval` : ''}${s.mcp.changed && s.mcp.suspicious ? '; ' : ''}${s.mcp.suspicious ? `${s.mcp.suspicious} with a description that instructs the model` : ''}. Refused until re-pinned.`
        : s.mcp.tools > 0 ? `${s.mcp.tools} tool${s.mcp.tools === 1 ? '' : 's'} from ${s.mcp.servers} server${s.mcp.servers === 1 ? '' : 's'} pinned by description and schema; a change is refused until re-pinned.`
        : s.proxied > 0 ? `${s.proxied} MCP server${s.proxied === 1 ? '' : 's'} routed through the proxy; no tool list pinned yet.`
        : 'No MCP servers are routed through the AEGIS proxy, so tool descriptions are not pinned.',
      action: s.mcp.changed + s.mcp.suspicious > 0 ? { label: 'Review MCP tools', href: '/settings#mcp' } : { label: 'Wrap a server with the proxy', href: '/welcome' },
    },
    {
      key: 'secrets', title: 'Secrets & generated code', Icon: KeyRound,
      threat: 'Keys in prompts or outputs; unsafe code the agent writes.',
      status: 'partial', detail: 'PII and secrets are redacted in traces; Code Shield scans generated code on request.',
      action: { label: 'Code Shield', href: '/code-shield' },
    },
    {
      key: 'memory', title: 'Memory poisoning', Icon: Brain,
      threat: 'Injected content written to long-term memory and replayed later.',
      status: 'partial', detail: 'Memory writes are traced and reviewable; not yet scored for provenance.',
      action: { label: 'Memory', href: '/memory' },
    },
    {
      key: 'audit', title: 'Tamper-evident audit', Icon: Link2,
      threat: 'Logs edited after the fact to hide what an agent did.',
      status: s.chains.broken > 0 ? 'alert' : s.chains.total > 0 ? 'on' : 'partial',
      detail: s.chains.broken > 0 ? `${s.chains.broken} of ${s.chains.total} hash chains do not verify.`
        : s.chains.total > 0 ? `All ${s.chains.total} agent hash chains verify end to end.` : 'Hash-chained audit is on; no agent has written a chain yet.',
      action: { label: 'Audit log', href: '/audit-log' },
    },
  ]
}

function Ring({ items }: { items: Surface[] }) {
  const n = items.length
  const R = 112, r = 84, cx = 140, cy = 140, gap = 0.035
  const arc = (i: number) => {
    const a0 = (i / n) * 2 * Math.PI - Math.PI / 2 + gap
    const a1 = ((i + 1) / n) * 2 * Math.PI - Math.PI / 2 - gap
    const p = (rad: number, a: number) => `${cx + rad * Math.cos(a)} ${cy + rad * Math.sin(a)}`
    return `M ${p(R, a0)} A ${R} ${R} 0 0 1 ${p(R, a1)} L ${p(r, a1)} A ${r} ${r} 0 0 0 ${p(r, a0)} Z`
  }
  const on = items.filter(x => x.status === 'on').length
  return (
    <svg viewBox="0 0 280 280" className="w-full max-w-[280px]" role="img" aria-label={`${on} of ${n} surfaces protected`}>
      {items.map((x, i) => (
        <path key={x.key} d={arc(i)} fill={STATUS[x.status].color} opacity={x.status === 'off' ? 0.45 : 0.9}>
          <title>{`${x.title}: ${STATUS[x.status].label}`}</title>
        </path>
      ))}
      <text x={cx} y={cy - 4} textAnchor="middle" style={{ fill: TEXT, fontSize: 40, fontWeight: 650 }}>{on}<tspan style={{ fill: MUTED, fontSize: 20 }}>/{n}</tspan></text>
      <text x={cx} y={cy + 22} textAnchor="middle" style={{ fill: MUTED, fontSize: 11.5, letterSpacing: '0.04em' }}>SURFACES PROTECTED</text>
    </svg>
  )
}

export function Security360() {
  const { data, isLoading } = useSignals()
  if (isLoading || !data) {
    return <div className="h-80 rounded-2xl animate-pulse" style={{ background: 'hsl(var(--secondary))' }} />
  }
  const items = surfaces(data)
  return (
    <section className="rounded-2xl border p-6" style={{ borderColor: BORDER, background: 'hsl(var(--card))' }}>
      <div className="flex flex-col lg:flex-row gap-8">
        <div className="flex flex-col items-center lg:w-[300px] flex-shrink-0">
          <Ring items={items} />
          <div className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1.5">
            {(['on', 'partial', 'off', 'alert'] as Status[]).map(k => (
              <span key={k} className="inline-flex items-center gap-1.5 text-[11.5px]" style={{ color: MUTED }}>
                <span className="h-2 w-2 rounded-full" style={{ background: STATUS[k].color }} /> {STATUS[k].label}
              </span>
            ))}
          </div>
          <p className="mt-4 text-center text-[12px] leading-relaxed max-w-[260px]" style={{ color: MUTED }}>
            Read live from this gateway. A surface counts only when its protection is switched on and receiving data.
          </p>
        </div>
        <ul className="flex-1 grid sm:grid-cols-2 gap-x-6 gap-y-1">
          {items.map(x => (
            <li key={x.key} className="py-3 border-b" style={{ borderColor: BORDER }}>
              <div className="flex items-start gap-3">
                <span className="mt-0.5 inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg"
                      style={{ background: 'hsl(var(--secondary))' }}>
                  <x.Icon className="h-4 w-4" style={{ color: TEXT }} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-[13.5px] font-semibold" style={{ color: TEXT }}>{x.title}</p>
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium" style={{ color: STATUS[x.status].color }}>
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS[x.status].color }} />
                      {STATUS[x.status].label}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[12px]" style={{ color: MUTED }}>{x.threat}</p>
                  <p className="mt-1.5 text-[12.5px] leading-snug" style={{ color: TEXT }}>{x.detail}</p>
                  {x.status !== 'on' && (
                    <Link href={x.action.href} className="mt-1.5 inline-flex items-center gap-1 text-[12px] font-medium hover:underline" style={{ color: TEXT }}>
                      {x.action.label} <ArrowRight className="h-3 w-3" />
                    </Link>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
