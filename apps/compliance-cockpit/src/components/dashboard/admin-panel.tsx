'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { gw } from '@/lib/gateway'
import {
  Building2, Users, Key, Shield, Clock, BarChart3,
  Activity, Plus, Trash2, ChevronDown, ChevronRight,
} from 'lucide-react'

const MUTED  = 'hsl(30 8% 55%)'
const TEXT   = 'hsl(30 10% 15%)'
const BORDER = 'hsl(36 12% 88%)'
const ACCENT = 'hsl(36 60% 50%)'
const GREEN  = 'hsl(142 50% 36%)'
const RED    = 'hsl(0 60% 50%)'
const BLUE   = 'hsl(210 60% 50%)'

function Section({ title, icon: Icon, children, defaultOpen = true }: {
  title: string; icon: any; children: React.ReactNode; defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={{ borderRadius: 8, border: `1px solid ${BORDER}`, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          padding: '12px 16px', background: 'hsl(36 20% 98%)',
          border: 'none', cursor: 'pointer', color: TEXT,
          fontSize: 14, fontWeight: 600, textAlign: 'left',
        }}
      >
        <Icon size={16} style={{ color: ACCENT }} />
        {title}
        <span style={{ marginLeft: 'auto', color: MUTED }}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>
      {open && <div style={{ padding: 16 }}>{children}</div>}
    </div>
  )
}

function StatCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{
      padding: '12px 16px', borderRadius: 6, border: `1px solid ${BORDER}`,
      textAlign: 'center', minWidth: 100,
    }}>
      <div style={{ fontSize: 11, color: MUTED, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: color ?? TEXT }}>{value}</div>
    </div>
  )
}

export function AdminPanel() {
  const qc = useQueryClient()

  // ── Data fetching ──────────────────────────────────────────────────────
  const { data: orgs } = useQuery({
    queryKey: ['admin-orgs'],
    queryFn: async () => {
      const res = await gw('admin/orgs')
      return res.ok ? (await res.json()).organizations : []
    },
  })

  const { data: auditLog } = useQuery({
    queryKey: ['admin-audit'],
    queryFn: async () => {
      const res = await gw('admin/audit-log?limit=15')
      return res.ok ? await res.json() : { entries: [], total: 0 }
    },
    refetchInterval: 30_000,
  })

  const { data: sla } = useQuery({
    queryKey: ['admin-sla'],
    queryFn: async () => {
      const res = await gw('admin/sla?hours=24')
      return res.ok ? await res.json() : null
    },
    refetchInterval: 60_000,
  })

  const { data: retention } = useQuery({
    queryKey: ['admin-retention'],
    queryFn: async () => {
      const res = await gw('admin/retention')
      return res.ok ? (await res.json()).policies : []
    },
  })

  const defaultOrg = orgs?.[0]

  const { data: usage } = useQuery({
    queryKey: ['admin-usage', defaultOrg?.id],
    queryFn: async () => {
      if (!defaultOrg?.id) return null
      const res = await gw(`admin/usage/${defaultOrg.id}`)
      return res.ok ? await res.json() : null
    },
    enabled: !!defaultOrg?.id,
  })

  const { data: users } = useQuery({
    queryKey: ['admin-users', defaultOrg?.id],
    queryFn: async () => {
      if (!defaultOrg?.id) return []
      const res = await gw(`admin/orgs/${defaultOrg.id}/users`)
      return res.ok ? (await res.json()).users : []
    },
    enabled: !!defaultOrg?.id,
  })

  const { data: apiKeys } = useQuery({
    queryKey: ['admin-keys', defaultOrg?.id],
    queryFn: async () => {
      if (!defaultOrg?.id) return []
      const res = await gw(`admin/orgs/${defaultOrg.id}/keys`)
      return res.ok ? (await res.json()).keys : []
    },
    enabled: !!defaultOrg?.id,
  })

  return (
    <div className="space-y-4">
      {/* SLA Overview */}
      <Section title="SLA Metrics (24h)" icon={Activity}>
        {sla ? (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <StatCard label="Uptime" value={`${sla.uptime_pct}%`} color={sla.uptime_pct >= 99.9 ? GREEN : sla.uptime_pct >= 99 ? ACCENT : RED} />
            <StatCard label="Requests" value={sla.total_requests} />
            <StatCard label="Errors" value={sla.total_errors} color={sla.total_errors > 0 ? RED : GREEN} />
            <StatCard label="P50" value={`${sla.latency.p50}ms`} />
            <StatCard label="P95" value={`${sla.latency.p95}ms`} />
            <StatCard label="P99" value={`${sla.latency.p99}ms`} color={sla.latency.p99 > 1000 ? RED : undefined} />
          </div>
        ) : (
          <span style={{ fontSize: 13, color: MUTED }}>Loading...</span>
        )}
      </Section>

      {/* Usage & Quotas */}
      <Section title="Usage & Quotas" icon={BarChart3}>
        {usage ? (
          <div>
            <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
              Plan: <strong style={{ color: TEXT }}>{usage.plan}</strong> | Period: {usage.period}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {Object.entries(usage.quotas || {}).map(([metric, info]: [string, any]) => {
                const limitStr = info.limit === -1 ? '∞' : info.limit.toLocaleString()
                const pct = Math.min(info.pct, 100)
                const barColor = pct >= 90 ? RED : pct >= 70 ? ACCENT : GREEN
                return (
                  <div key={metric} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 180, fontSize: 13, color: TEXT }}>{metric.replace(/_/g, ' ')}</span>
                    <div style={{
                      flex: 1, height: 6, borderRadius: 3,
                      background: BORDER, overflow: 'hidden',
                    }}>
                      <div style={{
                        width: `${pct}%`, height: '100%', borderRadius: 3,
                        background: barColor, transition: 'width 0.3s',
                      }} />
                    </div>
                    <span style={{ width: 120, fontSize: 12, color: MUTED, textAlign: 'right' }}>
                      {info.current.toLocaleString()} / {limitStr}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          <span style={{ fontSize: 13, color: MUTED }}>Loading...</span>
        )}
      </Section>

      {/* Organizations */}
      <Section title="Organizations" icon={Building2} defaultOpen={false}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(orgs ?? []).map((o: any) => (
            <div key={o.id} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 12px', borderRadius: 6, border: `1px solid ${BORDER}`, fontSize: 13,
            }}>
              <div>
                <span style={{ fontWeight: 600, color: TEXT }}>{o.name}</span>
                <span style={{ marginLeft: 8, fontSize: 11, color: MUTED }}>{o.slug}</span>
              </div>
              <span style={{
                padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600,
                background: o.plan === 'enterprise' ? `${BLUE}15` : o.plan === 'pro' ? `${ACCENT}15` : `${MUTED}15`,
                color: o.plan === 'enterprise' ? BLUE : o.plan === 'pro' ? ACCENT : MUTED,
              }}>
                {o.plan}
              </span>
            </div>
          ))}
        </div>
      </Section>

      {/* Users & RBAC */}
      <Section title="Users & Roles" icon={Users} defaultOpen={false}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {(users ?? []).map((u: any) => (
            <div key={u.id} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '6px 12px', borderRadius: 6, border: `1px solid ${BORDER}`, fontSize: 13,
            }}>
              <div>
                <span style={{ color: TEXT }}>{u.email}</span>
                {u.name && <span style={{ marginLeft: 6, fontSize: 11, color: MUTED }}>({u.name})</span>}
              </div>
              <span style={{
                padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600,
                background: u.role === 'owner' ? `${RED}12` : u.role === 'admin' ? `${ACCENT}12` : `${MUTED}12`,
                color: u.role === 'owner' ? RED : u.role === 'admin' ? ACCENT : MUTED,
              }}>
                {u.role}
              </span>
            </div>
          ))}
          {(!users || users.length === 0) && (
            <span style={{ fontSize: 13, color: MUTED }}>No users yet. Create users via CLI: agentguard admin create-user</span>
          )}
        </div>
      </Section>

      {/* API Keys */}
      <Section title="API Keys" icon={Key} defaultOpen={false}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {(apiKeys ?? []).map((k: any) => (
            <div key={k.id} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '6px 12px', borderRadius: 6, border: `1px solid ${BORDER}`, fontSize: 13,
            }}>
              <div>
                <span style={{ fontFamily: 'monospace', fontSize: 12, color: TEXT }}>{k.key_prefix}...</span>
                <span style={{ marginLeft: 8, color: MUTED }}>{k.name}</span>
              </div>
              <span style={{ fontSize: 11, color: MUTED }}>
                {k.rate_limit}/min | {k.last_used_at ? `used ${k.last_used_at.substring(0, 10)}` : 'never used'}
              </span>
            </div>
          ))}
        </div>
      </Section>

      {/* Data Retention */}
      <Section title="Data Retention" icon={Clock} defaultOpen={false}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {(retention ?? []).map((p: any) => (
            <div key={p.id} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '6px 12px', borderRadius: 6, border: `1px solid ${BORDER}`, fontSize: 13,
            }}>
              <span style={{ color: TEXT }}>{p.resource_type}</span>
              <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <span style={{ fontWeight: 600, color: TEXT }}>{p.retention_days} days</span>
                <span style={{
                  padding: '1px 6px', borderRadius: 3, fontSize: 10, fontWeight: 600,
                  background: p.enabled ? `${GREEN}15` : `${RED}15`,
                  color: p.enabled ? GREEN : RED,
                }}>
                  {p.enabled ? 'ON' : 'OFF'}
                </span>
                {p.last_purge_at && (
                  <span style={{ fontSize: 11, color: MUTED }}>purged {p.last_purge_at.substring(0, 10)}</span>
                )}
              </span>
            </div>
          ))}
        </div>
      </Section>

      {/* Audit Log */}
      <Section title="Admin Audit Log" icon={Shield}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {(auditLog?.entries ?? []).map((e: any, i: number) => (
            <div key={i} style={{
              display: 'flex', gap: 8, padding: '4px 0', fontSize: 12,
              borderBottom: i < (auditLog?.entries?.length ?? 0) - 1 ? `1px solid ${BORDER}` : 'none',
            }}>
              <span style={{ fontFamily: 'monospace', color: MUTED, flexShrink: 0, width: 140 }}>
                {e.created_at?.substring(0, 19)}
              </span>
              <span style={{
                padding: '0 6px', borderRadius: 3, fontSize: 11, fontWeight: 600,
                background: `${ACCENT}12`, color: ACCENT, flexShrink: 0,
              }}>
                {e.action}
              </span>
              <span style={{ color: TEXT, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {e.resource_type}{e.resource_id ? `:${e.resource_id.substring(0, 12)}` : ''}
                {e.details ? ` — ${JSON.stringify(e.details).substring(0, 60)}` : ''}
              </span>
            </div>
          ))}
          {(!auditLog?.entries?.length) && (
            <span style={{ fontSize: 13, color: MUTED }}>No audit entries yet.</span>
          )}
          {auditLog?.total > 15 && (
            <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
              Showing 15 of {auditLog.total} entries
            </div>
          )}
        </div>
      </Section>
    </div>
  )
}
