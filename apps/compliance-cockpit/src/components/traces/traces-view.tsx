'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TracesList } from './traces-list'
import { TraceDetails } from './trace-details'
import { DecisionGraph } from './decision-graph'
import { TimeTravel } from './time-travel'
import { AgentActionTrace } from '@agentguard/core-schema'

export function TracesView() {
  const [selectedTrace, setSelectedTrace] = useState<string | null>(null)
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)

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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Traces</h1>
        <p className="text-muted-foreground">
          Forensic audit trail of all agent actions
        </p>
      </div>

      <Tabs defaultValue="list" className="space-y-4">
        <TabsList>
          <TabsTrigger value="list">Trace List</TabsTrigger>
          <TabsTrigger value="graph">Decision Graph</TabsTrigger>
          <TabsTrigger value="timetravel">Time Travel</TabsTrigger>
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
      </Tabs>
    </div>
  )
}