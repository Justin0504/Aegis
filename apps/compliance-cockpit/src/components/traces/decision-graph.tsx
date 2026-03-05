'use client'

import { Globe, FileText, Database, Send, Zap, CheckCircle, AlertCircle, ArrowDown } from 'lucide-react'

const TOOL_META: Record<string, { icon: React.ElementType; color: string; label: string }> = {
  web_search:   { icon: Globe,     color: 'hsl(200 80% 55%)', label: 'Web Search'   },
  read_file:    { icon: FileText,  color: 'hsl(260 70% 65%)', label: 'Read File'    },
  execute_sql:  { icon: Database,  color: 'hsl(43 80% 55%)',  label: 'SQL Query'    },
  send_request: { icon: Send,      color: 'hsl(140 60% 50%)', label: 'HTTP Request' },
}

function getToolMeta(name: string) {
  return TOOL_META[name] || { icon: Zap, color: 'hsl(0 0% 55%)', label: name }
}

interface DecisionGraphProps {
  agentId: string | null
  traces: any[]
}

export function DecisionGraph({ agentId, traces }: DecisionGraphProps) {
  const sorted = [...traces].sort(
    (a, b) => a.sequence_number - b.sequence_number
  )

  if (sorted.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-lg h-64 text-sm"
        style={{ background: 'hsl(0 0% 10%)', color: 'hsl(0 0% 40%)' }}
      >
        Select a trace session to view execution flow
      </div>
    )
  }

  return (
    <div
      className="rounded-lg border overflow-y-auto p-6"
      style={{
        background: 'hsl(0 0% 9%)',
        borderColor: 'hsl(0 0% 15%)',
        maxHeight: 'calc(100vh - 280px)',
      }}
    >
      <div className="flex flex-col items-center gap-0">
        {/* Start node */}
        <div
          className="px-4 py-1.5 rounded-full text-xs font-semibold tracking-widest uppercase mb-0"
          style={{ background: 'hsl(43 56% 52% / 0.15)', color: 'hsl(43 56% 62%)', border: '1px solid hsl(43 56% 52% / 0.3)' }}
        >
          Agent Session
        </div>

        {sorted.map((trace, i) => {
          const meta   = getToolMeta(trace.tool_call?.tool_name || '')
          const Icon   = meta.icon
          const hasErr = !!trace.observation?.error
          const dur    = trace.observation?.duration_ms
          const prompt = String(trace.input_context?.prompt || '').slice(0, 80)
          const output = String(trace.observation?.raw_output || '').slice(0, 80)

          return (
            <div key={trace.trace_id} className="flex flex-col items-center w-full max-w-xl">
              {/* Arrow */}
              <div className="flex flex-col items-center py-1">
                <div className="w-px h-4" style={{ background: 'hsl(0 0% 20%)' }} />
                <ArrowDown className="h-3 w-3 -mt-0.5" style={{ color: 'hsl(0 0% 25%)' }} />
              </div>

              {/* Step card */}
              <div
                className="w-full rounded-lg border p-4 relative"
                style={{ background: 'hsl(0 0% 12%)', borderColor: hasErr ? 'hsl(0 62% 40% / 0.6)' : `${meta.color}30` }}
              >
                {/* Step number */}
                <span
                  className="absolute -top-2.5 left-4 text-[10px] font-bold px-1.5 py-0.5 rounded"
                  style={{ background: 'hsl(0 0% 9%)', color: 'hsl(0 0% 35%)', border: '1px solid hsl(0 0% 18%)' }}
                >
                  STEP {i + 1}
                </span>

                <div className="flex items-start gap-3">
                  {/* Icon */}
                  <div
                    className="mt-0.5 p-2 rounded-md flex-shrink-0"
                    style={{ background: `${meta.color}18` }}
                  >
                    <Icon className="h-4 w-4" style={{ color: meta.color }} />
                  </div>

                  <div className="flex-1 min-w-0 space-y-2">
                    {/* Header */}
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-sm" style={{ color: meta.color }}>
                        {meta.label}
                      </span>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {dur !== undefined && (
                          <span className="text-[11px]" style={{ color: 'hsl(0 0% 35%)' }}>
                            {dur < 1 ? '<1ms' : `${Math.round(dur)}ms`}
                          </span>
                        )}
                        {hasErr
                          ? <AlertCircle className="h-3.5 w-3.5" style={{ color: 'hsl(0 62% 50%)' }} />
                          : <CheckCircle className="h-3.5 w-3.5" style={{ color: 'hsl(140 60% 45%)' }} />
                        }
                      </div>
                    </div>

                    {/* Input */}
                    <div>
                      <span className="text-[10px] uppercase tracking-wider font-medium" style={{ color: 'hsl(0 0% 35%)' }}>Input</span>
                      <p className="text-xs mt-0.5 break-all" style={{ color: 'hsl(0 0% 70%)' }}>{prompt}</p>
                    </div>

                    {/* Output */}
                    <div>
                      <span className="text-[10px] uppercase tracking-wider font-medium" style={{ color: hasErr ? 'hsl(0 62% 50%)' : 'hsl(0 0% 35%)' }}>
                        {hasErr ? 'Error' : 'Output'}
                      </span>
                      <p className="text-xs mt-0.5 break-all" style={{ color: hasErr ? 'hsl(0 62% 60%)' : 'hsl(0 0% 55%)' }}>
                        {hasErr ? trace.observation.error : output}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )
        })}

        {/* End arrow */}
        <div className="flex flex-col items-center py-1">
          <div className="w-px h-4" style={{ background: 'hsl(0 0% 20%)' }} />
          <ArrowDown className="h-3 w-3 -mt-0.5" style={{ color: 'hsl(0 0% 25%)' }} />
        </div>

        {/* End node */}
        <div
          className="px-4 py-1.5 rounded-full text-xs font-semibold tracking-widest uppercase"
          style={{ background: 'hsl(140 40% 30% / 0.2)', color: 'hsl(140 60% 50%)', border: '1px solid hsl(140 40% 30% / 0.4)' }}
        >
          Complete — {sorted.length} steps
        </div>
      </div>
    </div>
  )
}
