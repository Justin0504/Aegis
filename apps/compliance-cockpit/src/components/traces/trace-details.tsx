'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Download, Shield, AlertCircle, ThumbsUp, ThumbsDown, EyeOff, ChevronRight, Code2, Eye, Brain } from 'lucide-react'
import { USE_MOCK, mockTraces } from '@/lib/mock-traces'
import { formatDate, getStatusColor, getRiskLevelColor } from '@/lib/utils'
import { friendlyAgent } from '@/lib/friendly-names'
import { useState, ReactNode } from 'react'
import { AnomalyExplanationPanel } from './anomaly-explanation-panel'
import { ToolIcon } from '@/lib/tool-icons'
import { DelegationWaterfall } from './delegation-waterfall'

const BORDER = 'hsl(var(--border))'
const MUTED  = 'hsl(var(--muted-foreground))'
const TEXT   = 'hsl(var(--foreground))'
const KEY_COLOR = 'hsl(0 0% 42%)'
const STR_COLOR = 'hsl(150 14% 38%)'
const NUM_COLOR = 'hsl(210 18% 44%)'
const BOOL_COLOR = 'hsl(var(--primary))'
const NULL_COLOR = 'hsl(0 0% 62%)'

/* ── Collapsible panel ─────────────────────────────────────── */
function CollapsibleSection({
  title, icon, summary, defaultOpen = false, children,
}: {
  title: string; icon?: ReactNode; summary?: ReactNode
  defaultOpen?: boolean; children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div
      className="rounded-lg border overflow-hidden"
      style={{ borderColor: BORDER, background: 'hsl(var(--secondary))' }}
    >
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left transition-colors"
        style={{ color: TEXT }}
        onMouseEnter={e => (e.currentTarget.style.background = 'hsl(var(--secondary))')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      >
        <ChevronRight
          className="h-3.5 w-3.5 flex-shrink-0 transition-transform duration-150"
          style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', color: MUTED }}
        />
        {icon}
        <span className="text-sm font-semibold">{title}</span>
        {!open && summary && (
          <span className="ml-auto text-xs truncate max-w-[60%]" style={{ color: MUTED }}>
            {summary}
          </span>
        )}
      </button>
      {open && (
        <div className="px-4 pb-4 border-t" style={{ borderColor: BORDER }}>
          {children}
        </div>
      )}
    </div>
  )
}

/* ── Smart JSON renderer ───────────────────────────────────── */
function JsonValue({ value, depth = 0 }: { value: any; depth?: number }) {
  const [expanded, setExpanded] = useState(depth < 2)

  if (value === null || value === undefined) {
    return <span className="text-xs italic" style={{ color: NULL_COLOR }}>null</span>
  }
  if (typeof value === 'boolean') {
    return <span className="text-xs font-medium" style={{ color: BOOL_COLOR }}>{String(value)}</span>
  }
  if (typeof value === 'number') {
    return <span className="text-xs font-mono" style={{ color: NUM_COLOR }}>{value}</span>
  }
  if (typeof value === 'string') {
    // Long strings get truncated with expand
    if (value.length > 200) {
      return (
        <span className="text-xs" style={{ color: STR_COLOR }}>
          {expanded ? value : `${value.slice(0, 200)}...`}
          <button
            onClick={e => { e.stopPropagation(); setExpanded(!expanded) }}
            className="ml-1 underline"
            style={{ color: NUM_COLOR }}
          >
            {expanded ? 'less' : 'more'}
          </button>
        </span>
      )
    }
    return <span className="text-xs" style={{ color: STR_COLOR }}>{value}</span>
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-xs" style={{ color: NULL_COLOR }}>[]</span>
    return (
      <div className="space-y-1" style={{ paddingLeft: depth > 0 ? 12 : 0 }}>
        {value.map((item, i) => (
          <div key={i} className="flex items-start gap-1.5">
            <span className="text-[10px] mt-0.5 flex-shrink-0" style={{ color: NULL_COLOR }}>{i}.</span>
            <JsonValue value={item} depth={depth + 1} />
          </div>
        ))}
      </div>
    )
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length === 0) return <span className="text-xs" style={{ color: NULL_COLOR }}>{'{}'}</span>
    return (
      <div className="space-y-1.5" style={{ paddingLeft: depth > 0 ? 12 : 0 }}>
        {entries.map(([k, v]) => (
          <div key={k} className="flex items-start gap-1.5">
            <span className="text-xs font-medium flex-shrink-0 mt-px" style={{ color: KEY_COLOR }}>{k}:</span>
            <JsonValue value={v} depth={depth + 1} />
          </div>
        ))}
      </div>
    )
  }

  return <span className="text-xs">{String(value)}</span>
}

/* ── Summarize data for collapsed preview ──────────────────── */
function summarizeData(data: any): string {
  if (data === null || data === undefined) return ''
  if (typeof data === 'string') return data.length > 80 ? data.slice(0, 80) + '...' : data
  if (typeof data !== 'object') return String(data)
  if (Array.isArray(data)) return `${data.length} item${data.length !== 1 ? 's' : ''}`
  const keys = Object.keys(data)
  if (keys.length === 0) return '{}'

  // Surface VALUES for recognisable shapes — much more useful than key names.
  const clip = (s: any, n = 50) => {
    const str = String(s ?? '')
    return str.length > n ? str.slice(0, n - 1) + '…' : str
  }
  if (data.to)         return `→ ${clip(data.to, 32)}${data.subject ? ` · "${clip(data.subject, 30)}"` : ''}`
  if (data.recipient)  return `→ ${clip(data.recipient, 32)}`
  if (data.url)        return clip(data.url, 60)
  if (data.endpoint)   return clip(data.endpoint, 60)
  if (data.sql)        return clip(data.sql, 60)
  if (data.query)      return `"${clip(data.query, 50)}"`
  if (data.q)          return `"${clip(data.q, 50)}"`
  if (data.command)    return clip(data.command, 60)
  if (data.path)       return clip(data.path, 60)
  if (data.file_path)  return clip(data.file_path, 60)
  if (data.amount)     return typeof data.amount === 'number' ? `$${(data.amount / 100).toFixed(2)}` : clip(data.amount)

  // Fallback — at least show the first value, not just the key name.
  const firstKey = keys[0]
  const firstVal = data[firstKey]
  if (firstVal && typeof firstVal !== 'object') return clip(firstVal, 60)
  return keys.length > 3 ? `${keys.slice(0, 3).join(', ')} +${keys.length - 3} more` : keys.join(', ')
}

/** Format a possibly-undefined duration safely. */
function fmtDuration(ms: any): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
  return ms < 1 ? '<1ms' : `${Math.round(ms)}ms`
}

function SmartDataView({ data, label }: { data: any; label?: string }) {
  const [mode, setMode] = useState<'readable' | 'raw'>('readable')

  if (data === null || data === undefined) {
    return <p className="text-xs italic pt-3" style={{ color: NULL_COLOR }}>No data</p>
  }

  return (
    <div className="pt-3">
      <div className="flex items-center gap-1 mb-2">
        <button
          onClick={() => setMode('readable')}
          className="flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors"
          style={{
            background: mode === 'readable' ? 'hsl(var(--secondary))' : 'transparent',
            color: mode === 'readable' ? TEXT : MUTED,
          }}
        >
          <Eye className="h-3 w-3" /> Readable
        </button>
        <button
          onClick={() => setMode('raw')}
          className="flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors"
          style={{
            background: mode === 'raw' ? 'hsl(var(--secondary))' : 'transparent',
            color: mode === 'raw' ? TEXT : MUTED,
          }}
        >
          <Code2 className="h-3 w-3" /> JSON
        </button>
      </div>
      {mode === 'readable' ? (
        <JsonValue value={data} />
      ) : (
        <pre
          className="text-[11px] font-mono overflow-x-auto p-3 rounded-md"
          style={{ background: 'hsl(var(--secondary))', color: TEXT, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
        >
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  )
}

interface TraceDetailsProps {
  traceId: string
  onExport: () => void
  /** Fired when the user picks a hop from the delegation waterfall.
   *  Parent decides whether to swap the details panel to that trace. */
  onSelectTrace?: (traceId: string) => void
}

export function TraceDetails({ traceId, onExport, onSelectTrace }: TraceDetailsProps) {
  const queryClient = useQueryClient()
  const [feedback, setFeedback] = useState('')
  const [pendingScore, setPendingScore] = useState<number | null>(null)

  const { data: traceFromApi, isLoading } = useQuery({
    enabled: !USE_MOCK,
    queryKey: ['trace', traceId],
    queryFn: async () => {
      const response = await fetch(`/api/gateway/traces/${traceId}`)
      if (!response.ok) throw new Error('Failed to fetch trace')
      return response.json()
    },
  })
  // Mock mode: pull the matching trace from the same in-memory list
  // that traces-view fed to TracesList, so detail = the row clicked.
  const trace = USE_MOCK
    ? mockTraces().find((t: any) => t.trace_id === traceId)
    : traceFromApi

  const scoreMutation = useMutation({
    mutationFn: async (score: number) => {
      const res = await fetch(`/api/gateway/traces/${traceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score, feedback: feedback || null }),
      })
      if (!res.ok) throw new Error('Failed to score')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trace', traceId] })
      queryClient.invalidateQueries({ queryKey: ['eval-stats'] })
      setFeedback('')
      setPendingScore(null)
    },
  })

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-muted-foreground">Loading trace details...</p>
        </CardContent>
      </Card>
    )
  }

  if (!trace) return null

  return (
    <Card className="h-[calc(100vh-200px)] overflow-hidden flex flex-col">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <ToolIcon name={trace.tool_call?.tool_name} size={48} />
            <div className="min-w-0">
              <CardTitle className="truncate leading-tight">
                {trace.tool_call?.tool_name ?? 'unknown tool'}
              </CardTitle>
              <p className="text-xs mt-0.5 truncate" style={{ color: MUTED }}>
                by {friendlyAgent(trace.agent_id)}
              </p>
            </div>
            {trace.pii_detected > 0 && (
              <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-medium"
                style={{ background: 'hsl(0 0% 0% / 0.12)', color: 'hsl(0 0% 0%)' }}>
                <EyeOff className="h-2.5 w-2.5" />
                {trace.pii_detected} PII redacted
              </span>
            )}
            {trace.anomaly_score > 0 && (
              <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-medium"
                style={{
                  background: trace.anomaly_score >= 0.85
                    ? 'hsl(0 14% 52% / 0.12)' : trace.anomaly_score >= 0.6
                    ? 'hsl(36 18% 50% / 0.12)' : trace.anomaly_score >= 0.3
                    ? 'hsl(210 14% 50% / 0.12)' : 'transparent',
                  color: trace.anomaly_score >= 0.85
                    ? 'hsl(0 14% 44%)' : trace.anomaly_score >= 0.6
                    ? 'hsl(220 10% 42%)' : 'hsl(210 14% 42%)',
                }}>
                <Brain className="h-2.5 w-2.5" />
                Anomaly {trace.anomaly_score.toFixed(2)}
              </span>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={onExport}>
            <Download className="h-4 w-4 mr-2" />
            Export
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto space-y-6">
        {/* Summary — when + status only, no IDs */}
        <div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">When</span>
              <span>{formatDate(trace.timestamp)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Status</span>
              <Badge
                variant="outline"
                className={getStatusColor(trace.approval_status || 'PENDING')}
              >
                {trace.approval_status || 'PENDING'}
              </Badge>
            </div>
          </div>
        </div>

        {/* What it tried — auto-summary, JSON behind a toggle */}
        <CollapsibleSection
          title="What it tried"
          summary={summarizeData(trace.tool_call.arguments) || trace.tool_call.tool_name}
          defaultOpen={false}
        >
          <SmartDataView data={trace.tool_call.arguments} />
        </CollapsibleSection>

        {/* Safety Validation */}
        {trace.safety_validation && (
          <div>
            <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
              <Shield className="h-4 w-4" />
              AEGIS check
            </h3>
            <div className="rounded-lg border p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm">
                  Policy: {trace.safety_validation.policy_name}
                </span>
                <Badge
                  variant="outline"
                  className={getRiskLevelColor(trace.safety_validation.risk_level)}
                >
                  {trace.safety_validation.risk_level}
                </Badge>
              </div>
              {trace.safety_validation.violations && (
                <div className="mt-2">
                  <p className="text-sm font-medium flex items-center gap-2 text-destructive">
                    <AlertCircle className="h-4 w-4" />
                    Violations
                  </p>
                  <ul className="list-disc list-inside text-sm text-muted-foreground mt-1">
                    {trace.safety_validation.violations.map((v: string, i: number) => (
                      <li key={i}>{v}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Anomaly Detection */}
        {trace.anomaly_score > 0 && trace.anomaly_signals && (
          <CollapsibleSection
            title="Behavioral Anomaly"
            icon={<Brain className="h-3.5 w-3.5" style={{ color: trace.anomaly_score >= 0.6 ? 'hsl(220 10% 42%)' : 'hsl(210 14% 42%)' }} />}
            summary={`score ${trace.anomaly_score.toFixed(2)} — ${(Array.isArray(trace.anomaly_signals) ? trace.anomaly_signals : JSON.parse(trace.anomaly_signals || '[]')).length} signal(s)`}
            defaultOpen={trace.anomaly_score >= 0.6}
          >
            <div className="pt-3 space-y-2">
              <div className="flex items-center gap-3 text-xs mb-3">
                <span style={{ color: MUTED }}>Composite Score</span>
                <span className="font-mono font-medium" style={{
                  color: trace.anomaly_score >= 0.85 ? 'hsl(0 14% 44%)' : trace.anomaly_score >= 0.6 ? 'hsl(220 10% 42%)' : NUM_COLOR
                }}>
                  {trace.anomaly_score.toFixed(3)}
                </span>
              </div>
              {trace.anomaly_explanation && (
                <AnomalyExplanationPanel explanation={
                  typeof trace.anomaly_explanation === 'string'
                    ? JSON.parse(trace.anomaly_explanation)
                    : trace.anomaly_explanation
                } />
              )}
              {(Array.isArray(trace.anomaly_signals) ? trace.anomaly_signals : JSON.parse(trace.anomaly_signals || '[]')).map((signal: any, i: number) => (
                <div
                  key={i}
                  className="flex items-start gap-2 text-xs rounded-md p-2"
                  style={{ background: 'hsl(var(--secondary))' }}
                >
                  <span className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" style={{
                    background: signal.score >= 0.7 ? 'hsl(0 14% 52%)' : signal.score >= 0.4 ? 'hsl(220 10% 50%)' : 'hsl(210 14% 50%)',
                  }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="font-medium" style={{ color: KEY_COLOR }}>
                        {signal.type?.replace(/_/g, ' ')}
                      </span>
                      <span className="font-mono" style={{ color: NUM_COLOR }}>
                        {signal.score?.toFixed(2)}
                      </span>
                    </div>
                    <p style={{ color: MUTED }}>{signal.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}

        {/* Result */}
        <CollapsibleSection
          title="Result"
          summary={
            trace.observation.error
              ? `Failed — ${fmtDuration(trace.observation.duration_ms)}`
              : `${fmtDuration(trace.observation.duration_ms)}`
          }
          defaultOpen={false}
        >
          <div className="pt-3 space-y-3">
            <div className="flex items-center gap-3 text-xs">
              <span style={{ color: MUTED }}>Duration</span>
              <span className="font-mono" style={{ color: NUM_COLOR }}>{fmtDuration(trace.observation.duration_ms)}</span>
            </div>
            {trace.observation.error ? (
              <div className="rounded-md p-3" style={{ background: 'hsl(var(--status-drift) / 0.10)', border: '1px solid hsl(0 10% 88%)' }}>
                <p className="text-xs font-medium mb-1" style={{ color: 'hsl(0 14% 42%)' }}>Error</p>
                <p className="text-xs" style={{ color: 'hsl(0 10% 35%)' }}>{trace.observation.error}</p>
              </div>
            ) : (
              <SmartDataView data={trace.observation.raw_output} />
            )}
          </div>
        </CollapsibleSection>

        {/* Delegation waterfall — every hop under the same delegation
            scope as this trace. Datadog / Sentry-style. Empty state
            (no delegation_id) is quietly informative rather than a hole. */}
        <CollapsibleSection
          title="Delegation trace"
          summary="waterfall of every hop under the same delegation scope"
          defaultOpen={false}
        >
          <div className="pt-2">
            <DelegationWaterfall traceId={traceId} onSelectTrace={onSelectTrace} />
          </div>
        </CollapsibleSection>

        {/* Evaluation / Scoring */}
        <div style={{ border: `1px solid ${BORDER}`, borderRadius: '10px', padding: '14px 16px' }}>
          <h3 className="text-sm font-semibold mb-3" style={{ color: TEXT }}>Quality</h3>
          {trace.score !== null && trace.score !== undefined ? (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                {trace.score > 0
                  ? <ThumbsUp className="h-4 w-4" style={{ color: 'hsl(150 18% 44%)' }} />
                  : <ThumbsDown className="h-4 w-4" style={{ color: 'hsl(0 18% 50%)' }} />
                }
                <span className="text-sm font-medium" style={{ color: trace.score > 0 ? 'hsl(150 18% 40%)' : 'hsl(0 14% 46%)' }}>
                  {trace.score > 0 ? 'Good' : 'Bad'}
                </span>
                {trace.scored_by && (
                  <span className="text-xs" style={{ color: MUTED }}>by {trace.scored_by}</span>
                )}
              </div>
              {trace.feedback && (
                <p className="text-xs" style={{ color: MUTED }}>{trace.feedback}</p>
              )}
              <button
                className="text-[11px] mt-1"
                style={{ color: 'hsl(210 18% 48%)' }}
                onClick={() => scoreMutation.reset()}
              >
                Re-score
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex gap-2">
                <button
                  onClick={() => { setPendingScore(1); scoreMutation.mutate(1) }}
                  disabled={scoreMutation.isPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm border transition-colors"
                  style={{
                    borderColor: pendingScore === 1 ? 'hsl(150 18% 44%)' : BORDER,
                    color: pendingScore === 1 ? 'hsl(150 18% 40%)' : MUTED,
                    background: pendingScore === 1 ? 'hsl(150 18% 44% / 0.08)' : 'hsl(var(--card))',
                  }}
                >
                  <ThumbsUp className="h-3.5 w-3.5" /> Good
                </button>
                <button
                  onClick={() => { setPendingScore(-1); scoreMutation.mutate(-1) }}
                  disabled={scoreMutation.isPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm border transition-colors"
                  style={{
                    borderColor: pendingScore === -1 ? 'hsl(0 18% 50%)' : BORDER,
                    color: pendingScore === -1 ? 'hsl(0 14% 46%)' : MUTED,
                    background: pendingScore === -1 ? 'hsl(0 18% 50% / 0.08)' : 'hsl(var(--card))',
                  }}
                >
                  <ThumbsDown className="h-3.5 w-3.5" /> Bad
                </button>
              </div>
              <textarea
                className="w-full text-xs rounded-md border px-2 py-1.5 resize-none outline-none"
                style={{ borderColor: BORDER, color: TEXT, background: 'hsl(var(--card))' }}
                placeholder="Optional feedback…"
                rows={2}
                value={feedback}
                onChange={e => setFeedback(e.target.value)}
              />
            </div>
          )}
        </div>

        {/* Integrity — collapsed; just a "Verified" chip with short fingerprint */}
        {trace.integrity_hash && (
          <CollapsibleSection
            title="Integrity"
            summary={(
              <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: 'hsl(150 18% 38%)' }}>
                <Shield className="h-3 w-3" />
                Verified · #{trace.integrity_hash.slice(-4)}
              </span>
            )}
            defaultOpen={false}
          >
            <div className="space-y-2 text-[11px] font-mono pt-2" style={{ color: MUTED }}>
              <div>
                <span>Hash: </span>
                <span className="break-all" style={{ color: TEXT }}>{trace.integrity_hash}</span>
              </div>
              {trace.previous_hash && (
                <div>
                  <span>Previous: </span>
                  <span className="break-all" style={{ color: TEXT }}>{trace.previous_hash}</span>
                </div>
              )}
              {trace.signature && (
                <div>
                  <span>Signature: </span>
                  <span className="break-all" style={{ color: TEXT }}>{trace.signature.substring(0, 50)}…</span>
                </div>
              )}
            </div>
          </CollapsibleSection>
        )}
      </CardContent>
    </Card>
  )
}