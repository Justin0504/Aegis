'use client'

/**
 * SagaTimelineDrawer — right-side slide-out panel showing a saga's
 * full step timeline: every compensator that fired (or was skipped),
 * its outcome, duration, and any error string.
 *
 * Backend: GET /api/v1/rollback/sagas/:id → { saga, steps: SagaStep[] }
 *
 * The steps table on the wire is defined in
 * packages/gateway-mcp/src/services/saga.ts (SagaStep interface).
 */

import { useQuery } from '@tanstack/react-query'
import { X, CheckCircle2, XCircle, MinusCircle, Clock, AlertOctagon } from 'lucide-react'
import { formatDate } from '@/lib/utils'

const BORDER = 'hsl(var(--border))'
const MUTED  = 'hsl(var(--muted-foreground))'
const TEXT   = 'hsl(var(--foreground))'
const BG     = 'hsl(var(--background))'
const CARD   = 'hsl(var(--card))'

interface SagaStep {
  id: number
  saga_id: string
  step_idx: number
  trace_id: string
  outcome: 'rolled_back' | 'no_op' | 'failed' | 'unsupported' | 'skipped'
  compensator_kind: string
  duration_ms: number
  error: string | null
  recorded_at: string
  depends_on?: string | null
}

interface SagaDetail {
  saga: {
    id: string
    kind: string
    state: string
    agent_id: string | null
    started_at: string
    completed_at: string | null
    step_count: number
    reason: string | null
    pause_reason: string | null
    origin_ring: number | null
  }
  steps: SagaStep[]
}

export function SagaTimelineDrawer({ sagaId, onClose }: { sagaId: string; onClose: () => void }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['saga-detail', sagaId],
    queryFn: async () => {
      const res = await fetch(`/api/gateway/api/v1/rollback/sagas/${sagaId}`)
      if (!res.ok) throw new Error(`gateway ${res.status}`)
      return (await res.json()) as SagaDetail
    },
  })

  return (
    <>
      {/* Scrim */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, background: 'rgba(10, 10, 10, 0.35)',
          zIndex: 100, animation: 'fade-in 0.15s ease',
        }}
      />
      {/* Panel */}
      <aside
        role="dialog"
        aria-label="Saga step timeline"
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0,
          width: 'min(560px, 92vw)',
          background: BG, borderLeft: `1px solid ${BORDER}`,
          boxShadow: '-24px 0 60px rgba(10, 10, 10, 0.12)',
          overflowY: 'auto', zIndex: 101,
          animation: 'slide-in 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        <header style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '1rem 1.4rem', borderBottom: `1px solid ${BORDER}`,
        }}>
          <div>
            <p style={{ margin: 0, fontSize: '0.7rem', letterSpacing: '0.08em',
                        textTransform: 'uppercase', color: MUTED, fontWeight: 600 }}>
              Saga timeline
            </p>
            <p style={{ margin: '0.25rem 0 0', fontFamily: 'ui-monospace, monospace',
                        fontSize: '0.85rem', color: TEXT }}>
              {sagaId.slice(0, 12)}…
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'none', border: 0, cursor: 'pointer',
              padding: '0.35rem', borderRadius: 6, color: MUTED,
            }}
          >
            <X size={18} />
          </button>
        </header>

        {isLoading && <p style={{ padding: '1.4rem', color: MUTED }}>Loading…</p>}
        {isError && (
          <p style={{ padding: '1.4rem', color: 'hsl(var(--destructive))' }}>
            Failed to load saga.
          </p>
        )}
        {data && (
          <>
            <section style={{ padding: '1rem 1.4rem', borderBottom: `1px solid ${BORDER}` }}>
              <dl style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: '0.4rem 0.8rem',
                           margin: 0, fontSize: '0.85rem' }}>
                <dt style={{ color: MUTED }}>State</dt>
                <dd style={{ margin: 0 }}>
                  <StateBadge state={data.saga.state} />
                </dd>
                <dt style={{ color: MUTED }}>Kind</dt>
                <dd style={{ margin: 0, color: TEXT }}>{data.saga.kind}</dd>
                <dt style={{ color: MUTED }}>Agent</dt>
                <dd style={{ margin: 0, color: TEXT, fontFamily: 'ui-monospace, monospace' }}>
                  {data.saga.agent_id ?? '—'}
                </dd>
                <dt style={{ color: MUTED }}>Started</dt>
                <dd style={{ margin: 0, color: TEXT }}>{formatDate(data.saga.started_at)}</dd>
                {data.saga.completed_at && (
                  <>
                    <dt style={{ color: MUTED }}>Completed</dt>
                    <dd style={{ margin: 0, color: TEXT }}>{formatDate(data.saga.completed_at)}</dd>
                  </>
                )}
                <dt style={{ color: MUTED }}>Origin</dt>
                <dd style={{ margin: 0, color: TEXT }}>
                  {data.saga.origin_ring === 3 ? 'Ring-3 (LLM decision)'
                  : data.saga.origin_ring === 2 ? 'Ring-2 (deterministic)'
                  : '—'}
                </dd>
                <dt style={{ color: MUTED }}>Steps</dt>
                <dd style={{ margin: 0, color: TEXT }}><b>{data.saga.step_count}</b></dd>
              </dl>
              {data.saga.reason && (
                <p style={{
                  marginTop: '0.9rem', padding: '0.5rem 0.7rem',
                  background: CARD, borderLeft: `2px solid ${BORDER}`,
                  fontSize: '0.82rem', color: TEXT,
                }}>
                  Operator reason: {data.saga.reason}
                </p>
              )}
            </section>

            <section style={{ padding: '1rem 1.4rem 2rem' }}>
              <p style={{
                margin: '0 0 0.7rem', fontSize: '0.7rem', letterSpacing: '0.08em',
                textTransform: 'uppercase', color: MUTED, fontWeight: 600,
              }}>
                Timeline
              </p>
              {data.steps.length === 0 && (
                <p style={{ color: MUTED, fontSize: '0.88rem' }}>No steps recorded.</p>
              )}
              <ol style={{ listStyle: 'none', margin: 0, padding: 0, position: 'relative' }}>
                {/* Vertical spine */}
                {data.steps.length > 0 && (
                  <div style={{
                    position: 'absolute', left: 10, top: 8, bottom: 8,
                    width: 1, background: BORDER, zIndex: 0,
                  }} />
                )}
                {data.steps.map(step => (
                  <li key={step.id} style={{
                    position: 'relative', paddingLeft: '2.2rem', marginBottom: '0.9rem',
                    zIndex: 1,
                  }}>
                    <StepIcon outcome={step.outcome} />
                    <div style={{
                      background: CARD, borderRadius: 8, padding: '0.6rem 0.8rem',
                      border: `1px solid ${BORDER}`,
                    }}>
                      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'baseline',
                                    fontSize: '0.82rem', color: MUTED, flexWrap: 'wrap' }}>
                        <span style={{ fontFamily: 'ui-monospace, monospace', color: TEXT, fontWeight: 600 }}>
                          #{step.step_idx}
                        </span>
                        <OutcomePill outcome={step.outcome} />
                        <span>{step.compensator_kind}</span>
                        <span style={{ marginLeft: 'auto', fontFamily: 'ui-monospace, monospace' }}>
                          {step.duration_ms}ms
                        </span>
                      </div>
                      <p style={{
                        margin: '0.35rem 0 0', fontSize: '0.78rem',
                        fontFamily: 'ui-monospace, monospace', color: MUTED,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        trace: {step.trace_id}
                      </p>
                      {step.error && (
                        <pre style={{
                          margin: '0.35rem 0 0', padding: '0.4rem 0.6rem',
                          background: BG, border: `1px solid ${BORDER}`, borderRadius: 4,
                          fontSize: '0.72rem', color: 'hsl(var(--destructive))',
                          whiteSpace: 'pre-wrap', lineHeight: 1.5,
                        }}>{step.error}</pre>
                      )}
                      {step.depends_on && (
                        <p style={{
                          margin: '0.35rem 0 0', fontSize: '0.7rem',
                          color: MUTED, fontFamily: 'ui-monospace, monospace',
                        }}>
                          depends on: {step.depends_on}
                        </p>
                      )}
                    </div>
                    <p style={{ margin: '0.3rem 0 0', fontSize: '0.7rem', color: MUTED,
                                paddingLeft: '0.05rem' }}>
                      {formatDate(step.recorded_at)}
                    </p>
                  </li>
                ))}
              </ol>
            </section>
          </>
        )}
      </aside>
      <style>{`
        @keyframes slide-in { from { transform: translateX(30px); opacity: 0 } to { transform: translateX(0); opacity: 1 } }
        @keyframes fade-in  { from { opacity: 0 } to { opacity: 1 } }
      `}</style>
    </>
  )
}

function StateBadge({ state }: { state: string }) {
  const map: Record<string, { bg: string; fg: string }> = {
    PAUSED_FOR_APPROVAL: { bg: 'hsl(45 40% 88%)',  fg: 'hsl(35 60% 25%)' },
    EXECUTING:           { bg: 'hsl(210 30% 90%)', fg: 'hsl(210 50% 25%)' },
    COMPENSATING:        { bg: 'hsl(30 50% 90%)',  fg: 'hsl(30 60% 30%)' },
    COMPLETED:           { bg: 'hsl(150 30% 90%)', fg: 'hsl(150 40% 25%)' },
    ABORTED:             { bg: 'hsl(0 40% 92%)',   fg: 'hsl(0 55% 32%)' },
    FAILED:              { bg: 'hsl(0 40% 92%)',   fg: 'hsl(0 55% 32%)' },
    STARTED:             { bg: 'hsl(210 20% 92%)', fg: 'hsl(210 30% 30%)' },
  }
  const s = map[state] ?? { bg: 'hsl(45 22% 90%)', fg: 'hsl(45 15% 30%)' }
  return (
    <span style={{
      display: 'inline-block', padding: '0.15rem 0.5rem', borderRadius: 4,
      background: s.bg, color: s.fg, fontSize: '0.72rem', fontWeight: 600,
      letterSpacing: '0.03em',
    }}>{state}</span>
  )
}

function OutcomePill({ outcome }: { outcome: SagaStep['outcome'] }) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    rolled_back: { bg: 'hsl(150 30% 90%)', fg: 'hsl(150 40% 25%)', label: 'ROLLED BACK' },
    no_op:       { bg: 'hsl(210 20% 92%)', fg: 'hsl(210 30% 30%)', label: 'NO-OP' },
    failed:      { bg: 'hsl(0 40% 92%)',   fg: 'hsl(0 55% 32%)',   label: 'FAILED' },
    unsupported: { bg: 'hsl(30 40% 90%)',  fg: 'hsl(30 55% 30%)',  label: 'UNSUPPORTED' },
    skipped:     { bg: 'hsl(45 22% 90%)',  fg: 'hsl(45 15% 30%)',  label: 'SKIPPED' },
  }
  const o = map[outcome] ?? map.skipped
  return (
    <span style={{
      display: 'inline-block', padding: '0.05rem 0.4rem', borderRadius: 3,
      background: o.bg, color: o.fg, fontSize: '0.62rem', fontWeight: 700,
      letterSpacing: '0.05em',
    }}>{o.label}</span>
  )
}

function StepIcon({ outcome }: { outcome: SagaStep['outcome'] }) {
  const style: React.CSSProperties = {
    position: 'absolute', left: 0, top: '0.5rem',
    width: 22, height: 22, borderRadius: '50%',
    background: BG, border: `2px solid ${BORDER}`,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 2,
  }
  const iconProps = { size: 12 }
  if (outcome === 'rolled_back') return <div style={style}><CheckCircle2 {...iconProps} color="hsl(150 40% 40%)" /></div>
  if (outcome === 'failed')      return <div style={style}><AlertOctagon {...iconProps} color="hsl(0 55% 45%)" /></div>
  if (outcome === 'unsupported') return <div style={style}><XCircle {...iconProps} color="hsl(30 55% 40%)" /></div>
  if (outcome === 'no_op')       return <div style={style}><MinusCircle {...iconProps} color="hsl(210 30% 50%)" /></div>
  return <div style={style}><Clock {...iconProps} color="hsl(45 15% 40%)" /></div>
}
