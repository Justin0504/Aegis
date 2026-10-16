'use client'

/**
 * Violations — every call AEGIS refused or held, as a reviewer reads it.
 *
 * A row is a sentence ("Sent money · 129.99 to US13…") with the app's
 * logo, the verdict, the reason in plain words and when. Rows group by
 * the rule that fired, under the rule's plain name, so an operator sees
 * at a glance which protection is doing the work. Risk level shows only
 * when it is high or critical; "LOW" next to a block confused everyone.
 */

import { useQuery } from '@tanstack/react-query'
import { Shield, ShieldX, Hourglass, ChevronDown } from 'lucide-react'
import { useMemo, useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { friendlyAgent } from '@/lib/friendly-names'
import { describeActivity } from '@/lib/activity-description'
import { ToolIcon } from '@/lib/tool-icons'
import { ValueView } from '@/components/ui/value-view'
import { fmtWhen, fmtFull } from '@/lib/time'
import { USE_MOCK, mockViolations } from '@/lib/mock-traces'

const TEXT   = 'hsl(var(--foreground))'
const MUTED  = 'hsl(var(--muted-foreground))'
const BORDER = 'hsl(var(--border))'

const VERDICT = {
  block: { label: 'Blocked', fg: 'hsl(0 72% 42%)', bg: 'hsl(0 72% 50% / 0.10)', Icon: ShieldX },
  held:  { label: 'Held',    fg: 'hsl(32 95% 36%)', bg: 'hsl(36 100% 50% / 0.13)', Icon: Hourglass },
}

/** Rule ids are for policy authors; the group heading is for the person reading. */
const RULE_TITLES: Array<[RegExp, string, string]> = [
  [/appears only in untrusted content|destination-from-untrusted/i, 'Destination came from untrusted content', 'The address, URL or account in the call appeared only in something the agent read, never in what the person asked.'],
  [/moves data out of their account|exfil-sink/i, 'Outbound call nobody asked for', 'The call moves data or money out, and nothing the person said accounts for it. The shape of an indirect prompt injection.'],
  [/irreversible action|authority-on-destructive/i, 'Irreversible action from untrusted content', 'A delete, revoke or transfer whose instruction traces to tool output rather than to the person.'],
  [/named in untrusted content|tool-named-only/i, 'Tool named only by untrusted content', 'Only the content the agent read mentions this tool; the person never did.'],
  [/better explained by tool output|authority-review/i, 'Better explained by tool output than by the request', 'Held for a look: the call draws more on what a tool returned than on what was asked.'],
  [/no clear authority|unclear-authority/i, 'Outbound call with unclear authority', ''],
  [/human (approval|review)|outbound communication/i, 'Outbound communication', 'Messages, invitations and other outbound communication go to a person in this deployment.'],
  [/shell metachar|shell|command injection/i, 'Shell command', 'Shell metacharacters or a dangerous command in a call that runs on a host.'],
  [/\bsql\b|drop table|truncate/i, 'Destructive SQL', ''],
  [/path traversal|sensitive (file|path)/i, 'Sensitive file access', ''],
  [/exfiltrat|egress/i, 'Data exfiltration', ''],
  [/anomal/i, 'Behavioural anomaly', 'The call is far from this agent\'s usual pattern.'],
]

function ruleTitle(rule: string | undefined | null, reason: string): { key: string; title: string; blurb: string } {
  // Traces record the reason, not the rule id, so the reason text is what
  // we classify on; a rule id, when present, is tried first.
  for (const [re, title, blurb] of RULE_TITLES) if ((rule && re.test(rule)) || re.test(reason)) return { key: title, title, blurb }
  return { key: 'other', title: 'Other policy', blurb: '' }
}

function verdictOf(t: any): 'block' | 'held' {
  const a = String(t.approval_status ?? '').toUpperCase()
  if (a.startsWith('PENDING')) return 'held'
  return 'block'
}

function reasonOf(t: any): string {
  const v = t.safety_validation?.violations
  const r = Array.isArray(v) && v.length ? String(v[0]) : (t.block_reason ?? '')
  if (/requires human (approval|review)/i.test(r)) return 'Outbound communication goes to a person in this deployment.'
  return r || 'Refused by policy.'
}

function Row({ t }: { t: any }) {
  const [open, setOpen] = useState(false)
  const rich = describeActivity(t)
  const v = VERDICT[verdictOf(t)]
  const risk = String(t.safety_validation?.risk_level ?? t.risk_level ?? '').toUpperCase()
  const args = t.tool_call?.arguments ?? {}
  return (
    <li className="border-t first:border-t-0" style={{ borderColor: BORDER }}>
      <button onClick={() => setOpen(o => !o)} className="w-full text-left px-4 py-3.5 flex items-start gap-3.5 hover:bg-[hsl(var(--secondary)/0.5)] transition-colors">
        <ToolIcon name={rich.iconKey ?? t.tool_call?.tool_name} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[14px] font-medium leading-snug" style={{ color: TEXT }}>{rich.text || t.tool_call?.tool_name}</p>
            {(risk === 'HIGH' || risk === 'CRITICAL') && (
              <span className="text-[10.5px] font-semibold tracking-wide px-1.5 py-[2px] rounded-md" style={{ color: 'hsl(0 72% 42%)', background: 'hsl(0 72% 50% / 0.10)' }}>{risk}</span>
            )}
          </div>
          <p className="mt-0.5 text-[12.5px] leading-snug" style={{ color: MUTED }}>{reasonOf(t)}</p>
          <p className="mt-1 text-[12px]" style={{ color: MUTED }}>
            {friendlyAgent(t.agent_id, t.agent_name)} · <span title={fmtFull(t.timestamp)}>{fmtWhen(t.timestamp)}</span>
            <span className="font-mono ml-2 opacity-70">{t.tool_call?.tool_name}</span>
          </p>
        </div>
        <span className="mt-0.5 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-medium flex-shrink-0" style={{ color: v.fg, background: v.bg }}>
          <v.Icon className="h-3.5 w-3.5" /> {v.label}
        </span>
        <ChevronDown className="mt-1.5 h-4 w-4 flex-shrink-0 transition-transform" style={{ color: MUTED, transform: open ? 'rotate(180deg)' : undefined }} />
      </button>
      {open && (
        <div className="px-4 pb-4 pl-[66px]">
          <div className="rounded-xl border p-3.5" style={{ borderColor: BORDER }}>
            <h4 className="text-[11px] font-semibold uppercase tracking-wider mb-2.5" style={{ color: MUTED }}>The call, as the agent emitted it</h4>
            <ValueView value={args} />
          </div>
        </div>
      )}
    </li>
  )
}

export function ViolationsView() {
  const [verdict, setVerdict] = useState<'all' | 'block' | 'held'>('all')
  const { data, isLoading } = useQuery({
    enabled: !USE_MOCK,
    queryKey: ['violations'],
    queryFn: async () => {
      const res = await fetch('/api/gateway/traces?limit=300')
      if (!res.ok) throw new Error('Failed to fetch traces')
      return res.json()
    },
    refetchInterval: 5000,
  })

  const all: any[] = useMemo(() => (USE_MOCK ? mockViolations() : (data?.traces ?? [])).filter(
    (t: any) => (t.safety_validation && !t.safety_validation.passed) || String(t.decision ?? '') === 'block' || String(t.approval_status ?? '').startsWith('PENDING') || t.approval_status === 'REJECTED'
  ), [data])
  const counts = useMemo(() => ({ all: all.length, block: all.filter(t => verdictOf(t) === 'block').length, held: all.filter(t => verdictOf(t) === 'held').length }), [all])
  const rows = useMemo(() => verdict === 'all' ? all : all.filter((t: any) => verdictOf(t) === verdict), [all, verdict])

  const groups = useMemo(() => {
    const g = new Map<string, { title: string; blurb: string; items: any[] }>()
    for (const t of rows) {
      const { key, title, blurb } = ruleTitle(t.safety_validation?.rule ?? t.dsl?.rule ?? t.block_rule ?? null, reasonOf(t))
      if (!g.has(key)) g.set(key, { title, blurb, items: [] })
      g.get(key)!.items.push(t)
    }
    return Array.from(g.values()).sort((a, b) => b.items.length - a.items.length)
  }, [rows])

  return (
    <div>
      <PageHeader title="Violations" subtitle="Every call AEGIS refused or held, grouped by the protection that caught it.">
        <div className="inline-flex rounded-full border p-0.5" style={{ borderColor: BORDER }}>
          {([['all', 'All'], ['block', 'Blocked'], ['held', 'Held']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setVerdict(k)}
              className="px-3.5 py-1.5 rounded-full text-[12.5px] font-medium transition-colors"
              style={{ background: verdict === k ? 'hsl(var(--foreground))' : 'transparent', color: verdict === k ? 'hsl(var(--background))' : MUTED }}>
              {label} <span className="ml-1 tabular-nums opacity-70">{counts[k]}</span>
            </button>
          ))}
        </div>
      </PageHeader>

      {isLoading ? (
        <div className="space-y-3">{[...Array(3)].map((_, i) => <div key={i} className="h-20 rounded-2xl animate-pulse" style={{ background: 'hsl(var(--secondary))' }} />)}</div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border py-16 text-center" style={{ borderColor: BORDER }}>
          <Shield className="mx-auto h-7 w-7 opacity-40" style={{ color: MUTED }} />
          <p className="mt-3 text-[14px] font-medium" style={{ color: TEXT }}>Nothing refused</p>
          <p className="mt-1 text-[12.5px]" style={{ color: MUTED }}>Every call in the window passed its checks.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map(g => (
            <section key={g.title}>
              <div className="flex items-baseline gap-2 mb-2 px-1">
                <h2 className="text-[15px] font-semibold" style={{ color: TEXT }}>{g.title}</h2>
                <span className="text-[12px] tabular-nums" style={{ color: MUTED }}>{g.items.length}</span>
              </div>
              {g.blurb && <p className="text-[12.5px] mb-2.5 px-1 max-w-[80ch]" style={{ color: MUTED }}>{g.blurb}</p>}
              <ul className="rounded-2xl border overflow-hidden" style={{ borderColor: BORDER, background: 'hsl(var(--card))' }}>
                {g.items.map(t => <Row key={t.trace_id} t={t} />)}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
