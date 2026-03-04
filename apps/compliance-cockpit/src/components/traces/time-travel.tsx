'use client'

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Slider } from '@/components/ui/slider'
import { Button } from '@/components/ui/button'
import { Play, Pause, SkipBack, SkipForward } from 'lucide-react'
import { formatDate } from '@/lib/utils'

interface TimeTravelProps {
  traces: any[]
  selectedAgent: string | null
}

export function TimeTravel({ traces, selectedAgent }: TimeTravelProps) {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)

  const filteredTraces = selectedAgent
    ? traces.filter((t) => t.agent_id === selectedAgent)
    : traces

  const currentTrace = filteredTraces[currentIndex]

  const handleSliderChange = (value: number[]) => {
    setCurrentIndex(value[0])
  }

  return (
    <Card className="h-[calc(100vh-200px)]">
      <CardHeader>
        <CardTitle>Time Travel Debugger</CardTitle>
        <p className="text-sm text-muted-foreground">
          Replay agent execution step by step
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Timeline Controls */}
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <Button
              size="icon"
              variant="outline"
              onClick={() => setCurrentIndex(0)}
              disabled={currentIndex === 0}
            >
              <SkipBack className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="outline"
              onClick={() => setIsPlaying(!isPlaying)}
            >
              {isPlaying ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )}
            </Button>
            <Button
              size="icon"
              variant="outline"
              onClick={() => setCurrentIndex(filteredTraces.length - 1)}
              disabled={currentIndex === filteredTraces.length - 1}
            >
              <SkipForward className="h-4 w-4" />
            </Button>
            <div className="flex-1">
              <Slider
                value={[currentIndex]}
                onValueChange={handleSliderChange}
                max={Math.max(0, filteredTraces.length - 1)}
                step={1}
                className="w-full"
              />
            </div>
            <span className="text-sm text-muted-foreground whitespace-nowrap">
              {currentIndex + 1} / {filteredTraces.length}
            </span>
          </div>

          {currentTrace && (
            <div className="text-sm text-muted-foreground">
              {formatDate(currentTrace.timestamp)}
            </div>
          )}
        </div>

        {/* Current State Display */}
        {currentTrace && (
          <div className="space-y-4">
            <div className="rounded-lg border p-4">
              <h3 className="font-semibold text-sm mb-2">Tool Call</h3>
              <p className="text-sm">{currentTrace.tool_call.tool_name}</p>
              <pre className="text-xs mt-2 overflow-x-auto">
                {JSON.stringify(currentTrace.tool_call.arguments, null, 2)}
              </pre>
            </div>

            {currentTrace.thought_chain?.raw_tokens && (
              <div className="rounded-lg border p-4">
                <h3 className="font-semibold text-sm mb-2">Thought Chain</h3>
                <p className="text-sm whitespace-pre-wrap">
                  {currentTrace.thought_chain.raw_tokens}
                </p>
              </div>
            )}

            <div className="rounded-lg border p-4">
              <h3 className="font-semibold text-sm mb-2">Result</h3>
              {currentTrace.observation.error ? (
                <p className="text-sm text-destructive">
                  Error: {currentTrace.observation.error}
                </p>
              ) : (
                <pre className="text-xs overflow-x-auto">
                  {JSON.stringify(currentTrace.observation.raw_output, null, 2)}
                </pre>
              )}
            </div>

            {/* Agent State at this point */}
            <div className="rounded-lg bg-muted p-4">
              <h3 className="font-semibold text-sm mb-2">Agent State</h3>
              <div className="space-y-1 text-sm">
                <p>Sequence: {currentTrace.sequence_number}</p>
                <p>Environment: {currentTrace.environment}</p>
                {currentTrace.tags && (
                  <p>Tags: {currentTrace.tags.join(', ')}</p>
                )}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}