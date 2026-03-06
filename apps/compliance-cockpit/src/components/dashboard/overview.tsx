'use client'

import { useQuery } from '@tanstack/react-query'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RecentTraces } from './recent-traces'
import { ViolationChart } from './violation-chart'
import { ApprovalStats } from './approval-stats'
import { AgentActivity } from './agent-activity'
import { AnomalyPanel } from './anomaly-panel'
import { CostPanel } from './cost-panel'
import { EvalPanel } from './eval-panel'
import { SessionsPanel } from './sessions-panel'

export function DashboardOverview() {
  const { data: stats } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: async () => {
      const response = await fetch('/api/gateway/stats')
      if (!response.ok) throw new Error('Failed to fetch stats')
      return response.json()
    },
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground">
          Real-time monitoring of AI agent activities and compliance
        </p>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Traces</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.totalTraces || 0}</div>
            <p className="text-xs text-muted-foreground">
              +20.1% from last hour
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
              Pending Approvals
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats?.pendingApprovals || 0}
            </div>
            <p className="text-xs text-muted-foreground">
              {stats?.criticalApprovals || 0} critical
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
              {stats?.blockedAgents || 0} agents blocked
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Main Content Tabs */}
      <Tabs defaultValue="activity" className="space-y-4">
        <TabsList>
          <TabsTrigger value="activity">Agent Activity</TabsTrigger>
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
        <TabsContent value="anomalies" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Anomaly Detection</CardTitle>
              <CardDescription>
                Statistical anomalies: frequency spikes, latency outliers, failure streaks
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