'use client'

import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export function ApprovalsView() {
  const { data: approvals = [], isLoading } = useQuery({
    queryKey: ['approvals'],
    queryFn: async () => {
      const res = await fetch('/api/gateway/approvals')
      if (!res.ok) throw new Error('Failed to fetch approvals')
      return res.json()
    },
    refetchInterval: 3000,
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Approvals</h1>
        <p className="text-muted-foreground">Pending human approvals for high-risk agent actions</p>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : approvals.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No pending approvals. All agent actions are within policy bounds.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {approvals.map((approval: any) => (
            <Card key={approval.id}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{approval.tool_name}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-sm space-y-1">
                  <div><span className="font-medium">Agent:</span> {approval.agent_id}</div>
                  <div><span className="font-medium">Risk:</span> {approval.risk_level}</div>
                  <div><span className="font-medium">Expires:</span> {new Date(approval.expires_at).toLocaleString()}</div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
