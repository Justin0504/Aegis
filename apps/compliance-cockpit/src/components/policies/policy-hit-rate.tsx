'use client'

/**
 * Per-rule hit rate for the Policies page.
 *
 * Reads /api/gateway/policies/hit-rate — one row per DSL rule that
 * has ever blocked or held a call. Sorted by total-lifetime hits.
 * Blocks vs pendings split out so a rule that's holding-for-review
 * a lot but rarely blocking reads clearly as "high friction, low
 * confidence".
 *
 * Empty state is deliberate: "No rule has fired yet" is a real
 * product signal — either the DSL is too loose, or your fleet
 * genuinely doesn't do what the rules were written to catch.
 */

import { useQuery } from '@tanstack/react-query'
import { gw } from '@/lib/gateway'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDistanceToNow } from 'date-fns'
import { AlertOctagon, Clock } from 'lucide-react'

interface Row {
  rule_name: string
  total: number
  h24: number
  d7: number
  blocks: number
  pendings: number
  last_fired: string | null
}

export function PolicyHitRate() {
  const { data, isLoading } = useQuery({
    queryKey: ['policy-hit-rate'],
    queryFn: async () => {
      const res = await gw('policies/hit-rate')
      if (!res.ok) return { rules: [] as Row[] }
      return res.json() as Promise<{ rules: Row[] }>
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  })

  const rules = data?.rules ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <AlertOctagon className="h-4 w-4" />
          Rule hit rate
        </CardTitle>
        <CardDescription>
          Which rules are actually catching things. Blocks stop the call; pendings hold it for human review.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Loading…</p>
        ) : rules.length === 0 ? (
          <div className="py-8 text-center text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
            No rule has fired yet.
            <div className="text-xs mt-1 opacity-70">
              Either your fleet is boring or your DSL is too loose. Install a pack, or check the Activity tab to see uncaught calls.
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wider" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  <th className="text-left py-2 font-medium">Rule</th>
                  <th className="text-right py-2 font-medium">24h</th>
                  <th className="text-right py-2 font-medium">7d</th>
                  <th className="text-right py-2 font-medium">All time</th>
                  <th className="text-right py-2 font-medium">Split</th>
                  <th className="text-right py-2 font-medium">Last fired</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.rule_name} className="border-t"
                      style={{ borderColor: 'hsl(var(--border))' }}>
                    <td className="py-2 pr-4">
                      <code className="text-xs font-mono">{r.rule_name}</code>
                    </td>
                    <td className="text-right tabular-nums font-medium">{r.h24}</td>
                    <td className="text-right tabular-nums">{r.d7}</td>
                    <td className="text-right tabular-nums">{r.total}</td>
                    <td className="text-right text-xs">
                      <span style={{ color: 'hsl(0 45% 40%)' }}>{r.blocks} block</span>
                      {r.pendings > 0 && (
                        <> · <span style={{ color: 'hsl(36 55% 32%)' }}>{r.pendings} hold</span></>
                      )}
                    </td>
                    <td className="text-right text-xs flex items-center gap-1 justify-end pt-2"
                        style={{ color: 'hsl(var(--muted-foreground))' }}>
                      <Clock className="h-3 w-3" />
                      {r.last_fired ? formatDistanceToNow(new Date(r.last_fired), { addSuffix: true }) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
