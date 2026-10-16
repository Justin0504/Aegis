'use client'

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  UserRound, Plus, Shield, ShieldAlert, ShieldOff, KeyRound,
  Copy, Check, X, Trash2, Loader2, AlertCircle,
} from 'lucide-react'
import { USE_MOCK, mockAgents } from '@/lib/mock-traces'
import { ToolIcon } from '@/lib/tool-icons'
import { EmailAvatar } from '@/lib/avatar'
import { fmtWhen } from '@/lib/time'
import { PageHeader } from '@/components/ui/page-header'
import { friendlyAgent } from '@/lib/friendly-names'

const BORDER = 'hsl(var(--border))'
const MUTED  = 'hsl(var(--muted-foreground))'
const TEXT   = 'hsl(var(--foreground))'
const BG     = 'hsl(var(--card))'

type Status = 'active' | 'suspended' | 'deprecated' | 'unregistered'

interface Agent {
  id: string
  org_id: string
  name?: string
  description?: string
  owner_email?: string
  declared_tools?: string[]
  max_cost_daily_usd?: number
  environments?: string[]
  status: Status
  has_secret: boolean
  has_public_key: boolean
  created_at: string
  updated_at: string
  last_seen_at?: string
}

const STATUS_STYLE: Record<Status, { bg: string; color: string; border: string; label: string }> = {
  active:       { bg: 'hsl(150 12% 95%)', color: 'hsl(150 18% 36%)', border: 'hsl(150 10% 80%)', label: 'Active' },
  suspended:    { bg: 'hsl(25 12% 95%)',  color: 'hsl(25 22% 40%)',  border: 'hsl(25 12% 82%)',  label: 'Suspended' },
  deprecated:   { bg: 'hsl(0 10% 95%)',   color: 'hsl(0 14% 44%)',   border: 'hsl(0 10% 82%)',   label: 'Deprecated' },
  unregistered: { bg: 'hsl(var(--secondary))',  color: 'hsl(0 0% 25%)',  border: 'hsl(220 14% 88%)',  label: 'Unregistered' },
}

function fmtTs(s?: string): string {
  return s ? fmtWhen(s) : '—'
}

function StatusBadge({ s }: { s: Status }) {
  const sty = STATUS_STYLE[s]
  return (
    <span
      className="inline-block text-[11px] font-medium px-2 py-0.5 rounded border"
      style={{ background: sty.bg, color: sty.color, borderColor: sty.border }}
    >
      {sty.label}
    </span>
  )
}

const BLANK = {
  id: '',
  name: '',
  owner_email: '',
  description: '',
  declared_tools: '',
  environments: [] as Array<'dev' | 'staging' | 'prod'>,
  issue_secret: true,
}

export function AgentsView() {
  const qc = useQueryClient()
  const [filter, setFilter] = useState<Status | 'all'>('all')
  const [showRegister, setShowRegister] = useState(false)
  const [form, setForm] = useState(BLANK)
  const [registering, setRegistering] = useState(false)
  const [formError, setFormError] = useState('')
  const [newSecret, setNewSecret] = useState<string | null>(null)
  const [secretCopied, setSecretCopied] = useState(false)
  const [selected, setSelected] = useState<Agent | null>(null)

  const { data: liveAgents = [], isLoading } = useQuery({
    enabled: !USE_MOCK,
    queryKey: ['agents', filter],
    queryFn: async () => {
      const url = filter === 'all'
        ? '/api/gateway/agents?include_deprecated=1'
        : `/api/gateway/agents?status=${filter}&include_deprecated=1`
      const res = await fetch(url)
      if (!res.ok) throw new Error('Failed to load agents')
      const j = await res.json()
      return (j.items ?? []) as Agent[]
    },
    refetchInterval: 15000,
  })

  const agents = USE_MOCK
    ? (mockAgents().filter(a =>
        filter === 'all' ? true : a.status === filter
      ) as unknown as Agent[])
    : liveAgents

  async function submitRegister(e: React.FormEvent) {
    e.preventDefault()
    setRegistering(true)
    setFormError('')
    try {
      const body: any = {
        issue_secret: form.issue_secret,
      }
      if (form.id.trim())          body.id = form.id.trim()
      if (form.name.trim())        body.name = form.name.trim()
      if (form.owner_email.trim()) body.owner_email = form.owner_email.trim()
      if (form.description.trim()) body.description = form.description.trim()
      if (form.declared_tools.trim()) {
        body.declared_tools = form.declared_tools
          .split(',').map(s => s.trim()).filter(Boolean)
      }
      if (form.environments.length > 0) body.environments = form.environments

      const res = await fetch('/api/gateway/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error?.message || data?.error || `HTTP ${res.status}`)
      if (data.secret) setNewSecret(data.secret)
      else setShowRegister(false)
      setForm(BLANK)
      qc.invalidateQueries({ queryKey: ['agents'] })
    } catch (err) {
      setFormError((err as Error).message)
    } finally {
      setRegistering(false)
    }
  }

  async function setStatus(agent: Agent, status: 'active' | 'suspended') {
    const res = await fetch(`/api/gateway/agents/${agent.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    if (res.ok) {
      qc.invalidateQueries({ queryKey: ['agents'] })
      if (selected?.id === agent.id) {
        const data = await res.json()
        setSelected(data.agent)
      }
    }
  }

  async function rotateSecret(agent: Agent) {
    if (!confirm(`Rotate secret for ${agent.name ?? agent.id}? The current secret will stop working immediately.`)) return
    const res = await fetch(`/api/gateway/agents/${agent.id}/rotate-secret`, { method: 'POST' })
    const data = await res.json()
    if (res.ok && data.secret) setNewSecret(data.secret)
  }

  async function deprecate(agent: Agent) {
    if (!confirm(`Deprecate ${agent.name ?? agent.id}? All calls will be blocked. (Soft delete — record stays for audit.)`)) return
    const res = await fetch(`/api/gateway/agents/${agent.id}`, { method: 'DELETE' })
    if (res.ok) {
      qc.invalidateQueries({ queryKey: ['agents'] })
      if (selected?.id === agent.id) setSelected(null)
    }
  }

  // Activity per agent, from the runs the gateway has: which apps it
  // touched (logos), how many calls, how many were held or blocked, and
  // when it was last seen. Traces key agents by UUID with the operator's
  // name alongside; the registry keys by the name. Match on either.
  const { data: sdata } = useQuery({
    queryKey: ['sessions-for-agents'], enabled: !USE_MOCK, refetchInterval: 15000,
    queryFn: async () => (await fetch('/api/gateway/traces/sessions?limit=200')).json(),
  })
  const { data: tdata } = useQuery({
    queryKey: ['traces-for-agents'], enabled: !USE_MOCK, refetchInterval: 15000,
    queryFn: async () => (await fetch('/api/gateway/traces?limit=500')).json(),
  })
  const activity = useMemo(() => {
    const byKey = new Map<string, { tools: Set<string>; calls: number; held: number; blocked: number; runs: number; last?: string }>()
    const get = (k: string) => { if (!byKey.has(k)) byKey.set(k, { tools: new Set(), calls: 0, held: 0, blocked: 0, runs: 0 }); return byKey.get(k)! }
    for (const s of (sdata?.sessions ?? []) as any[]) {
      for (const k of [s.agent_name, s.agent_id].filter(Boolean)) { const a = get(k); a.runs++; for (const t of String(s.tool_names ?? '').split(',').filter(Boolean)) a.tools.add(t) }
    }
    for (const t of (tdata?.traces ?? []) as any[]) {
      for (const k of [t.agent_name, t.agent_id].filter(Boolean)) {
        const a = get(k); a.calls++
        const d = String(t.decision ?? '')
        if (d === 'block') a.blocked++; else if (d === 'pending') a.held++
        if (!a.last || String(t.timestamp) > a.last) a.last = String(t.timestamp)
      }
    }
    return byKey
  }, [sdata, tdata])
  const actOf = (a: any) => activity.get(a.name) ?? activity.get(a.id)

  return (
    <div style={{ color: TEXT }}>
      <PageHeader title="Agents" subtitle="Every agent that has called the gateway, what it touches, and how often AEGIS has had to step in."
        actions={
          <button onClick={() => { setShowRegister(true); setForm(BLANK); setFormError('') }}
            className="text-[13px] font-medium px-3.5 h-9 rounded-full inline-flex items-center gap-1.5 transition-opacity hover:opacity-85"
            style={{ background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}>
            <Plus className="h-3.5 w-3.5" /> Register agent
          </button>
        }>
        <div className="inline-flex rounded-full border p-0.5" style={{ borderColor: BORDER }}>
          {(['all', 'active', 'unregistered', 'suspended', 'deprecated'] as const).map(s => (
            <button key={s} onClick={() => setFilter(s)}
              className="px-3.5 py-1.5 rounded-full text-[12.5px] font-medium transition-colors"
              style={{ background: filter === s ? 'hsl(var(--foreground))' : 'transparent', color: filter === s ? 'hsl(var(--background))' : MUTED }}>
              {s === 'all' ? 'All' : STATUS_STYLE[s].label}
            </button>
          ))}
        </div>
      </PageHeader>

      {isLoading && <div className="h-40 rounded-2xl animate-pulse" style={{ background: 'hsl(var(--secondary))' }} />}
      {!isLoading && agents.length === 0 && (
        <div className="rounded-2xl border py-16 text-center" style={{ borderColor: BORDER }}>
          <UserRound className="mx-auto h-7 w-7 opacity-40" style={{ color: MUTED }} />
          <p className="mt-3 text-[14px] font-medium">No agents yet</p>
          <p className="mt-1 text-[12.5px]" style={{ color: MUTED }}>An agent appears here the first time its SDK calls the gateway.</p>
        </div>
      )}
      {!isLoading && agents.length > 0 && (
        <ul className="rounded-2xl border overflow-hidden" style={{ borderColor: BORDER, background: BG }}>
          {agents.map((a: any) => {
            const act = actOf(a)
            const tools = act ? Array.from(act.tools).slice(0, 7) : []
            const label = friendlyAgent(a.id, a.name)
            const initial = label.replace(/^Agent /, '').charAt(0).toUpperCase()
            return (
              <li key={a.id} className="border-t first:border-t-0" style={{ borderColor: BORDER }}>
                <button onClick={() => setSelected(a)} className="w-full text-left px-5 py-4 grid gap-x-6 gap-y-2 items-center hover:bg-[hsl(var(--secondary)/0.5)] transition-colors"
                        style={{ gridTemplateColumns: 'minmax(220px, 1.4fr) minmax(160px, 1fr) repeat(3, minmax(64px, auto)) minmax(90px, auto) 24px' }}>
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-[15px] font-semibold"
                          style={{ background: 'hsl(var(--secondary))', color: TEXT }}>{initial}</span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-[14.5px] font-semibold truncate">{label}</p>
                        <StatusBadge s={a.status} />
                      </div>
                      <p className="text-[12px] truncate" style={{ color: MUTED }}>
                        {a.owner_email ? a.owner_email : a.name && a.name !== a.id ? <span className="font-mono">{a.id.slice(0, 24)}</span> : 'No owner set'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 min-w-0">
                    {tools.length ? tools.map(tn => <ToolIcon key={tn} name={tn} size={18} />) : <span className="text-[12px]" style={{ color: MUTED }}>No calls yet</span>}
                    {act && act.tools.size > 7 && <span className="text-[11.5px]" style={{ color: MUTED }}>+{act.tools.size - 7}</span>}
                  </div>
                  <Stat n={act?.calls ?? 0} label="calls" />
                  <Stat n={act?.held ?? 0} label="held" tone={act?.held ? 'hsl(32 95% 36%)' : undefined} />
                  <Stat n={act?.blocked ?? 0} label="blocked" tone={act?.blocked ? 'hsl(0 72% 42%)' : undefined} />
                  <span className="text-[12.5px] text-right" style={{ color: MUTED }}>{fmtTs(act?.last ?? a.last_seen ?? a.last_seen_at)}</span>
                  <span className="text-right" style={{ color: MUTED }}>→</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {/* Register modal */}
      {showRegister && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setShowRegister(false)}>
          <div
            className="w-full max-w-md rounded-xl p-5 space-y-3"
            style={{ background: BG, border: `1px solid ${BORDER}` }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-sm">Register agent</h2>
              <button onClick={() => setShowRegister(false)} style={{ color: MUTED }}><X className="h-4 w-4" /></button>
            </div>
            <form onSubmit={submitRegister} className="space-y-3">
              <Field label="Name" value={form.name} onChange={v => setForm({ ...form, name: v })} placeholder="data-bot" />
              <Field label="Owner email" value={form.owner_email} onChange={v => setForm({ ...form, owner_email: v })} placeholder="ops@acme.com" type="email" />
              <Field label="Promote existing agent_id (optional)" value={form.id} onChange={v => setForm({ ...form, id: v })} placeholder="<uuid>" mono />
              <Field label="Description" value={form.description} onChange={v => setForm({ ...form, description: v })} placeholder="What this agent does" />
              <Field
                label="Declared tools (comma-separated)"
                value={form.declared_tools}
                onChange={v => setForm({ ...form, declared_tools: v })}
                placeholder="web_search, send_email, run_query"
                mono
              />
              <div>
                <label className="text-[11px] uppercase tracking-wider block mb-1" style={{ color: MUTED }}>Environments</label>
                <div className="flex gap-1">
                  {(['dev', 'staging', 'prod'] as const).map(e => {
                    const on = form.environments.includes(e)
                    return (
                      <button
                        type="button"
                        key={e}
                        onClick={() => setForm({
                          ...form,
                          environments: on
                            ? form.environments.filter(x => x !== e)
                            : [...form.environments, e],
                        })}
                        className="text-[11px] px-2 py-1 rounded border"
                        style={{
                          background: on ? 'hsl(var(--primary))' : 'transparent',
                          color: on ? 'hsl(var(--primary-foreground))' : MUTED,
                          borderColor: on ? 'hsl(var(--primary))' : BORDER,
                        }}
                      >{e}</button>
                    )
                  })}
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs" style={{ color: TEXT }}>
                <input
                  type="checkbox"
                  checked={form.issue_secret}
                  onChange={e => setForm({ ...form, issue_secret: e.target.checked })}
                />
                Issue agent secret (returned once; agent must send X-AEGIS-Agent-Secret on every call)
              </label>
              {formError && (
                <div className="text-[11px] inline-flex items-start gap-1.5" style={{ color: 'hsl(0 60% 40%)' }}>
                  <AlertCircle className="h-3 w-3 flex-shrink-0 mt-0.5" /> {formError}
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowRegister(false)} className="text-xs px-3 py-1.5" style={{ color: MUTED }}>Cancel</button>
                <button
                  type="submit"
                  disabled={registering}
                  className="text-xs px-3 py-1.5 rounded-md inline-flex items-center gap-1.5 disabled:opacity-40"
                  style={{ background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}
                >
                  {registering && <Loader2 className="h-3 w-3 animate-spin" />} Register
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Secret display modal — one-time view */}
      {newSecret && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div
            className="w-full max-w-md rounded-xl p-5 space-y-3"
            style={{ background: BG, border: `1px solid hsl(220 14% 82%)` }}
          >
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4" style={{ color: 'hsl(0 0% 0%)' }} />
              <h2 className="font-semibold text-sm">Agent secret (shown once)</h2>
            </div>
            <p className="text-xs" style={{ color: MUTED }}>
              Copy this now. AEGIS only stores the SHA-256 hash; this plaintext is unrecoverable after you close this dialog.
            </p>
            <div
              className="font-mono text-xs p-2 rounded border break-all"
              style={{ background: 'hsl(var(--secondary))', borderColor: BORDER }}
            >{newSecret}</div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={async () => {
                  await navigator.clipboard.writeText(newSecret)
                  setSecretCopied(true)
                  setTimeout(() => setSecretCopied(false), 1500)
                }}
                className="text-xs px-3 py-1.5 rounded-md inline-flex items-center gap-1.5"
                style={{ background: 'hsl(var(--accent))', color: 'hsl(var(--accent-foreground))' }}
              >
                {secretCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {secretCopied ? 'Copied' : 'Copy'}
              </button>
              <button
                onClick={() => { setNewSecret(null); setShowRegister(false); setSecretCopied(false) }}
                className="text-xs px-3 py-1.5 rounded-md"
                style={{ background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}
              >I saved it</button>
            </div>
          </div>
        </div>
      )}

      {/* Detail panel */}
      {selected && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" onClick={() => setSelected(null)}>
          <div
            className="w-full max-w-lg rounded-xl p-5 space-y-3"
            style={{ background: BG, border: `1px solid ${BORDER}` }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <StatusBadge s={selected.status} />
                  <h2 className="font-semibold text-sm">{selected.name ?? '(unnamed agent)'}</h2>
                </div>
                <div className="text-[10px] font-mono mt-1" style={{ color: MUTED }}>{selected.id}</div>
              </div>
              <button onClick={() => setSelected(null)} style={{ color: MUTED }}><X className="h-4 w-4" /></button>
            </div>
            <KV k="Owner"        v={selected.owner_email ?? '—'} />
            <KV k="Description"  v={selected.description ?? '—'} />
            <KV k="Declared tools" v={selected.declared_tools?.length ? selected.declared_tools.join(', ') : <em>any (no scope declared)</em>} />
            <KV k="Environments" v={selected.environments?.join(', ') || '—'} />
            <KV k="Max cost (daily, USD)" v={selected.max_cost_daily_usd != null ? `$${selected.max_cost_daily_usd}` : <em>inherit tenant</em>} />
            <KV k="Has secret"   v={selected.has_secret ? 'yes' : 'no'} />
            <KV k="Created"      v={fmtTs(selected.created_at)} />
            <KV k="Last seen"    v={fmtTs(selected.last_seen_at)} />
            <div className="flex flex-wrap gap-2 pt-3 border-t" style={{ borderColor: BORDER }}>
              {selected.status === 'active' && (
                <button
                  onClick={() => setStatus(selected, 'suspended')}
                  className="text-[11px] px-2 py-1.5 rounded border inline-flex items-center gap-1.5"
                  style={{ color: 'hsl(25 22% 40%)', borderColor: 'hsl(25 12% 80%)' }}
                ><ShieldOff className="h-3 w-3" /> Suspend</button>
              )}
              {selected.status === 'suspended' && (
                <button
                  onClick={() => setStatus(selected, 'active')}
                  className="text-[11px] px-2 py-1.5 rounded border inline-flex items-center gap-1.5"
                  style={{ color: 'hsl(150 18% 36%)', borderColor: 'hsl(150 10% 80%)' }}
                ><Shield className="h-3 w-3" /> Reactivate</button>
              )}
              <button
                onClick={() => rotateSecret(selected)}
                className="text-[11px] px-2 py-1.5 rounded border inline-flex items-center gap-1.5"
                style={{ color: TEXT, borderColor: BORDER }}
              ><KeyRound className="h-3 w-3" /> Rotate secret</button>
              {selected.status !== 'deprecated' && (
                <button
                  onClick={() => deprecate(selected)}
                  className="text-[11px] px-2 py-1.5 rounded border inline-flex items-center gap-1.5 ml-auto"
                  style={{ color: 'hsl(0 14% 44%)', borderColor: 'hsl(0 10% 80%)' }}
                ><Trash2 className="h-3 w-3" /> Deprecate</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, value, onChange, placeholder, type = 'text', mono = false }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string; mono?: boolean
}) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-wider block mb-1" style={{ color: MUTED }}>{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full text-sm px-3 py-1.5 rounded-md border ${mono ? 'font-mono text-xs' : ''}`}
        style={{ background: BG, borderColor: BORDER, color: TEXT }}
      />
    </div>
  )
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 text-xs">
      <div style={{ color: MUTED }}>{k}</div>
      <div className="col-span-2" style={{ color: TEXT }}>{v}</div>
    </div>
  )
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: string }) {
  return (
    <span className="text-right leading-tight">
      <span className="block text-[15px] font-semibold tabular-nums" style={{ color: n ? (tone ?? 'hsl(var(--foreground))') : 'hsl(var(--muted-foreground))' }}>{n.toLocaleString()}</span>
      <span className="block text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>{label}</span>
    </span>
  )
}
