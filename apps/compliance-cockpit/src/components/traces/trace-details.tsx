'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Download, Shield, AlertCircle, ThumbsUp, ThumbsDown, EyeOff } from 'lucide-react'
import { formatDate, getStatusColor, getRiskLevelColor } from '@/lib/utils'
import { useState } from 'react'

const BORDER = 'hsl(36 12% 88%)'
const MUTED  = 'hsl(30 8% 55%)'
const TEXT   = 'hsl(30 10% 15%)'

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
        <div>
          <h3 className="text-sm font-semibold mb-2">Tool Call</h3>
          <div className="rounded-lg bg-muted p-4">
            <p className="font-mono text-sm">{trace.tool_call.tool_name}</p>
            <pre className="text-xs mt-2 overflow-x-auto">
              {JSON.stringify(trace.tool_call.arguments, null, 2)}
            </pre>
          </div>
        </div>

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

        {/* Observation */}
        <div>
          <h3 className="text-sm font-semibold mb-2">Observation</h3>
          <div className="rounded-lg bg-muted p-4">
            <div className="flex justify-between text-sm mb-2">
              <span className="text-muted-foreground">Duration</span>
              <span>{trace.observation.duration_ms}ms</span>
            </div>
            {trace.observation.error ? (
              <div className="text-destructive text-sm">
                <p className="font-medium">Error:</p>
                <p>{trace.observation.error}</p>
              </div>
            ) : (
              <pre className="text-xs overflow-x-auto">
                {JSON.stringify(trace.observation.raw_output, null, 2)}
              </pre>
            )}
          </div>
        </div>

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