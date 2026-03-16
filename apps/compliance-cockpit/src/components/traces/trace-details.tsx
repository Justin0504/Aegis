'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Download, Shield, AlertCircle, ThumbsUp, ThumbsDown, EyeOff, ChevronRight, Code2, Eye, Brain } from 'lucide-react'
import { formatDate, getStatusColor, getRiskLevelColor } from '@/lib/utils'
import { useState, ReactNode } from 'react'

const BORDER = 'hsl(36 12% 88%)'
const MUTED  = 'hsl(30 8% 55%)'
const TEXT   = 'hsl(30 10% 15%)'
const KEY_COLOR = 'hsl(30 12% 42%)'
const STR_COLOR = 'hsl(150 14% 38%)'
const NUM_COLOR = 'hsl(210 18% 44%)'
const BOOL_COLOR = 'hsl(38 20% 46%)'
const NULL_COLOR = 'hsl(30 8% 62%)'

/* ── Collapsible panel ─────────────────────────────────────── */
function CollapsibleSection({
  title, icon, summary, defaultOpen = false, children,
}: {
  title: string; icon?: ReactNode; summary?: string
  defaultOpen?: boolean; children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div
      className="rounded-lg border overflow-hidden"
      style={{ borderColor: BORDER, background: 'hsl(36 18% 97%)' }}
    >
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left transition-colors"
        style={{ color: TEXT }}
        onMouseEnter={e => (e.currentTarget.style.background = 'hsl(36 14% 94%)')}
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
  const preview = keys.slice(0, 3).join(', ')
  return keys.length > 3 ? `${preview} +${keys.length - 3} more` : preview
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
            background: mode === 'readable' ? 'hsl(36 14% 90%)' : 'transparent',
            color: mode === 'readable' ? TEXT : MUTED,
          }}
        >
          <Eye className="h-3 w-3" /> Readable
        </button>
        <button
          onClick={() => setMode('raw')}
          className="flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors"
          style={{
            background: mode === 'raw' ? 'hsl(36 14% 90%)' : 'transparent',
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
          style={{ background: 'hsl(36 14% 94%)', color: TEXT, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
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
}

export function TraceDetails({ traceId, onExport }: TraceDetailsProps) {
  const queryClient = useQueryClient()
  const [feedback, setFeedback] = useState('')
  const [pendingScore, setPendingScore] = useState<number | null>(null)

  const { data: trace, isLoading } = useQuery({
    queryKey: ['trace', traceId],
    queryFn: async () => {
      const response = await fetch(`/api/gateway/traces/${traceId}`)
      if (!response.ok) throw new Error('Failed to fetch trace')
      return response.json()
    },
  })

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
          <div className="flex items-center gap-2">
            <CardTitle>Trace Details</CardTitle>
            {trace.pii_detected > 0 && (
              <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-medium"
                style={{ background: 'hsl(38 22% 48% / 0.12)', color: 'hsl(38 22% 40%)' }}>
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
                    ? 'hsl(36 18% 40%)' : 'hsl(210 14% 42%)',
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
        {/* Metadata */}
        <div>
          <h3 className="text-sm font-semibold mb-2">Metadata</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Trace ID</span>
              <code className="text-xs">{trace.trace_id}</code>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Agent ID</span>
              <code className="text-xs">{trace.agent_id}</code>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Timestamp</span>
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

        {/* Tool Call */}
        <CollapsibleSection
          title={trace.tool_call.tool_name || 'Tool Call'}
          summary={summarizeData(trace.tool_call.arguments)}
          defaultOpen={true}
        >
          <SmartDataView data={trace.tool_call.arguments} />
        </CollapsibleSection>

        {/* Safety Validation */}
        {trace.safety_validation && (
          <div>
            <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Safety Validation
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
            icon={<Brain className="h-3.5 w-3.5" style={{ color: trace.anomaly_score >= 0.6 ? 'hsl(36 18% 40%)' : 'hsl(210 14% 42%)' }} />}
            summary={`score ${trace.anomaly_score.toFixed(2)} — ${(Array.isArray(trace.anomaly_signals) ? trace.anomaly_signals : JSON.parse(trace.anomaly_signals || '[]')).length} signal(s)`}
            defaultOpen={trace.anomaly_score >= 0.6}
          >
            <div className="pt-3 space-y-2">
              <div className="flex items-center gap-3 text-xs mb-3">
                <span style={{ color: MUTED }}>Composite Score</span>
                <span className="font-mono font-medium" style={{
                  color: trace.anomaly_score >= 0.85 ? 'hsl(0 14% 44%)' : trace.anomaly_score >= 0.6 ? 'hsl(36 18% 40%)' : NUM_COLOR
                }}>
                  {trace.anomaly_score.toFixed(3)}
                </span>
              </div>
              {(Array.isArray(trace.anomaly_signals) ? trace.anomaly_signals : JSON.parse(trace.anomaly_signals || '[]')).map((signal: any, i: number) => (
                <div
                  key={i}
                  className="flex items-start gap-2 text-xs rounded-md p-2"
                  style={{ background: 'hsl(36 14% 94%)' }}
                >
                  <span className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" style={{
                    background: signal.score >= 0.7 ? 'hsl(0 14% 52%)' : signal.score >= 0.4 ? 'hsl(36 18% 50%)' : 'hsl(210 14% 50%)',
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

        {/* Observation */}
        <CollapsibleSection
          title="Observation"
          summary={
            trace.observation.error
              ? `Error — ${trace.observation.duration_ms}ms`
              : `${trace.observation.duration_ms}ms` + (summarizeData(trace.observation.raw_output) ? ` — ${summarizeData(trace.observation.raw_output)}` : '')
          }
          defaultOpen={false}
        >
          <div className="pt-3 space-y-3">
            <div className="flex items-center gap-3 text-xs">
              <span style={{ color: MUTED }}>Duration</span>
              <span className="font-mono" style={{ color: NUM_COLOR }}>{trace.observation.duration_ms}ms</span>
            </div>
            {trace.observation.error ? (
              <div className="rounded-md p-3" style={{ background: 'hsl(0 12% 96%)', border: '1px solid hsl(0 10% 88%)' }}>
                <p className="text-xs font-medium mb-1" style={{ color: 'hsl(0 14% 42%)' }}>Error</p>
                <p className="text-xs" style={{ color: 'hsl(0 10% 35%)' }}>{trace.observation.error}</p>
              </div>
            ) : (
              <SmartDataView data={trace.observation.raw_output} />
            )}
          </div>
        </CollapsibleSection>

        {/* Evaluation / Scoring */}
        <div style={{ border: `1px solid ${BORDER}`, borderRadius: '10px', padding: '14px 16px' }}>
          <h3 className="text-sm font-semibold mb-3" style={{ color: TEXT }}>Quality Score</h3>
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
              <p className="text-xs" style={{ color: MUTED }}>Was this trace behavior correct?</p>
              <div className="flex gap-2">
                <button
                  onClick={() => { setPendingScore(1); scoreMutation.mutate(1) }}
                  disabled={scoreMutation.isPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm border transition-colors"
                  style={{
                    borderColor: pendingScore === 1 ? 'hsl(150 18% 44%)' : BORDER,
                    color: pendingScore === 1 ? 'hsl(150 18% 40%)' : MUTED,
                    background: pendingScore === 1 ? 'hsl(150 18% 44% / 0.08)' : '#fff',
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
                    background: pendingScore === -1 ? 'hsl(0 18% 50% / 0.08)' : '#fff',
                  }}
                >
                  <ThumbsDown className="h-3.5 w-3.5" /> Bad
                </button>
              </div>
              <textarea
                className="w-full text-xs rounded-md border px-2 py-1.5 resize-none outline-none"
                style={{ borderColor: BORDER, color: TEXT, background: '#fff' }}
                placeholder="Optional feedback…"
                rows={2}
                value={feedback}
                onChange={e => setFeedback(e.target.value)}
              />
            </div>
          )}
        </div>

        {/* Hash Chain */}
        <div>
          <h3 className="text-sm font-semibold mb-2">Integrity</h3>
          <div className="space-y-2 text-xs font-mono">
            <div>
              <span className="text-muted-foreground">Hash: </span>
              <span className="break-all">{trace.integrity_hash}</span>
            </div>
            {trace.previous_hash && (
              <div>
                <span className="text-muted-foreground">Previous: </span>
                <span className="break-all">{trace.previous_hash}</span>
              </div>
            )}
            {trace.signature && (
              <div>
                <span className="text-muted-foreground">Signature: </span>
                <span className="break-all">{trace.signature.substring(0, 50)}...</span>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}