'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TracesList } from './traces-list'
import { TraceDetails } from './trace-details'
import { DecisionGraph } from './decision-graph'
import { TimeTravel } from './time-travel'
import { useAlerts } from '@/hooks/useAlerts'
import { AgentCompare } from './agent-compare'
import { FileDown } from 'lucide-react'

export function TracesView() {
  const [selectedTrace, setSelectedTrace] = useState<string | null>(null)
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  async function handleExport(allTraces: any[]) {
    setExporting(true)
    try {
      const { exportComplianceReport } = await import('@/lib/export-pdf')
      await exportComplianceReport({ traces: allTraces, generatedAt: new Date() })
    } finally {
      setExporting(false)
    }
  }

  function handleExportCsv(allTraces: any[]) {
    const rows = allTraces.map(t => {
      const tool = (() => { try { return JSON.parse(t.tool_call) } catch { return {} } })()
      const safe = (() => { try { return JSON.parse(t.safety_validation) } catch { return {} } })()
      return [
        t.trace_id, t.agent_id, t.timestamp, t.environment,
        tool?.name ?? '', safe?.risk_level ?? '', safe?.passed ? 'pass' : 'fail',
        t.blocked ? 'blocked' : '', t.session_id ?? '', t.model ?? '',
        t.cost_usd ?? 0, t.pii_detected ? 'yes' : 'no',
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
    })
    const csv = [
      'trace_id,agent_id,timestamp,environment,tool_name,risk_level,result,blocked,session_id,model,cost_usd,pii',
      ...rows,
    ].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `aegis-traces-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const { data: traces } = useQuery({
    queryKey: ['traces', selectedAgent],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (selectedAgent) params.append('agent_id', selectedAgent)
      params.append('limit', '100')

      const response = await fetch(`/api/gateway/traces?${params}`)
      if (!response.ok) throw new Error('Failed to fetch traces')
      return response.json()
    },
  })

  useAlerts(traces?.traces || [])

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Traces</h1>
          <p className="text-muted-foreground">Forensic audit trail of all agent actions</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => handleExportCsv(traces?.traces || [])}
            disabled={!traces?.traces?.length}
            className="flex items-center gap-2 text-sm px-4 py-2 rounded-lg border font-medium transition-colors disabled:opacity-40"
            style={{ borderColor: 'hsl(36 12% 85%)', color: 'hsl(30 10% 25%)', background: '#fff' }}
          >
            <FileDown className="h-4 w-4" />
            Export CSV
          </button>
          <button
            onClick={() => handleExport(traces?.traces || [])}
            disabled={exporting || !traces?.traces?.length}
            className="flex items-center gap-2 text-sm px-4 py-2 rounded-lg border font-medium transition-colors disabled:opacity-40"
            style={{ borderColor: 'hsl(36 12% 85%)', color: 'hsl(30 10% 25%)', background: '#fff' }}
          >
            <FileDown className="h-4 w-4" />
            {exporting ? 'Generating…' : 'Export PDF'}
          </button>
        </div>
      </div>

      <Tabs defaultValue="list" className="space-y-4">
        <TabsList>
          <TabsTrigger value="list">Trace List</TabsTrigger>
          <TabsTrigger value="graph">Decision Graph</TabsTrigger>
          <TabsTrigger value="timetravel">Time Travel</TabsTrigger>
          <TabsTrigger value="compare">Agent Compare</TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-12">
            <div className="col-span-5">
              <TracesList
                traces={traces?.traces || []}
                selectedTrace={selectedTrace}
                onSelectTrace={setSelectedTrace}
                onSelectAgent={setSelectedAgent}
              />
            </div>
            <div className="col-span-7">
              {selectedTrace && (
                <TraceDetails
                  traceId={selectedTrace}
                  onExport={() => {}}
                />
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="graph" className="space-y-4">
          <DecisionGraph
            agentId={selectedAgent}
            traces={traces?.traces || []}
          />
        </TabsContent>

        <TabsContent value="timetravel" className="space-y-4">
          <TimeTravel
            traces={traces?.traces || []}
            selectedAgent={selectedAgent}
          />
        </TabsContent>

        <TabsContent value="compare" className="space-y-4">
          <AgentCompare traces={traces?.traces || []} />
        </TabsContent>
      </Tabs>
    </div>
  )
}