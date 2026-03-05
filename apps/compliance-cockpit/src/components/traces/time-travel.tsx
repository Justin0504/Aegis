'use client'

import { useState, useEffect, useRef } from 'react'
import { Play, Pause, SkipBack, SkipForward, ChevronLeft, ChevronRight } from 'lucide-react'
import { Globe, FileText, Database, Send, Zap, CheckCircle, AlertCircle } from 'lucide-react'

const TOOL_META: Record<string, { icon: React.ElementType; color: string }> = {
  web_search:   { icon: Globe,    color: 'hsl(200 80% 55%)' },
  read_file:    { icon: FileText, color: 'hsl(260 70% 65%)' },
  execute_sql:  { icon: Database, color: 'hsl(43 80% 55%)'  },
  send_request: { icon: Send,     color: 'hsl(140 60% 50%)' },
}

function fmt(ts: string) {
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

interface TimeTravelProps {
  traces: any[]
  selectedAgent: string | null
}

export function TimeTravel({ traces, selectedAgent }: TimeTravelProps) {
  const filtered = [...(selectedAgent
    ? traces.filter(t => t.agent_id === selectedAgent)
    : traces
  )].sort((a, b) => a.sequence_number - b.sequence_number)

  const [idx, setIdx]         = useState(0)
  const [playing, setPlaying] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const listRef  = useRef<HTMLDivElement>(null)

  // Auto-advance
  useEffect(() => {
    if (playing) {
      timerRef.current = setInterval(() => {
        setIdx(prev => {
          if (prev >= filtered.length - 1) { setPlaying(false); return prev }
          return prev + 1
        })
      }, 1200)
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [playing, filtered.length])

  // Scroll active step into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${idx}"]`) as HTMLElement
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [idx])

  const current = filtered[idx]

  if (filtered.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-lg h-64 text-sm"
        style={{ background: 'hsl(0 0% 10%)', color: 'hsl(0 0% 40%)' }}
      >
        No traces to replay
      </div>
    )
  }

  const meta    = TOOL_META[current?.tool_call?.tool_name] || { icon: Zap, color: 'hsl(0 0% 55%)' }
  const Icon    = meta.icon
  const hasErr  = !!current?.observation?.error
  const dur     = current?.observation?.duration_ms
  const pct     = filtered.length > 1 ? (idx / (filtered.length - 1)) * 100 : 100

  return (
    <div
      className="rounded-lg border overflow-hidden"
      style={{ background: 'hsl(0 0% 9%)', borderColor: 'hsl(0 0% 15%)', height: 'calc(100vh - 280px)' }}
    >
      <div className="flex h-full">
        {/* ── Left: Step list ── */}
        <div
          className="w-48 flex-shrink-0 border-r flex flex-col"
          style={{ borderColor: 'hsl(0 0% 14%)' }}
        >
          <div className="px-3 py-2.5 border-b" style={{ borderColor: 'hsl(0 0% 14%)' }}>
            <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'hsl(0 0% 35%)' }}>
              Steps ({filtered.length})
            </p>
          </div>
          <div ref={listRef} className="flex-1 overflow-y-auto py-1">
            {filtered.map((t, i) => {
              const m     = TOOL_META[t.tool_call?.tool_name] || { icon: Zap, color: 'hsl(0 0% 55%)' }
              const StepIcon = m.icon
              const active = i === idx
              return (
                <button
                  key={t.trace_id}
                  data-idx={i}
                  onClick={() => { setPlaying(false); setIdx(i) }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors"
                  style={{
                    background: active ? `${m.color}18` : 'transparent',
                    borderLeft: active ? `2px solid ${m.color}` : '2px solid transparent',
                  }}
                >
                  <StepIcon className="h-3 w-3 flex-shrink-0" style={{ color: m.color }} />
                  <div className="min-w-0">
                    <p className="text-xs truncate font-medium" style={{ color: active ? m.color : 'hsl(0 0% 55%)' }}>
                      {t.tool_call?.tool_name}
                    </p>
                    <p className="text-[10px]" style={{ color: 'hsl(0 0% 30%)' }}>
                      #{i + 1}
                    </p>
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* ── Right: Detail + controls ── */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Progress bar */}
          <div className="h-0.5 w-full" style={{ background: 'hsl(0 0% 14%)' }}>
            <div
              className="h-full transition-all duration-300"
              style={{ width: `${pct}%`, background: 'hsl(43 56% 52%)' }}
            />
          </div>

          {/* Controls */}
          <div
            className="flex items-center gap-2 px-4 py-2.5 border-b"
            style={{ borderColor: 'hsl(0 0% 14%)' }}
          >
            <button
              onClick={() => { setPlaying(false); setIdx(0) }}
              disabled={idx === 0}
              className="p-1.5 rounded transition-colors disabled:opacity-30"
              style={{ color: 'hsl(0 0% 55%)' }}
              title="Jump to start"
            >
              <SkipBack className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => { setPlaying(false); setIdx(i => Math.max(0, i - 1)) }}
              disabled={idx === 0}
              className="p-1.5 rounded transition-colors disabled:opacity-30"
              style={{ color: 'hsl(0 0% 55%)' }}
              title="Previous step"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>

            {/* Play/Pause */}
            <button
              onClick={() => setPlaying(p => !p)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold transition-colors"
              style={{
                background: playing ? 'hsl(0 0% 18%)' : 'hsl(43 56% 52% / 0.15)',
                color: playing ? 'hsl(0 0% 70%)' : 'hsl(43 56% 62%)',
                border: `1px solid ${playing ? 'hsl(0 0% 22%)' : 'hsl(43 56% 52% / 0.4)'}`,
              }}
            >
              {playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
              {playing ? 'Pause' : 'Play'}
            </button>

            <button
              onClick={() => { setPlaying(false); setIdx(i => Math.min(filtered.length - 1, i + 1)) }}
              disabled={idx === filtered.length - 1}
              className="p-1.5 rounded transition-colors disabled:opacity-30"
              style={{ color: 'hsl(0 0% 55%)' }}
              title="Next step"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => { setPlaying(false); setIdx(filtered.length - 1) }}
              disabled={idx === filtered.length - 1}
              className="p-1.5 rounded transition-colors disabled:opacity-30"
              style={{ color: 'hsl(0 0% 55%)' }}
              title="Jump to end"
            >
              <SkipForward className="h-3.5 w-3.5" />
            </button>

            <span className="ml-auto text-xs" style={{ color: 'hsl(0 0% 35%)' }}>
              Step {idx + 1} of {filtered.length}
            </span>
          </div>

          {/* Current step detail */}
          {current && (
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {/* Tool header */}
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-lg" style={{ background: `${meta.color}18` }}>
                  <Icon className="h-5 w-5" style={{ color: meta.color }} />
                </div>
                <div>
                  <p className="font-semibold text-sm" style={{ color: meta.color }}>
                    {current.tool_call?.tool_name}
                  </p>
                  <p className="text-xs" style={{ color: 'hsl(0 0% 35%)' }}>
                    {fmt(current.timestamp)}
                    {dur !== undefined && ` · ${dur < 1 ? '<1ms' : `${Math.round(dur)}ms`}`}
                    {' · '}
                    <span>seq #{current.sequence_number}</span>
                  </p>
                </div>
                <div className="ml-auto">
                  {hasErr
                    ? <div className="flex items-center gap-1.5 text-xs px-2 py-1 rounded" style={{ background: 'hsl(0 62% 30% / 0.2)', color: 'hsl(0 62% 60%)' }}>
                        <AlertCircle className="h-3 w-3" /> Error
                      </div>
                    : <div className="flex items-center gap-1.5 text-xs px-2 py-1 rounded" style={{ background: 'hsl(140 40% 25% / 0.2)', color: 'hsl(140 60% 50%)' }}>
                        <CheckCircle className="h-3 w-3" /> OK
                      </div>
                  }
                </div>
              </div>

              {/* Input */}
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'hsl(0 0% 35%)' }}>
                  Input Prompt
                </p>
                <div className="rounded-md px-3 py-2.5 text-sm break-all" style={{ background: 'hsl(0 0% 12%)', color: 'hsl(0 0% 80%)' }}>
                  {current.input_context?.prompt || '—'}
                </div>
              </div>

              {/* Thought chain */}
              {current.thought_chain?.raw_tokens && current.thought_chain.raw_tokens !== 'No thought chain captured' && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'hsl(0 0% 35%)' }}>
                    Thought Chain
                  </p>
                  <div className="rounded-md px-3 py-2.5 text-xs italic break-all" style={{ background: 'hsl(0 0% 12%)', color: 'hsl(0 0% 55%)' }}>
                    {current.thought_chain.raw_tokens}
                  </div>
                </div>
              )}

              {/* Output */}
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: hasErr ? 'hsl(0 62% 50%)' : 'hsl(0 0% 35%)' }}>
                  {hasErr ? 'Error' : 'Result'}
                </p>
                <div
                  className="rounded-md px-3 py-2.5 text-xs font-mono break-all"
                  style={{
                    background: hasErr ? 'hsl(0 62% 20% / 0.15)' : 'hsl(0 0% 12%)',
                    color: hasErr ? 'hsl(0 62% 60%)' : 'hsl(0 0% 65%)',
                  }}
                >
                  {hasErr ? current.observation.error : JSON.stringify(current.observation?.raw_output, null, 2)}
                </div>
              </div>

              {/* Hash chain */}
              {current.integrity_hash && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'hsl(0 0% 25%)' }}>
                    Integrity Hash
                  </p>
                  <p className="text-[10px] font-mono break-all" style={{ color: 'hsl(0 0% 28%)' }}>
                    {current.integrity_hash}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
