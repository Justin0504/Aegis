'use client'

import { useEffect, useMemo, useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { fmtWhen } from '@/lib/time'
import { useQuery } from '@tanstack/react-query'
import { gw } from '@/lib/gateway'
import { FileText, Download, ChevronLeft, ChevronRight, ShieldCheck } from 'lucide-react'
import { IntegrityWidget } from './integrity-widget'
import { EvidencePackWidget } from './evidence-pack-widget'
import { USE_MOCK, mockAuditEntries } from '@/lib/mock-traces'

const BORDER  = 'hsl(var(--border))'
const TEXT    = 'hsl(var(--foreground))'
const MUTED   = 'hsl(var(--muted-foreground))'
const SURFACE = 'hsl(var(--card))'
const BG      = 'hsl(var(--background))'

// Action filters — must mirror packages/gateway-mcp/src/services/audit-log.ts
// `AuditAction` exactly. Selecting an action that the server never emits
// silently returns zero rows, which looks like a Cockpit bug to the
// auditor (it's actually filter drift). Grouped by domain for scan-ability;
// labels stay equal to values so it's obvious there's no friendly remapping
// hiding under the hood.
const ACTION_FILTERS: { label: string; value: string }[] = [
  { label: 'All actions', value: '' },
  // Judge (alignment + code-shield + evidence-pack export) — most-common
  { label: 'judge.trace (alignment / code-shield / evidence-pack)', value: 'judge.trace' },
  { label: 'judge.batch', value: 'judge.batch' },
  // Tenant config + DSL (DSL changes are recorded as tenant.config.*)
  { label: 'tenant.config.update', value: 'tenant.config.update' },
  { label: 'tenant.config.replace', value: 'tenant.config.replace' },
  { label: 'tenant.config.apply-template', value: 'tenant.config.apply-template' },
  // Policies
  { label: 'policy.create', value: 'policy.create' },
  { label: 'policy.update', value: 'policy.update' },
  { label: 'policy.delete', value: 'policy.delete' },
  { label: 'policy.toggle', value: 'policy.toggle' },
  // Approvals
  { label: 'approval.approve', value: 'approval.approve' },
  { label: 'approval.reject', value: 'approval.reject' },
  // API keys
  { label: 'apikey.create', value: 'apikey.create' },
  { label: 'apikey.revoke', value: 'apikey.revoke' },
  { label: 'apikey.regenerate', value: 'apikey.regenerate' },
  // Kill switch
  { label: 'killswitch.revoke', value: 'killswitch.revoke' },
  { label: 'killswitch.restore', value: 'killswitch.restore' },
  // Users + orgs
  { label: 'user.create', value: 'user.create' },
  { label: 'user.update', value: 'user.update' },
  { label: 'user.delete', value: 'user.delete' },
  { label: 'user.invite', value: 'user.invite' },
  { label: 'org.create', value: 'org.create' },
  { label: 'org.update', value: 'org.update' },
  { label: 'org.settings', value: 'org.settings' },
  // Retention
  { label: 'retention.update', value: 'retention.update' },
  { label: 'retention.purge', value: 'retention.purge' },
  // Webhooks
  { label: 'webhook.create', value: 'webhook.create' },
  { label: 'webhook.delete', value: 'webhook.delete' },
  // Data movement
  { label: 'data.export', value: 'data.export' },
  { label: 'data.seed', value: 'data.seed' },
]

const RESOURCE_FILTERS: { label: string; value: string }[] = [
  { label: 'Any resource', value: '' },
  { label: 'agent', value: 'agent' },
  { label: 'tenant', value: 'tenant' },
  { label: 'policy', value: 'policy' },
  { label: 'retention', value: 'retention' },
]

const PAGE_SIZE = 50

interface AuditEntry {
  id: number
  org_id: string | null
  user_email: string | null
  action: string
  resource_type: string | null
  resource_id: string | null
  details: string | Record<string, unknown> | null
  ip_address: string | null
  created_at: string
}

/**
 * Audit-log rows store `details` as JSON in the gateway DB but the
 * server returns it parsed (Record) for some action types and as a
 * raw string for others. Either way the cell needs a printable string.
 */
function renderDetails(d: string | Record<string, unknown> | null | undefined): string {
  if (d == null) return ''
  if (typeof d === 'string') return d
  try { return JSON.stringify(d) } catch { return String(d) }
}

function fmtTime(s: string): string {
  return fmtWhen(s)
}

/** What happened, in a sentence, for the actions the gateway writes most. */
function describeAudit(action: string, d: any): string | null {
  if (!d || typeof d !== 'object') return null
  switch (action) {
    case 'tenant.config.update': {
      const L = d.layers ?? {}
      const on = ['l1', 'l2', 'l3'].filter(k => L[k]?.enabled !== false && L[k] != null).map(k => k.toUpperCase())
      const parts = [d.deploymentMode ? `deployment mode set to ${d.deploymentMode}` : null,
                     on.length ? `${on.join(', ')} on` : null,
                     d.retentionDays ? `retention ${d.retentionDays} days` : null].filter(Boolean)
      return parts.length ? parts.join(' · ').replace(/^\w/, c => c.toUpperCase()) : 'Tenant configuration updated'
    }
    case 'judge.trace':
      return d.kind === 'alignment'
        ? `Alignment auditor scored ${Number(d.score ?? 0).toFixed(2)}${d.drifted ? ', drifted' : ''}${Array.isArray(d.signals) && d.signals.length ? ` (${d.signals.join(', ')})` : ''}`
        : `Trace judged${d.score != null ? `: ${d.score}` : ''}`
    case 'policy.toggle': return d.enabled ? 'Policy enabled' : 'Policy disabled'
    case 'policy.create': return `Policy created${d.name ? `: ${d.name}` : ''}${d.risk_level ? ` (${String(d.risk_level).toLowerCase()})` : ''}`
    case 'policy.delete': return 'Policy deleted'
    case 'policy.pack_install': return `Pack ${d.name ?? ''} installed: ${d.created_count ?? 0} rules added${d.skipped_count ? `, ${d.skipped_count} kept as customised` : ''}`
    case 'apikey.create': return `API key created${d.name ? `: ${d.name}` : ''}${d.prefix ? ` (${d.prefix}…)` : ''}`
    case 'apikey.revoke': return 'API key revoked'
    case 'apikey.regenerate': return 'API key regenerated'
    case 'retention.update': return `Retention set to ${d.retention_days} days${d.enabled === false ? ' (disabled)' : ''}`
    case 'retention.purge': return 'Expired traces purged'
    case 'user.invite': return `Invited ${d.email ?? 'a user'}${d.role ? ` as ${d.role}` : ''}`
    case 'user.create': return `User created${d.email ? `: ${d.email}` : ''}`
    case 'user.update': return `User updated${Array.isArray(d.changed_keys) ? `: ${d.changed_keys.join(', ')}` : ''}`
    case 'org.create': return `Organisation created${d.name ? `: ${d.name}` : ''}`
    case 'admin.bulk_register': return `${d.succeeded ?? 0} of ${d.requested ?? 0} agents registered`
    case 'mcp.tool_pinned': return 'MCP tool pinned at first sight'
    case 'mcp.tool_changed': return 'MCP tool changed after approval; refused until re-pinned'
    case 'mcp.tool_suspicious': return `MCP tool description instructs the model${Array.isArray(d.markers) && d.markers.length ? ` (${d.markers.join(', ')})` : ''}`
    case 'mcp.tool_repinned': return 'MCP tool re-pinned by an operator'
    case 'rollback.compensate': return 'Rollback step executed'
    case 'predeploy.scan': return 'Pre-deployment scan run'
    case 'data.export': return 'Data exported'
    default: return null
  }
}

/** Fallback: the top-level fields as "key value" pairs, never raw JSON. */
function detailPairs(d: any): Array<[string, string]> {
  if (!d || typeof d !== 'object') return []
  return Object.entries(d).slice(0, 5).map(([k, v]) => [k.replace(/[_-]+/g, ' '),
    typeof v === 'object' ? (Array.isArray(v) ? `${v.length} items` : 'details') : String(v)])
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  // Wrap in quotes if it contains comma / quote / newline; double-up internal quotes.
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export function AuditLogView() {
  const [action, setAction] = useState<string>('')
  const [resourceType, setResourceType] = useState<string>('')
  const [resourceId, setResourceId] = useState<string>('')
  const [searchQ, setSearchQ] = useState<string>('')
  const [searchInput, setSearchInput] = useState<string>('')
  const [from, setFrom] = useState<string>('')
  const [to, setTo] = useState<string>('')
  const [offset, setOffset] = useState<number>(0)

  // Reset pagination whenever filters change.
  useEffect(() => {
    setOffset(0)
  }, [action, resourceType, resourceId, searchQ, from, to])

  // Debounce free-text search so we don't fetch on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setSearchQ(searchInput.trim()), 350)
    return () => clearTimeout(t)
  }, [searchInput])

  const queryParams = useMemo(() => {
    const sp = new URLSearchParams()
    sp.set('limit', String(PAGE_SIZE))
    sp.set('offset', String(offset))
    if (action) sp.set('action', action)
    if (resourceType) sp.set('resource_type', resourceType)
    if (resourceId.trim()) sp.set('resource_id', resourceId.trim())
    if (searchQ) sp.set('q', searchQ)
    if (from) sp.set('from', from)
    if (to) sp.set('to', to)
    return sp.toString()
  }, [action, resourceType, resourceId, searchQ, from, to, offset])

  const { data, isLoading, error } = useQuery({
    enabled: !USE_MOCK,
    queryKey: ['audit-log', queryParams],
    queryFn: async () => {
      const res = await gw(`admin/audit-log?${queryParams}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as { entries: AuditEntry[]; total: number }
    },
    refetchInterval: 30_000,
  })

  // Client-side filter for mock (cheap; we have ≤15 rows)
  const mockEntries = USE_MOCK ? mockAuditEntries().filter((e: any) => {
    if (action && e.action !== action) return false
    if (resourceType && e.resource_type !== resourceType) return false
    if (resourceId && e.resource_id !== resourceId) return false
    if (searchQ) {
      const hay = `${e.action} ${e.resource_id ?? ''} ${e.user_email} ${JSON.stringify(e.details)}`.toLowerCase()
      if (!hay.includes(searchQ.toLowerCase())) return false
    }
    return true
  }) : null

  const entries = USE_MOCK ? (mockEntries as any[]) : (data?.entries ?? [])
  const total = USE_MOCK ? (mockEntries?.length ?? 0) : (data?.total ?? 0)

  function exportCsv() {
    const headers = [
      'id', 'created_at', 'org_id', 'user_email', 'action',
      'resource_type', 'resource_id', 'ip_address', 'details',
    ]
    const lines = [headers.join(',')]
    for (const e of entries) {
      const detailsPretty = renderDetails(e.details)
      lines.push([
        csvEscape(e.id),
        csvEscape(e.created_at),
        csvEscape(e.org_id),
        csvEscape(e.user_email),
        csvEscape(e.action),
        csvEscape(e.resource_type),
        csvEscape(e.resource_id),
        csvEscape(e.ip_address),
        csvEscape(detailsPretty),
      ].join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `aegis-audit-log-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(a.href)
  }

  const start = total === 0 ? 0 : offset + 1
  const end = Math.min(offset + PAGE_SIZE, total)

  // When a row's resource_type='agent' is clicked, drop that agent_id
  // into the IntegrityWidget so the reviewer can verify with one tap
  // instead of copy-pasting.
  const [verifyTarget, setVerifyTarget] = useState<string>('')

  return (
    <div className="space-y-4">
      {/* Header */}
      <PageHeader title="Audit Log" subtitle="Every change an operator made and every verdict a judge gave, hash-chained so it cannot be edited after the fact." />

      {/* Two-column row of compliance affordances: integrity verify
          (read-only check) + evidence-pack download (frozen snapshot
          for auditor handoff). Stacks on mobile. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <IntegrityWidget
          initialAgentId={verifyTarget}
          onAgentIdChange={setVerifyTarget}
        />
        <EvidencePackWidget />
      </div>

      {/* Filters */}
      <div
        className="rounded-md p-3 grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-2 items-end"
        style={{ background: SURFACE, border: `1px solid ${BORDER}` }}
      >
        <div>
          <label className="text-[10px] uppercase tracking-wider block mb-1" style={{ color: MUTED }}>
            Action
          </label>
          <select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="w-full text-sm px-2 py-1.5 rounded-md border"
            style={{ background: BG, borderColor: BORDER, color: TEXT }}
          >
            {ACTION_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider block mb-1" style={{ color: MUTED }}>
            Resource type
          </label>
          <select
            value={resourceType}
            onChange={(e) => setResourceType(e.target.value)}
            className="w-full text-sm px-2 py-1.5 rounded-md border"
            style={{ background: BG, borderColor: BORDER, color: TEXT }}
          >
            {RESOURCE_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider block mb-1" style={{ color: MUTED }}>
            Resource ID
          </label>
          <input
            value={resourceId}
            onChange={(e) => setResourceId(e.target.value)}
            placeholder="agent-uuid…"
            className="w-full text-sm px-2 py-1.5 rounded-md border font-mono"
            style={{ background: BG, borderColor: BORDER, color: TEXT }}
          />
        </div>
        <div className="md:col-span-1 lg:col-span-1">
          <label className="text-[10px] uppercase tracking-wider block mb-1" style={{ color: MUTED }}>
            Search (action / id / details)
          </label>
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="substring…"
            className="w-full text-sm px-2 py-1.5 rounded-md border"
            style={{ background: BG, borderColor: BORDER, color: TEXT }}
          />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider block mb-1" style={{ color: MUTED }}>
            From
          </label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-full text-sm px-2 py-1.5 rounded-md border"
            style={{ background: BG, borderColor: BORDER, color: TEXT }}
          />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider block mb-1" style={{ color: MUTED }}>
            To
          </label>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-full text-sm px-2 py-1.5 rounded-md border"
            style={{ background: BG, borderColor: BORDER, color: TEXT }}
          />
        </div>
      </div>

      {/* Status row */}
      <div
        className="flex items-center justify-between text-xs px-3 py-2 rounded-md border"
        style={{ background: SURFACE, borderColor: BORDER, color: MUTED }}
      >
        <span className="inline-flex items-center gap-1.5">
          <FileText className="h-3.5 w-3.5" />
          {isLoading ? 'Loading…' : `Showing ${start}–${end} of ${total.toLocaleString()}`}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={exportCsv}
            disabled={entries.length === 0}
            className="inline-flex items-center gap-1 px-2 py-1 rounded border disabled:opacity-40"
            style={{ background: BG, borderColor: BORDER, color: TEXT }}
            title="Export current page as CSV"
          >
            <Download className="h-3 w-3" /> CSV (this page)
          </button>
          <button
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            className="inline-flex items-center px-2 py-1 rounded border disabled:opacity-40"
            style={{ background: BG, borderColor: BORDER, color: TEXT }}
          >
            <ChevronLeft className="h-3 w-3" />
          </button>
          <button
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
            className="inline-flex items-center px-2 py-1 rounded border disabled:opacity-40"
            style={{ background: BG, borderColor: BORDER, color: TEXT }}
          >
            <ChevronRight className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Entries table */}
      {error && (
        <div
          className="rounded-md p-3 text-xs"
          style={{ background: SURFACE, border: `1px solid ${BORDER}`, color: 'hsl(var(--status-drift))' }}
        >
          Could not load audit log: {(error as Error).message}. The endpoint
          requires the admin role — make sure your API key has it.
        </div>
      )}

      {!error && (
        <div
          className="rounded-md overflow-hidden"
          style={{ background: SURFACE, border: `1px solid ${BORDER}` }}
        >
          <table className="w-full text-[12px]">
            <thead>
              <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                <th className="text-left px-3 py-2 font-medium" style={{ color: MUTED }}>Time</th>
                <th className="text-left px-3 py-2 font-medium" style={{ color: MUTED }}>Action</th>
                <th className="text-left px-3 py-2 font-medium" style={{ color: MUTED }}>Resource</th>
                <th className="text-left px-3 py-2 font-medium" style={{ color: MUTED }}>Org / User</th>
                <th className="text-left px-3 py-2 font-medium" style={{ color: MUTED }}>Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} style={{ borderTop: `1px solid ${BORDER}` }}>
                  <td className="px-3 py-1.5 align-top font-mono" style={{ color: MUTED, whiteSpace: 'nowrap' }}>
                    {fmtTime(e.created_at)}
                  </td>
                  <td className="px-3 py-1.5 align-top font-mono" style={{ color: TEXT }}>
                    {e.action}
                  </td>
                  <td className="px-3 py-1.5 align-top" style={{ color: TEXT }}>
                    <span style={{ color: MUTED }}>{e.resource_type ?? '—'}</span>
                    {e.resource_id && (
                      e.resource_type === 'agent' ? (
                        // Click an agent row to feed the IntegrityWidget
                        // above; saves the auditor a copy-paste.
                        <button
                          type="button"
                          onClick={() => {
                            setVerifyTarget(e.resource_id!)
                            // Bring widget into view if user scrolled down.
                            window.scrollTo({ top: 0, behavior: 'smooth' })
                          }}
                          title="Click to verify this agent's chain"
                          className="font-mono ml-1 inline-flex items-center gap-1 underline decoration-dotted underline-offset-2"
                          style={{ color: TEXT, background: 'transparent', cursor: 'pointer' }}
                        >
                          <ShieldCheck className="h-3 w-3" style={{ color: MUTED }} />
                          {e.resource_id.length > 12 ? e.resource_id.slice(0, 8) + '…' : e.resource_id}
                        </button>
                      ) : (
                        <span className="font-mono ml-1" style={{ color: TEXT }}>
                          {e.resource_id.length > 12 ? e.resource_id.slice(0, 8) + '…' : e.resource_id}
                        </span>
                      )
                    )}
                  </td>
                  <td className="px-3 py-1.5 align-top" style={{ color: MUTED }}>
                    {e.org_id ?? '—'}{e.user_email ? ` · ${e.user_email}` : ''}
                  </td>
                  <td className="px-3 py-1.5 align-top text-[12.5px]" style={{ color: TEXT, maxWidth: '60ch' }}>
                    {(() => {
                      const d = typeof e.details === 'string' ? (() => { try { return JSON.parse(e.details) } catch { return e.details } })() : e.details
                      const sentence = describeAudit(e.action, d)
                      if (sentence) return <span className="block truncate" title={renderDetails(e.details)}>{sentence}</span>
                      const pairs = detailPairs(d)
                      if (!pairs.length) return <span style={{ color: MUTED }}>{typeof d === 'string' ? d : '—'}</span>
                      return (
                        <span className="flex flex-wrap gap-x-3 gap-y-0.5" title={renderDetails(e.details)}>
                          {pairs.map(([k, v]) => <span key={k}><span style={{ color: MUTED }}>{k}</span> {v}</span>)}
                        </span>
                      )
                    })()}
                  </td>
                </tr>
              ))}
              {entries.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center" style={{ color: MUTED }}>
                    No entries match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
