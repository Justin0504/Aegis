'use client'

/**
 * DelegationWaterfall — a Datadog / Sentry-style waterfall of every
 * trace under the focus trace's delegation scope.
 *
 * Data source: GET /api/v1/traces/:traceId/delegation. Response is an
 * array of { trace_id, parent_trace_id, tool_name, risk_level,
 * approval_status, timestamp, duration_ms, agent_id, cost_usd }.
 *
 * Layout:
 *   - Each row is one trace, ordered by timestamp ASC.
 *   - Indentation reflects parent_trace_id depth (BFS from roots).
 *   - Horizontal bar length is proportional to duration_ms, positioned
 *     from the delegation's start time.
 *   - Bar colour tracks risk_level. Approval / block status decorates
 *     the row with a small chip.
 *   - Focus trace is highlighted with a left border accent so the
 *     user knows which row they clicked to get here.
 *   - Clicking any row switches the trace-details header to that
 *     trace via the `onSelectTrace` prop.
 *
 * Zero-state handling:
 *   - "trace not found" → we render nothing (parent already shows a
 *     404 branch).
 *   - "trace without delegation" → we show an unobtrusive note; some
 *     agent frameworks don't emit delegation_id at all.
 */

import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Loader2 } from 'lucide-react'
import { ToolIcon } from '@/lib/tool-icons'
import { friendlyAgent } from '@/lib/friendly-names'

const BORDER = 'hsl(var(--border))'
const MUTED  = 'hsl(var(--muted-foreground))'
const TEXT   = 'hsl(var(--foreground))'
const BG     = 'hsl(var(--background))'
const CARD   = 'hsl(var(--card))'

// Bar tints by risk. Sober palette — screaming red on every HIGH is
// what makes SRE dashboards feel like slot machines. We reserve
// bright red for CRITICAL only.
const RISK_BAR_BG: Record<string, string> = {
  LOW:      'hsl(150 26% 60%)',
  MEDIUM:   'hsl(36 40% 55%)',
  HIGH:     'hsl(15 55% 55%)',
  CRITICAL: 'hsl(0 60% 52%)',
}
const RISK_BAR_TRACK = 'hsl(0 0% 92%)'

interface HopRow {
  trace_id:         string
  parent_trace_id:  string | null
  agent_id:         string
  timestamp:        string
  sequence_number:  number
  tool_name:        string | null
  risk_level:       string | null
  approval_status:  string | null
  cost_usd:         number | null
  duration_ms:      number | null
}

interface Props {
  traceId:         string
  onSelectTrace?: (traceId: string) => void
}

export function DelegationWaterfall({ traceId, onSelectTrace }: Props) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['delegation', traceId],
    queryFn: async () => {
      const res = await fetch(`/api/gateway/traces/${encodeURIComponent(traceId)}/delegation`)
      if (!res.ok) throw new Error(`gateway returned ${res.status}`)
      return res.json() as Promise<{ delegation_id: string | null; traces: HopRow[] }>
    },
    refetchOnWindowFocus: false,
    retry: 1,
  })

  if (isLoading) {
    return (
      <div className="text-sm inline-flex items-center gap-2" style={{ color: MUTED }}>
        <Loader2 className="h-3 w-3 animate-spin" /> loading delegation…
      </div>
    )
  }

  if (error || !data) {
    return <p className="text-sm" style={{ color: MUTED }}>Delegation trace unavailable.</p>
  }

  if (!data.delegation_id || data.traces.length === 0) {
    return (
      <p className="text-xs" style={{ color: MUTED }}>
        This trace was not emitted under a delegation scope. Some SDK
        adapters do not set delegation_id automatically — see the
        <code className="mx-1 px-1 rounded" style={{ background: BG }}>delegation_scope</code>
        helper in the SDK docs.
      </p>
    )
  }

  // Compute time-normalised bar offsets. The waterfall is anchored
  // at the delegation's start (min timestamp) and scaled to fill
  // the panel — so a 400ms hop 20ms into the delegation renders at
  // 5% offset, 100% width divided proportionally.
  const times = data.traces.map(t => new Date(t.timestamp).getTime())
  const t0 = Math.min(...times)
  const spanMs = Math.max(1, Math.max(...times) - t0 + (data.traces[data.traces.length - 1]?.duration_ms ?? 0))

  // Depth by parent_trace_id — BFS from any trace whose parent isn't
  // in the delegation (root). Cap depth at 6 so a runaway loop
  // doesn't blow the layout.
  const byId = new Map(data.traces.map(t => [t.trace_id, t]))
  const depth = new Map<string, number>()
  for (const t of data.traces) {
    let d = 0
    let cursor: HopRow | undefined = t
    // Follow parent chain until we hit a root or leave the delegation
    while (cursor && cursor.parent_trace_id && byId.has(cursor.parent_trace_id) && d < 6) {
      cursor = byId.get(cursor.parent_trace_id)!
      d++
    }
    depth.set(t.trace_id, d)
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[11px]" style={{ color: MUTED }}>
        <span>
          Delegation{' '}
          <code style={{ color: TEXT }}>{data.delegation_id.slice(0, 24)}{data.delegation_id.length > 24 ? '…' : ''}</code>
          {' · '}
          {data.traces.length} hop{data.traces.length === 1 ? '' : 's'}
          {' · '}
          {spanMs.toLocaleString()}ms wall-clock
        </span>
        <span title="Delegation-scoped observability — Toledo et al. arXiv:2606.09692">
          <ArrowRight className="h-3 w-3" />
        </span>
      </div>

      <ul style={{ borderTop: `1px solid ${BORDER}` }} className="divide-y" role="list">
        {data.traces.map(hop => {
          const isFocus = hop.trace_id === traceId
          const startPct = ((new Date(hop.timestamp).getTime() - t0) / spanMs) * 100
          const widthPct = Math.max(0.5, ((hop.duration_ms ?? 1) / spanMs) * 100)
          const risk = hop.risk_level ?? 'LOW'
          const barColor = RISK_BAR_BG[risk] ?? RISK_BAR_BG.LOW
          const indent = (depth.get(hop.trace_id) ?? 0) * 12
          const clickable = Boolean(onSelectTrace)

          return (
            <li
              key={hop.trace_id}
              role={clickable ? 'button' : undefined}
              onClick={clickable ? () => onSelectTrace!(hop.trace_id) : undefined}
              className={clickable ? 'cursor-pointer hover:bg-black/[0.02]' : ''}
              style={{
                padding: '0.55rem 0.6rem',
                borderLeft: isFocus ? `3px solid ${TEXT}` : `3px solid transparent`,
                background: isFocus ? 'hsl(45 30% 96%)' : 'transparent',
              }}
            >
              {/* Row header: icon + tool_name + agent + tail chips */}
              <div className="flex items-center gap-2 text-xs" style={{ paddingLeft: indent }}>
                <ToolIcon name={hop.tool_name} size={16} />
                <span className="font-mono truncate" style={{ color: TEXT, maxWidth: 220 }} title={hop.tool_name ?? ''}>
                  {hop.tool_name ?? '(unknown)'}
                </span>
                <span className="text-[10px]" style={{ color: MUTED }}>
                  {friendlyAgent(hop.agent_id).slice(0, 14)}
                </span>
                <span className="ml-auto text-[10px] tabular-nums" style={{ color: MUTED }}>
                  {hop.duration_ms != null ? `${Math.round(hop.duration_ms)}ms` : ''}
                </span>
                {hop.approval_status && hop.approval_status !== 'AUTO_APPROVED' && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded" style={{
                    background: hop.approval_status === 'REJECTED' ? 'hsl(0 40% 92%)' : 'hsl(45 40% 92%)',
                    color:      hop.approval_status === 'REJECTED' ? 'hsl(0 55% 32%)' : 'hsl(35 55% 30%)',
                  }}>
                    {hop.approval_status}
                  </span>
                )}
              </div>

              {/* Bar track */}
              <div
                className="relative mt-1.5"
                style={{ marginLeft: indent, height: 6, background: RISK_BAR_TRACK, borderRadius: 3, overflow: 'hidden' }}
                title={`+${Math.round(new Date(hop.timestamp).getTime() - t0)}ms · ${Math.round(hop.duration_ms ?? 0)}ms · risk ${risk}`}
              >
                <div
                  style={{
                    position: 'absolute',
                    left:  `${startPct}%`,
                    width: `${widthPct}%`,
                    top: 0, bottom: 0,
                    background: barColor,
                    borderRadius: 3,
                  }}
                />
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
