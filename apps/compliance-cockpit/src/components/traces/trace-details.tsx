'use client'

import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Download, Shield, AlertCircle } from 'lucide-react'
import { formatDate, getStatusColor, getRiskLevelColor } from '@/lib/utils'

interface TraceDetailsProps {
  traceId: string
  onExport: () => void
}

export function TraceDetails({ traceId, onExport }: TraceDetailsProps) {
  const { data: trace, isLoading } = useQuery({
    queryKey: ['trace', traceId],
    queryFn: async () => {
      const response = await fetch(`/api/gateway/traces/${traceId}`)
      if (!response.ok) throw new Error('Failed to fetch trace')
      return response.json()
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
          <CardTitle>Trace Details</CardTitle>
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