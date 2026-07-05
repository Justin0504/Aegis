'use client'

/**
 * Rollback approvals — the operator surface for PAUSED_FOR_APPROVAL sagas.
 *
 * Backend contract (see packages/gateway-mcp/src/api/rollback.ts):
 *   GET  /api/v1/rollback/sagas?state=PAUSED_FOR_APPROVAL   -> { sagas: Saga[] }
 *   GET  /api/v1/rollback/sagas/:id                          -> { saga, steps }
 *   POST /api/v1/rollback/sagas/:id/approve                  -> resume
 *   POST /api/v1/rollback/sagas/:id/reject { reason? }       -> abort
 *
 * A saga lands in this queue when either
 *   (a) its compensator's `cost_estimate.magnitude` is 'high' or 'catastrophic', OR
 *   (b) its `origin_ring` is 3 (LLM-originated decision — Toledo et al. arXiv:2606.07119).
 *
 * The UI surfaces both signals so the human approver knows *why* the
 * saga was paused before they click through.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Clock, CheckCircle2, XCircle, AlertTriangle, Sparkles, ShieldAlert, ListTree } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import { friendlyAgent } from '@/lib/friendly-names'
import { SagaTimelineDrawer } from './saga-timeline-drawer'
import { ToolIcon } from '@/lib/tool-icons'

// Pause reasons persisted by the gateway follow one of two shapes:
//   "high-cost <tool_name>: <magnitude> — <note>"
//   "Ring-3 <tool_name>: LLM decision — human approval required"
// We pull the second token out for the row's brand icon. If the shape
// ever drifts (older records from before this format was introduced),
// the match returns null and we fall back to a generic icon.
const CARD_BRAND_HINT_RE = /^(?:high-cost|Ring-3)\s+([A-Za-z0-9_.-]+)\s*:/

function toolFromPauseReason(reason: string | null): string | null {
  if (!reason) return null
  const m = reason.match(CARD_BRAND_HINT_RE)
  return m ? m[1] : null
}

const BORDER = 'hsl(var(--border))'
const MUTED  = 'hsl(var(--muted-foreground))'
const TEXT   = 'hsl(var(--foreground))'
const BG     = 'hsl(var(--background))'
const CARD   = 'hsl(var(--card))'

interface Saga {
  id: string
  org_id: string
  kind: 'rollback_single' | 'rollback_chain'
  state: string
  agent_id: string | null
  root_trace_id: string | null
  started_at: string
  completed_at: string | null
  step_count: number
  reason: string | null
  pause_reason: string | null
  paused_at: string | null
  origin_ring: number | null
}

export function RollbackApprovalsView() {
  const qc = useQueryClient()
  const [pending, setPending] = useState<Record<string, 'approving' | 'rejecting'>>({})
  const [rejectDrafts, setRejectDrafts] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [openSagaId, setOpenSagaId] = useState<string | null>(null)

  // Track tab visibility — under load, 100 cockpit tabs in background
  // polling every 5s = 20 rps hammering /sagas. When the tab is hidden
  // we suspend refetch; browsers already throttle setInterval in bg
  // tabs but that's not universal (Safari's throttle is aggressive,
  // Firefox less so). Explicit gate is cheap and predictable.
  const [tabVisible, setTabVisible] = useState(
    typeof document === 'undefined' ? true : document.visibilityState === 'visible',
  )
  useEffect(() => {
    const onVis = () => setTabVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  const { data, isLoading, isError } = useQuery({
    queryKey: ['rollback-paused-sagas'],
    queryFn: async () => {
      const res = await fetch(
        '/api/gateway/api/v1/rollback/sagas?state=PAUSED_FOR_APPROVAL&limit=100',
      )
      if (!res.ok) throw new Error(`gateway returned ${res.status}`)
      const json = await res.json()
      return (json.sagas ?? []) as Saga[]
    },
    // Refetch only when the tab is visible — background tabs never
    // hit the gateway.
    refetchInterval: tabVisible ? 5000 : false,
    refetchIntervalInBackground: false,
    retry: 1,
  })

  const sagas = data ?? []

  async function decide(saga: Saga, action: 'approve' | 'reject') {
    setPending(p => ({ ...p, [saga.id]: action === 'approve' ? 'approving' : 'rejecting' }))
    try {
      const body = action === 'reject' && rejectDrafts[saga.id]
        ? JSON.stringify({ reason: rejectDrafts[saga.id] })
        : JSON.stringify({})
      const res = await fetch(
        `/api/gateway/api/v1/rollback/sagas/${saga.id}/${action}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        },
      )
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        alert(`${action} failed: ${errBody.error ?? res.statusText}`)
      } else {
        // Refetch — the saga will disappear from the paused list on success.
        await qc.invalidateQueries({ queryKey: ['rollback-paused-sagas'] })
      }
    } catch (err) {
      alert(`${action} failed: ${(err as Error).message}`)
    } finally {
      setPending(p => { const { [saga.id]: _, ...rest } = p; return rest })
    }
  }

  return (
    <div style={{ maxWidth: 1120, margin: '0 auto', padding: '1.5rem 2rem 4rem' }}>
      <header style={{ marginBottom: '1.4rem' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 600, margin: 0, color: TEXT, letterSpacing: '-0.01em' }}>
          Rollback approvals
        </h1>
        <p style={{ margin: '0.35rem 0 0', color: MUTED, fontSize: '0.9rem', lineHeight: 1.55, maxWidth: '70ch' }}>
          Sagas paused waiting on human approval before compensating.
          Any rollback whose compensator is <b>high-cost</b> or whose origin
          is <b>Ring-3 (LLM decision)</b> lands here.
        </p>
      </header>

      {/* Summary strip */}
      <div style={{
        display: 'flex', gap: '1.4rem', flexWrap: 'wrap',
        padding: '0.85rem 1.1rem', borderRadius: 10, background: CARD,
        border: `1px solid ${BORDER}`, marginBottom: '1.2rem',
        fontSize: '0.86rem', color: MUTED,
      }}>
        <span style={{ color: TEXT }}><b>{sagas.length}</b> pending</span>
        <span>·</span>
        <span>{sagas.filter(s => s.origin_ring === 3).length} Ring-3 (LLM origin)</span>
        <span>·</span>
        <span>{sagas.filter(s => (s.pause_reason ?? '').startsWith('high-cost')).length} high-cost compensator</span>
        <span style={{ marginLeft: 'auto', fontFamily: 'ui-monospace, monospace', fontSize: '0.78rem' }}>
          auto-refresh 5s
        </span>
      </div>

      {isLoading && <p style={{ color: MUTED, fontSize: '0.9rem' }}>Loading paused sagas…</p>}
      {isError && (
        <p style={{ color: 'hsl(var(--destructive))', fontSize: '0.9rem' }}>
          Gateway unreachable. Check <code style={{ background: BG, padding: '0 0.3em', borderRadius: 3 }}>GATEWAY_URL</code>.
        </p>
      )}
      {!isLoading && !isError && sagas.length === 0 && (
        <div style={{
          padding: '3rem 1.5rem', textAlign: 'center', border: `1px dashed ${BORDER}`,
          borderRadius: 12, color: MUTED,
        }}>
          <CheckCircle2 size={26} style={{ color: 'hsl(var(--accent-positive, 150 32% 42%))', marginBottom: '0.4rem' }} />
          <p style={{ margin: 0, fontSize: '0.95rem' }}>No pending rollback approvals.</p>
          <p style={{ margin: '0.3rem 0 0', fontSize: '0.82rem' }}>
            Any high-cost or LLM-originated rollback will surface here.
          </p>
        </div>
      )}

      {/* Cards */}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {sagas.map(s => {
          const ring3    = s.origin_ring === 3
          const highCost = (s.pause_reason ?? '').startsWith('high-cost')
          const shortId  = s.id.slice(0, 8)
          const isPendingApprove = pending[s.id] === 'approving'
          const isPendingReject  = pending[s.id] === 'rejecting'

          const toolHint = toolFromPauseReason(s.pause_reason)

          return (
            <li key={s.id} style={{
              padding: '1rem 1.1rem', borderRadius: 12, background: CARD,
              border: `1px solid ${BORDER}`,
            }}>
              <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
                {toolHint && (
                  <div style={{ paddingTop: '0.15rem', flexShrink: 0 }}>
                    <ToolIcon name={toolHint} size={32} />
                  </div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.4rem' }}>
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                      padding: '0.15rem 0.5rem', borderRadius: 4, background: 'hsl(45 40% 88%)',
                      color: 'hsl(35 60% 25%)', fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.03em',
                    }}>
                      <Clock size={11} />PAUSED
                    </span>

                    {ring3 && (
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                        padding: '0.15rem 0.5rem', borderRadius: 4, background: 'hsl(280 40% 92%)',
                        color: 'hsl(280 45% 30%)', fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.03em',
                      }} title="Origin Ring-3 (LLM decision) — Toledo et al. arXiv:2606.07119">
                        <Sparkles size={11} />RING-3
                      </span>
                    )}
                    {highCost && (
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                        padding: '0.15rem 0.5rem', borderRadius: 4, background: 'hsl(0 45% 92%)',
                        color: 'hsl(0 55% 32%)', fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.03em',
                      }}>
                        <ShieldAlert size={11} />HIGH-COST
                      </span>
                    )}

                    <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.78rem', color: MUTED }}>
                      saga:{shortId} · {s.kind === 'rollback_chain' ? 'chain' : 'single'}
                      {s.step_count > 0 && ` · ${s.step_count} step${s.step_count === 1 ? '' : 's'}`}
                    </span>
                  </div>

                  <p style={{ margin: '0 0 0.35rem', fontSize: '0.94rem', color: TEXT, fontWeight: 500 }}>
                    {s.pause_reason ?? '(no pause reason recorded)'}
                  </p>

                  <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', fontSize: '0.8rem', color: MUTED }}>
                    {s.agent_id && (
                      <span>Agent: <b style={{ color: TEXT }}>{friendlyAgent(s.agent_id)}</b></span>
                    )}
                    {s.root_trace_id && (
                      <span>
                        Root trace:{' '}
                        <Link
                          href={`/traces/${s.root_trace_id}`}
                          style={{ color: TEXT, textDecoration: 'underline', textUnderlineOffset: 3, textDecorationColor: BORDER }}
                        >
                          {s.root_trace_id.slice(0, 8)}
                        </Link>
                      </span>
                    )}
                    {s.paused_at && <span>Paused: {formatDate(s.paused_at)}</span>}
                    <button
                      onClick={() => setOpenSagaId(s.id)}
                      style={{
                        background: 'none', border: 0, padding: 0, color: MUTED,
                        textDecoration: 'underline', cursor: 'pointer', fontSize: '0.8rem',
                        display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                      }}
                      title="Open saga step timeline"
                    >
                      <ListTree size={11} />
                      View timeline
                    </button>
                    {s.reason && (
                      <button
                        onClick={() => setExpanded(x => ({ ...x, [s.id]: !x[s.id] }))}
                        style={{
                          background: 'none', border: 0, padding: 0, color: MUTED,
                          textDecoration: 'underline', cursor: 'pointer', fontSize: '0.8rem',
                        }}
                      >
                        {expanded[s.id] ? 'Hide' : 'Show'} operator reason
                      </button>
                    )}
                  </div>

                  {expanded[s.id] && s.reason && (
                    <pre style={{
                      margin: '0.5rem 0 0', padding: '0.6rem 0.8rem',
                      background: BG, border: `1px solid ${BORDER}`, borderRadius: 6,
                      fontFamily: 'ui-monospace, monospace', fontSize: '0.78rem',
                      color: TEXT, whiteSpace: 'pre-wrap', lineHeight: 1.5,
                    }}>{s.reason}</pre>
                  )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', flexShrink: 0, minWidth: 100 }}>
                  <button
                    onClick={() => decide(s, 'approve')}
                    disabled={isPendingApprove || isPendingReject}
                    style={{
                      padding: '0.45rem 0.9rem', borderRadius: 6,
                      background: TEXT, color: BG, border: 0,
                      fontSize: '0.82rem', fontWeight: 600,
                      cursor: isPendingApprove || isPendingReject ? 'not-allowed' : 'pointer',
                      opacity: isPendingApprove || isPendingReject ? 0.5 : 1,
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem',
                    }}
                    title="Resume the saga and fire the compensator"
                  >
                    <CheckCircle2 size={13} />
                    {isPendingApprove ? 'Approving…' : 'Approve'}
                  </button>
                  <button
                    onClick={() => decide(s, 'reject')}
                    disabled={isPendingApprove || isPendingReject}
                    style={{
                      padding: '0.45rem 0.9rem', borderRadius: 6,
                      background: 'transparent', color: 'hsl(var(--destructive))',
                      border: `1px solid ${BORDER}`,
                      fontSize: '0.82rem', fontWeight: 600,
                      cursor: isPendingApprove || isPendingReject ? 'not-allowed' : 'pointer',
                      opacity: isPendingApprove || isPendingReject ? 0.5 : 1,
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem',
                    }}
                    title="Abort the saga without compensating"
                  >
                    <XCircle size={13} />
                    {isPendingReject ? 'Rejecting…' : 'Reject'}
                  </button>
                </div>
              </div>

              {/* Reject reason input (optional) */}
              <input
                type="text"
                placeholder="Optional reject reason (audited)…"
                value={rejectDrafts[s.id] ?? ''}
                onChange={e => setRejectDrafts(d => ({ ...d, [s.id]: e.target.value }))}
                maxLength={500}
                style={{
                  marginTop: '0.7rem', width: '100%', padding: '0.4rem 0.6rem',
                  border: `1px solid ${BORDER}`, borderRadius: 6, background: BG,
                  color: TEXT, fontSize: '0.82rem',
                }}
              />
            </li>
          )
        })}
      </ul>

      <footer style={{ marginTop: '2rem', paddingTop: '1rem', borderTop: `1px solid ${BORDER}`, color: MUTED, fontSize: '0.8rem' }}>
        <p style={{ margin: 0 }}>
          Every approve / reject writes an audited{' '}
          <code style={{ background: BG, padding: '0.05em 0.35em', borderRadius: 3 }}>saga_step</code>
          {' '}row with the approver's identity. Approvals fire the compensator immediately.
        </p>
      </footer>

      {openSagaId && (
        <SagaTimelineDrawer sagaId={openSagaId} onClose={() => setOpenSagaId(null)} />
      )}
    </div>
  )
}
