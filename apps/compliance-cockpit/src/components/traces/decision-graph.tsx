'use client'

import ReactFlow, {
  Node,
  Edge,
  Controls,
  MiniMap,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
} from 'reactflow'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useEffect } from 'react'
import { getRiskLevelColor } from '@/lib/utils'

interface DecisionGraphProps {
  agentId: string | null
  traces: any[]
}

export function DecisionGraph({ agentId, traces }: DecisionGraphProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])

  useEffect(() => {
    // Convert traces to flow nodes and edges
    const flowNodes: Node[] = traces.map((trace, index) => ({
      id: trace.trace_id,
      position: { x: 250 * (index % 4), y: 150 * Math.floor(index / 4) },
      data: {
        label: (
          <div className="text-xs">
            <p className="font-medium">{trace.tool_call.tool_name}</p>
            <p className="text-[10px] text-gray-500">
              {new Date(trace.timestamp).toLocaleTimeString()}
            </p>
          </div>
        ),
      },
      style: {
        background: trace.safety_validation?.passed === false ? '#fef2f2' : '#f0fdf4',
        border: trace.safety_validation?.passed === false ? '2px solid #ef4444' : '2px solid #10b981',
        borderRadius: 8,
        padding: 10,
      },
    }))

    const flowEdges: Edge[] = traces
      .filter((trace) => trace.parent_trace_id)
      .map((trace) => ({
        id: `${trace.parent_trace_id}-${trace.trace_id}`,
        source: trace.parent_trace_id,
        target: trace.trace_id,
        animated: trace.safety_validation?.risk_level === 'CRITICAL',
        style: {
          stroke: trace.safety_validation?.passed === false ? '#ef4444' : '#10b981',
        },
      }))

    setNodes(flowNodes)
    setEdges(flowEdges)
  }, [traces, setNodes, setEdges])

  return (
    <Card className="h-[calc(100vh-200px)]">
      <CardHeader>
        <CardTitle>Agent Decision Graph</CardTitle>
        <p className="text-sm text-muted-foreground">
          Visual representation of agent reasoning and tool calls
        </p>
      </CardHeader>
      <CardContent className="h-[calc(100%-100px)]">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          fitView
        >
          <Controls />
          <MiniMap />
          <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
        </ReactFlow>
      </CardContent>
    </Card>
  )
}