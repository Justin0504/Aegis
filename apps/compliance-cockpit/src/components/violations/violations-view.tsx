'use client'

import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export function ViolationsView() {
  const { data, isLoading } = useQuery({
    queryKey: ['violations'],
    queryFn: async () => {
      const res = await fetch('/api/gateway/traces?limit=100')
      if (!res.ok) throw new Error('Failed to fetch traces')
      return res.json()
    },
    refetchInterval: 3000,
  })

  const violations = (data?.traces ?? []).filter(
    (t: any) => t.safety_validation && !t.safety_validation.passed
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Violations</h1>
        <p className="text-muted-foreground">Agent actions that failed safety policy checks</p>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : violations.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No violations detected. All traces have passed policy checks.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {violations.map((trace: any) => (
            <Card key={trace.trace_id} className="border-red-200">
              <CardHeader className="pb-2">
                <CardTitle className="text-base text-red-700">{trace.tool_call?.tool_name}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-sm space-y-1">
                  <div><span className="font-medium">Agent:</span> {trace.agent_id}</div>
                  <div><span className="font-medium">Policy:</span> {trace.safety_validation?.policy_name}</div>
                  <div><span className="font-medium">Risk:</span> {trace.safety_validation?.risk_level}</div>
                  <div><span className="font-medium">Violations:</span> {trace.safety_validation?.violations?.join(', ')}</div>
                  <div><span className="font-medium">Time:</span> {new Date(trace.timestamp).toLocaleString()}</div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
