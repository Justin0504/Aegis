'use client'

import { useQuery } from '@tanstack/react-query'
import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Search, X, ArrowRight, AlertTriangle } from 'lucide-react'
import Link from 'next/link'
import { RecentTraces } from './recent-traces'
import { ViolationChart } from './violation-chart'
import { ApprovalStats } from './approval-stats'
import { AgentActivity } from './agent-activity'
import { AnomalyPanel } from './anomaly-panel'
import { CostPanel } from './cost-panel'
import { EvalPanel } from './eval-panel'
import { SessionsPanel } from './sessions-panel'
import { LiveFeed } from './live-feed'

const BORDER = 'hsl(36 12% 88%)'
const MUTED  = 'hsl(30 8% 55%)'
const TEXT   = 'hsl(30 10% 15%)'

function GlobalSearch() {
  const [query, setQuery] = useState('')
  const [open, setOpen]   = useState(false)
  const router = useRouter()

  const { data: traces } = useQuery({
    queryKey: ['search-traces', query],
    queryFn: async () => {
      if (!query.trim()) return []
      const res = await fetch(`/api/gateway/traces?limit=200`)
      if (!res.ok) return []
      const d = await res.json()
      return d.traces ?? []
    },
    enabled: query.trim().length >= 2,
    staleTime: 5000,
  })

  const results = useMemo(() => {
    if (!query.trim() || !traces?.length) return []
    const q = query.toLowerCase()
    return traces.filter((t: any) => {
      const hay = [t.trace_id, t.agent_id, t.tool_call?.tool_name, t.input_context?.prompt]
        .filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    }).slice(0, 6)
  }, [query, traces])

  return (
    <div className="relative">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4" style={{ color: MUTED }} />
        <input
          className="w-full rounded-lg pl-10 pr-10 py-2.5 text-sm border outline-none transition-shadow"
          style={{ borderColor: open && results.length > 0 ? 'hsl(38 20% 46% / 0.4)' : BORDER, background: '#fff', color: TEXT, boxShadow: open && results.length > 0 ? '0 4px 16px hsl(38 20% 46% / 0.08)' : 'none' }}
          placeholder="Search agents, tools, trace IDs..."
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
        />
        {query && (
          <button onClick={() => { setQuery(''); setOpen(false) }} className="absolute right-3 top-1/2 -translate-y-1/2" style={{ color: MUTED }}>
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {open && results.length > 0 && (
        <div className="absolute z-50 w-full mt-1 rounded-lg border overflow-hidden" style={{ background: '#fff', borderColor: BORDER, boxShadow: '0 8px 24px hsl(30 10% 15% / 0.08)' }}>
          {results.map((t: any) => (
            <button
              key={t.trace_id}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors"
              style={{ color: TEXT }}
              onMouseDown={() => { router.push(`/traces?id=${t.trace_id}`); setOpen(false); setQuery('') }}
              onMouseEnter={e => (e.currentTarget.style.background = 'hsl(36 14% 95%)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium truncate">{t.tool_call?.tool_name || 'unknown'}</p>
                <p className="text-[10px] truncate" style={{ color: MUTED }}>{t.agent_id} · {t.trace_id.substring(0, 8)}</p>
              </div>
              <ArrowRight className="h-3 w-3 flex-shrink-0" style={{ color: MUTED }} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function DashboardOverview() {
  const { data: stats } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: async () => {
      const response = await fetch('/api/gateway/stats')
      if (!response.ok) throw new Error('Failed to fetch stats')
      return response.json()
    },
    refetchInterval: 10_000,
  })

  const trendLabel = (value: number | undefined) => {
    if (value === undefined || value === null) return null
    const sign = value > 0 ? '+' : ''
    const color = value > 0 ? 'hsl(150 18% 40%)' : value < 0 ? 'hsl(0 14% 46%)' : 'hsl(30 8% 55%)'
    return (
      <span style={{ color }}>{sign}{value}% vs prev hour</span>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground">
            Real-time monitoring of AI agent activities and compliance
          </p>
        </div>
        <div className="w-80 flex-shrink-0 pt-1">
          <GlobalSearch />
        </div>
      </div>

      {/* Pending checks alert banner */}
      {(stats?.pendingChecks ?? 0) > 0 && (
        <Link
          href="/approvals"
          className="flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors"
          style={{
            background: 'hsl(38 30% 95%)',
            borderColor: 'hsl(38 24% 78%)',
            color: 'hsl(30 14% 25%)',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'hsl(38 30% 92%)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'hsl(38 30% 95%)')}
        >
          <span className="flex items-center justify-center w-8 h-8 rounded-full flex-shrink-0"
            style={{ background: 'hsl(38 28% 88%)' }}>
            <AlertTriangle className="h-4 w-4" style={{ color: 'hsl(30 30% 38%)' }} />
          </span>
          <div className="flex-1">
            <p className="text-sm font-semibold">
              {stats.pendingChecks} pending {stats.pendingChecks === 1 ? 'check' : 'checks'} awaiting approval
            </p>
            <p className="text-xs" style={{ color: 'hsl(30 10% 45%)' }}>
              Agent actions are blocked until you approve or reject them
            </p>
          </div>
          <ArrowRight className="h-4 w-4 flex-shrink-0" style={{ color: 'hsl(30 10% 55%)' }} />
        </Link>
      )}

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Traces</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.totalTraces || 0}</div>
            <p className="text-xs text-muted-foreground">
              {trendLabel(stats?.tracesTrend) ?? 'No data yet'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Agents</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.activeAgents || 0}</div>
            <p className="text-xs text-muted-foreground">
              {stats?.newAgents || 0} new today
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Pending Checks
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" style={{ color: (stats?.pendingChecks ?? 0) > 0 ? 'hsl(30 30% 38%)' : undefined }}>
              {stats?.pendingChecks || 0}
            </div>
            <p className="text-xs text-muted-foreground">
              {stats?.criticalAlerts || 0} high/critical risk
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Violations (24h)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.violations24h || 0}</div>
            <p className="text-xs text-muted-foreground">
              {trendLabel(stats?.violationsTrend) ?? `${stats?.blockedAgents || 0} agents blocked`}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Main Content Tabs */}
      <Tabs defaultValue="activity" className="space-y-4">
        <TabsList>
          <TabsTrigger value="activity">Agent Activity</TabsTrigger>
          <TabsTrigger value="live">Live Feed</TabsTrigger>
          <TabsTrigger value="anomalies">Anomalies</TabsTrigger>
          <TabsTrigger value="violations">Violations</TabsTrigger>
          <TabsTrigger value="approvals">Approval Stats</TabsTrigger>
          <TabsTrigger value="costs">Costs</TabsTrigger>
          <TabsTrigger value="eval">Eval</TabsTrigger>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
        </TabsList>
        <TabsContent value="activity" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
            <Card className="col-span-4">
              <CardHeader>
                <CardTitle>Agent Activity</CardTitle>
                <CardDescription>
                  Real-time agent tool calls and traces
                </CardDescription>
              </CardHeader>
              <CardContent className="pl-2">
                <AgentActivity />
              </CardContent>
            </Card>
            <Card className="col-span-3">
              <CardHeader>
                <CardTitle>Recent Traces</CardTitle>
                <CardDescription>
                  Latest agent actions and their status
                </CardDescription>
              </CardHeader>
              <CardContent>
                <RecentTraces />
              </CardContent>
            </Card>
          </div>
        </TabsContent>
        <TabsContent value="live" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Live Feed</CardTitle>
              <CardDescription>
                Real-time event stream — terminal-style log of all agent activity
              </CardDescription>
            </CardHeader>
            <CardContent>
              <LiveFeed />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="anomalies" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Anomaly Detection</CardTitle>
              <CardDescription>
                Behavioral anomalies (baseline deviation) and real-time statistical outliers
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AnomalyPanel />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="violations" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Policy Violations</CardTitle>
              <CardDescription>
                Violations by policy type over the last 7 days
              </CardDescription>
            </CardHeader>
            <CardContent className="pl-2">
              <ViolationChart />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="approvals" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Approval Statistics</CardTitle>
              <CardDescription>
                Approval rates and response times
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ApprovalStats />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="costs" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Token Cost Tracking</CardTitle>
              <CardDescription>
                Token usage and USD spend across models and agents
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CostPanel />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="eval" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Evaluation & Scoring</CardTitle>
              <CardDescription>
                Thumbs up/down quality scores on individual traces
              </CardDescription>
            </CardHeader>
            <CardContent>
              <EvalPanel />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="sessions" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Sessions</CardTitle>
              <CardDescription>
                Grouped trace sessions across agents
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SessionsPanel />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}