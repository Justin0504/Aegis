'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatDate, getStatusColor, getRiskLevelColor } from '@/lib/utils'
import { Search, Filter } from 'lucide-react'
import { useState } from 'react'

interface TracesListProps {
  traces: any[]
  selectedTrace: string | null
  onSelectTrace: (traceId: string) => void
  onSelectAgent: (agentId: string) => void
}

export function TracesList({
  traces,
  selectedTrace,
  onSelectTrace,
  onSelectAgent,
}: TracesListProps) {
  const [search, setSearch] = useState('')

  const filteredTraces = traces.filter(
    (trace) =>
      trace.agent_id.includes(search) ||
      trace.tool_call.tool_name.toLowerCase().includes(search.toLowerCase()) ||
      trace.trace_id.includes(search)
  )

  return (
    <Card className="h-[calc(100vh-200px)] overflow-hidden flex flex-col">
      <CardHeader>
        <CardTitle>Traces</CardTitle>
        <div className="flex gap-2 mt-4">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search traces..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          <Button variant="outline" size="icon">
            <Filter className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto px-0">
        <div className="space-y-2 px-6">
          {filteredTraces.map((trace) => (
            <div
              key={trace.trace_id}
              className={`p-4 rounded-lg border cursor-pointer transition-colors ${
                selectedTrace === trace.trace_id
                  ? 'bg-accent'
                  : 'hover:bg-accent/50'
              }`}
              onClick={() => onSelectTrace(trace.trace_id)}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-1 flex-1">
                  <p className="font-medium text-sm">{trace.tool_call.tool_name}</p>
                  <p className="text-xs text-muted-foreground">
                    <button
                      className="hover:underline"
                      onClick={(e) => {
                        e.stopPropagation()
                        onSelectAgent(trace.agent_id)
                      }}
                    >
                      {trace.agent_id.substring(0, 8)}...
                    </button>
                    {' • '}
                    {formatDate(trace.timestamp)}
                  </p>
                </div>
                <div className="space-y-1">
                  <Badge
                    variant="outline"
                    className={getStatusColor(trace.approval_status || 'PENDING')}
                  >
                    {trace.approval_status || 'PENDING'}
                  </Badge>
                  {trace.safety_validation && !trace.safety_validation.passed && (
                    <Badge
                      variant="outline"
                      className={getRiskLevelColor(
                        trace.safety_validation.risk_level
                      )}
                    >
                      {trace.safety_validation.risk_level}
                    </Badge>
                  )}
                </div>
              </div>
              {trace.observation?.error && (
                <p className="text-xs text-destructive mt-2">
                  Error: {trace.observation.error}
                </p>
              )}
            </div>
          ))}
          {filteredTraces.length === 0 && (
            <p className="text-center text-muted-foreground py-8">
              No traces found
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}