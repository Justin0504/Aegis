'use client'

import { useQuery } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const RISK_COLOR: Record<string, string> = {
  LOW: 'bg-green-100 text-green-800',
  MEDIUM: 'bg-yellow-100 text-yellow-800',
  HIGH: 'bg-orange-100 text-orange-800',
  CRITICAL: 'bg-red-100 text-red-800',
}

export function PoliciesView() {
  const { data: policies = [], isLoading } = useQuery({
    queryKey: ['policies'],
    queryFn: async () => {
      const res = await fetch('/api/gateway/policies')
      if (!res.ok) throw new Error('Failed to fetch policies')
      return res.json()
    },
    refetchInterval: 5000,
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Policies</h1>
        <p className="text-muted-foreground">Active safety policies enforced on all agents</p>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : policies.length === 0 ? (
        <p className="text-muted-foreground">No policies configured.</p>
      ) : (
        <div className="grid gap-4">
          {policies.map((policy: any) => (
            <Card key={policy.id}>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-base font-semibold">{policy.name}</CardTitle>
                <span className={`text-xs font-medium px-2 py-1 rounded-full ${RISK_COLOR[policy.risk_level] ?? 'bg-gray-100 text-gray-800'}`}>
                  {policy.risk_level}
                </span>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-3">{policy.description}</p>
                <pre className="text-xs bg-muted rounded p-3 overflow-auto">
                  {JSON.stringify(policy.policy_schema, null, 2)}
                </pre>
                <p className="text-xs text-muted-foreground mt-2">
                  Status: {policy.enabled ? 'Enabled' : 'Disabled'} · Created {new Date(policy.created_at).toLocaleDateString()}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
