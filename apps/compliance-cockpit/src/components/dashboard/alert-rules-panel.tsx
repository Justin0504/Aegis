'use client'

/**
 * Alerts panel on Overview.
 *
 * Two stacked sections:
 *   1. Rule editor — reuses the existing AlertRules component from
 *      Settings, which persists to localStorage via useAlerts.
 *   2. Recent fires — pulls the last 20 violations from the gateway so
 *      the operator can see what would have (or did) trip a rule
 *      without leaving the Overview.
 *
 * When we back rules with the gateway DB later, this panel is where
 * we swap the persistence layer — the UI stays put.
 */

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { Bell, ArrowRight } from 'lucide-react'
import { gw } from '@/lib/gateway'
import { AlertRules } from '@/components/settings/alert-rules'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'

interface Violation {
  id: string
  agent_id: string
  policy_id?: string | null
  trace_id?: string | null
  violation_type: string
  details?: string | null
  created_at: string
}

function RecentFires() {
  const { data: violations, isLoading } = useQuery<Violation[]>({
    queryKey: ['recent-violations'],
    queryFn: async () => {
      const res = await gw('violations?limit=20')
      if (!res.ok) return []
      const body = await res.json()
      return (body?.violations ?? body?.items ?? []) as Violation[]
    },
    refetchInterval: 15_000,
    staleTime: 10_000,
  })

  if (isLoading) {
    return <div className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Loading recent fires…</div>
  }
  if (!violations || violations.length === 0) {
    return (
      <div className="text-xs py-6 text-center" style={{ color: 'hsl(var(--muted-foreground))' }}>
        No violations in the last 24 hours. Rules stay quiet when the fleet stays boring.
      </div>
    )
  }

  return (
    <ul className="divide-y" style={{ borderColor: 'hsl(var(--border))' }}>
      {violations.slice(0, 12).map((v) => (
        <li key={v.id} className="py-2 flex items-start gap-3 text-sm">
          <span className="mt-1 h-2 w-2 rounded-full flex-shrink-0"
                style={{ background: v.violation_type === 'policy_block' ? 'hsl(0 55% 45%)' : 'hsl(36 65% 45%)' }} />
          <div className="flex-1 min-w-0">
            <div className="font-medium truncate" style={{ color: 'hsl(var(--foreground))' }}>
              {v.violation_type}
              {v.policy_id ? <span className="ml-2 text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>· {v.policy_id}</span> : null}
            </div>
            <div className="text-xs mt-0.5 truncate" style={{ color: 'hsl(var(--muted-foreground))' }}>
              {v.agent_id} · {new Date(v.created_at).toLocaleString()}
              {v.details ? <span className="ml-2">— {typeof v.details === 'string' ? v.details : JSON.stringify(v.details)}</span> : null}
            </div>
          </div>
          {v.trace_id && (
            <Link href={`/traces?id=${v.trace_id}`} className="text-xs flex items-center gap-1 flex-shrink-0"
                  style={{ color: 'hsl(var(--muted-foreground))' }}>
              trace
              <ArrowRight className="h-3 w-3" />
            </Link>
          )}
        </li>
      ))}
    </ul>
  )
}

export function AlertRulesPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Bell className="h-4 w-4" />
            Alert rules
          </CardTitle>
          <CardDescription>
            Rules fire when the condition holds over the window. Destinations: webhook, Slack, PagerDuty.
            Rules persist in this browser — coming soon: gateway-side sync.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AlertRules />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent fires</CardTitle>
          <CardDescription>Last 12 violations — anything a rule would (or did) trip on.</CardDescription>
        </CardHeader>
        <CardContent>
          <RecentFires />
        </CardContent>
      </Card>
    </div>
  )
}
