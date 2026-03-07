'use client'

import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { formatDate } from '@/lib/utils'
import { traceSummary } from '@/lib/trace-summary'
import { Search, X, ChevronDown, CheckCircle, AlertCircle, Clock } from 'lucide-react'
import { useState, useMemo, useRef, useEffect } from 'react'

const TOOL_OPTIONS = ['all', 'web_search', 'read_file', 'execute_sql', 'send_request', 'other']
const STATUS_OPTIONS = [
  { value: 'all',     label: 'All'     },
  { value: 'ok',      label: 'OK'      },
  { value: 'error',   label: 'Error'   },
  { value: 'pending', label: 'Pending' },
]
const TIME_OPTIONS = [
  { value: 'all',  label: 'All time'   },
  { value: '5m',   label: 'Last 5 min' },
  { value: '1h',   label: 'Last hour'  },
  { value: '24h',  label: 'Last 24h'   },
]

const BORDER  = 'hsl(36 12% 88%)'
const MUTED   = 'hsl(30 8% 55%)'
const TEXT    = 'hsl(30 10% 15%)'

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>
  const q = query.toLowerCase()
  const idx = text.toLowerCase().indexOf(q)
  if (idx === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ background: 'hsl(38 40% 75% / 0.45)', color: 'inherit', borderRadius: 2, padding: '0 1px' }}>
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  )
}

function timeWindowMs(value: string): number | null {
  if (value === '5m')  return 5  * 60 * 1000
  if (value === '1h')  return 60 * 60 * 1000
  if (value === '24h') return 24 * 60 * 60 * 1000
  return null
}

interface TracesListProps {
  traces: any[]
  selectedTrace: string | null
  onSelectTrace: (id: string) => void
  onSelectAgent: (id: string) => void
}

export function TracesList({ traces, selectedTrace, onSelectTrace, onSelectAgent }: TracesListProps) {
  const [search,     setSearch]     = useState('')
  const [toolFilter, setToolFilter] = useState('all')
  const [status,     setStatus]     = useState('all')
  const [timeRange,  setTimeRange]  = useState('all')
  const [filtersOpen, setFiltersOpen] = useState(false)

  // Track new trace IDs for slide-in animation
  const knownIds = useRef<Set<string>>(new Set())
  const newIds = useRef<Set<string>>(new Set())
  useEffect(() => {
    const incoming = new Set<string>()
    for (const t of traces) {
      if (!knownIds.current.has(t.trace_id)) incoming.add(t.trace_id)
      knownIds.current.add(t.trace_id)
    }
    newIds.current = incoming
    // Clear "new" status after animation
    if (incoming.size > 0) {
      const timer = setTimeout(() => { newIds.current = new Set() }, 1200)
      return () => clearTimeout(timer)
    }
  }, [traces])

  const filtered = useMemo(() => {
    const now = Date.now()
    const windowMs = timeWindowMs(timeRange)
    const q = search.toLowerCase().trim()

    return traces.filter(t => {
      // Time window
      if (windowMs) {
        const ts = new Date(t.timestamp).getTime()
        if (now - ts > windowMs) return false
      }

      // Tool
      if (toolFilter !== 'all') {
        const tool = t.tool_call?.tool_name || ''
        if (toolFilter === 'other') {
          if (TOOL_OPTIONS.slice(1, -1).includes(tool)) return false
        } else if (tool !== toolFilter) return false
      }

      // Status
      if (status === 'ok'      && t.observation?.error) return false
      if (status === 'error'   && !t.observation?.error) return false
      if (status === 'pending' && t.approval_status !== 'PENDING') return false

      // Keyword
      if (q) {
        const hay = [
          t.trace_id,
          t.agent_id,
          t.tool_call?.tool_name,
          t.input_context?.prompt,
          t.observation?.raw_output,
          t.observation?.error,
        ].filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }

      return true
    })
  }, [traces, search, toolFilter, status, timeRange])

  const activeFilters = [toolFilter !== 'all', status !== 'all', timeRange !== 'all'].filter(Boolean).length

  return (
    <Card className="h-[calc(100vh-200px)] overflow-hidden flex flex-col">
      {/* Search bar */}
      <div className="px-4 pt-4 pb-3 border-b space-y-2" style={{ borderColor: BORDER }}>
        <div className="flex items-center gap-2">
          {/* Search input */}
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5" style={{ color: MUTED }} />
            <input
              className="w-full rounded-md pl-8 pr-3 py-1.5 text-sm border outline-none"
              style={{ borderColor: BORDER, background: '#fff', color: TEXT }}
              placeholder="Search traces, prompts, errors…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2" style={{ color: MUTED }}>
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Filter toggle */}
          <button
            onClick={() => setFiltersOpen(o => !o)}
            className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md border flex-shrink-0"
            style={{
              borderColor: activeFilters > 0 ? 'hsl(38 20% 46%)' : BORDER,
              color: activeFilters > 0 ? 'hsl(38 20% 42%)' : MUTED,
              background: activeFilters > 0 ? 'hsl(38 20% 46% / 0.08)' : '#fff',
            }}
          >
            Filters {activeFilters > 0 && <span className="font-bold">{activeFilters}</span>}
            <ChevronDown className={`h-3 w-3 transition-transform ${filtersOpen ? 'rotate-180' : ''}`} />
          </button>
        </div>

        {/* Filter row */}
        {filtersOpen && (
          <div className="flex items-center gap-2 pt-1">
            <select
              className="text-xs rounded-md px-2 py-1 border outline-none"
              style={{ borderColor: BORDER, background: '#fff', color: TEXT }}
              value={toolFilter}
              onChange={e => setToolFilter(e.target.value)}
            >
              {TOOL_OPTIONS.map(t => (
                <option key={t} value={t}>{t === 'all' ? 'All tools' : t}</option>
              ))}
            </select>

            <select
              className="text-xs rounded-md px-2 py-1 border outline-none"
              style={{ borderColor: BORDER, background: '#fff', color: TEXT }}
              value={status}
              onChange={e => setStatus(e.target.value)}
            >
              {STATUS_OPTIONS.map(s => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>

            <select
              className="text-xs rounded-md px-2 py-1 border outline-none"
              style={{ borderColor: BORDER, background: '#fff', color: TEXT }}
              value={timeRange}
              onChange={e => setTimeRange(e.target.value)}
            >
              {TIME_OPTIONS.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>

            {activeFilters > 0 && (
              <button
                onClick={() => { setToolFilter('all'); setStatus('all'); setTimeRange('all') }}
                className="text-xs ml-auto"
                style={{ color: 'hsl(0 18% 50%)' }}
              >
                Clear
              </button>
            )}
          </div>
        )}

        {/* Result count */}
        <p className="text-[11px]" style={{ color: MUTED }}>
          {filtered.length} of {traces.length} traces
        </p>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto py-2 px-3 space-y-1">
        {filtered.length === 0 && (
          <div className="flex items-center justify-center h-32 text-sm" style={{ color: MUTED }}>
            No traces match your filters
          </div>
        )}
        {filtered.map(trace => {
          const toolName = trace.tool_call?.tool_name || 'unknown'
          const summary  = traceSummary(trace)
          const hasError = !!trace.observation?.error
          const dur      = trace.observation?.duration_ms
          const isActive = selectedTrace === trace.trace_id
          const isNew    = newIds.current.has(trace.trace_id)

          return (
            <div
              key={trace.trace_id}
              onClick={() => onSelectTrace(trace.trace_id)}
              className="rounded-lg border p-3 cursor-pointer transition-colors"
              style={{
                borderColor: isActive ? 'hsl(38 20% 46% / 0.5)' : BORDER,
                background: isActive ? 'hsl(38 20% 46% / 0.06)' : '#fff',
                animation: isNew ? 'trace-slide-in 0.4s ease-out, trace-glow 1.2s ease-out' : undefined,
              }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 space-y-0.5">
                  <p className="text-sm font-medium truncate" style={{ color: TEXT }}>
                    <Highlight text={summary} query={search} />
                  </p>
                  <p className="text-[11px] truncate" style={{ color: MUTED }}>
                    <Highlight text={toolName} query={search} />
                  </p>
                  <p className="text-[10px]" style={{ color: 'hsl(30 8% 62%)' }}>
                    <button
                      className="hover:underline"
                      onClick={e => { e.stopPropagation(); onSelectAgent(trace.agent_id) }}
                    >
                      {trace.agent_id.substring(0, 8)}…
                    </button>
                    {' · '}{formatDate(trace.timestamp)}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  {hasError
                    ? <AlertCircle className="h-3.5 w-3.5" style={{ color: 'hsl(0 18% 50%)' }} />
                    : <CheckCircle className="h-3.5 w-3.5" style={{ color: 'hsl(150 18% 44%)' }} />
                  }
                  {dur !== undefined && (
                    <span className="text-[10px] flex items-center gap-0.5" style={{ color: MUTED }}>
                      <Clock className="h-2.5 w-2.5" />
                      {dur < 1 ? '<1ms' : `${Math.round(dur)}ms`}
                    </span>
                  )}
                </div>
              </div>
              {hasError && (
                <p className="text-[11px] mt-1.5 truncate" style={{ color: 'hsl(0 18% 50%)' }}>
                  {trace.observation.error}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}
