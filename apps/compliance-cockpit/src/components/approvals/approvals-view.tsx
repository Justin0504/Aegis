'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { CheckCircle, XCircle, Clock, Globe, FileText, Database, Send, Zap } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import { PendingChecks } from './pending-checks'

const BORDER  = 'hsl(36 12% 88%)'
const MUTED   = 'hsl(30 8% 55%)'
const TEXT    = 'hsl(30 10% 15%)'

const TOOL_ICONS: Record<string, React.ElementType> = {
  web_search:   Globe,
  read_file:    FileText,
  execute_sql:  Database,
  send_request: Send,
  send_report:  Send,
}
const TOOL_COLORS: Record<string, string> = {
  web_search:   'hsl(210 20% 48%)',
  read_file:    'hsl(255 18% 52%)',
  execute_sql:  'hsl(38 22% 48%)',
  send_request: 'hsl(150 18% 44%)',
  send_report:  'hsl(150 18% 44%)',
}

export function ApprovalsView() {
  const queryClient = useQueryClient()
  const [deciding, setDeciding] = useState<Record<string, 'approving' | 'rejecting'>>({})
  const [filter, setFilter] = useState<'pending' | 'APPROVED' | 'REJECTED' | 'all'>('pending')

  // Always fetch all traces, filter client-side for accurate counts
  const { data: allTraces = [], isLoading } = useQuery({
    queryKey: ['approval-traces'],
    queryFn: async () => {
      const res = await fetch('/api/gateway/traces?limit=200')
      if (!res.ok) throw new Error('Failed')
      const data = await res.json()
      return data.traces || []
    },
    refetchInterval: 5000,
  })

  const pending  = allTraces.filter((t: any) => !t.approval_status)
  const approved = allTraces.filter((t: any) => t.approval_status === 'APPROVED')
  const rejected = allTraces.filter((t: any) => t.approval_status === 'REJECTED')

  const traces =
    filter === 'pending'  ? pending  :
    filter === 'APPROVED' ? approved :
    filter === 'REJECTED' ? rejected :
    allTraces

  async function decide(traceId: string, action: 'APPROVED' | 'REJECTED') {
    setDeciding(prev => ({ ...prev, [traceId]: action === 'APPROVED' ? 'approving' : 'rejecting' }))
    try {
      await fetch(`/api/gateway/traces/${traceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approval_status: action, approved_by: 'dashboard-user' }),
      })
      queryClient.invalidateQueries({ queryKey: ['approval-traces'] })
      queryClient.invalidateQueries({ queryKey: ['traces'] })
    } finally {
      setDeciding(prev => { const n = { ...prev }; delete n[traceId]; return n })
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Approvals</h1>
        <p className="text-muted-foreground">Review and approve agent actions</p>
      </div>

      {/* Blocking mode — real-time pending checks */}
      <div style={{ border: `1px solid hsl(36 12% 88%)`, borderRadius: '12px', padding: '16px 20px', background: '#fff' }}>
        <div className="flex items-center gap-2 mb-4">
          <span className="text-sm font-semibold" style={{ color: 'hsl(30 10% 15%)' }}>
            Real-time Checks
          </span>
          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ background: 'hsl(0 10% 95%)', color: 'hsl(0 14% 44%)' }}>
            Blocking mode
          </span>
          <span className="text-xs ml-auto" style={{ color: 'hsl(30 8% 55%)' }}>
            Auto-refreshes every 3s
          </span>
        </div>
        <PendingChecks />
      </div>

      {/* Summary chips */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm" style={{ borderColor: 'hsl(36 14% 84%)', background: 'hsl(36 12% 97%)' }}>
          <Clock className="h-3.5 w-3.5" style={{ color: 'hsl(36 18% 46%)' }} />
          <span style={{ color: 'hsl(36 18% 38%)' }}><b>{pending.length}</b> pending</span>
        </div>
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm" style={{ borderColor: 'hsl(150 10% 82%)', background: 'hsl(150 10% 97%)' }}>
          <CheckCircle className="h-3.5 w-3.5" style={{ color: 'hsl(150 18% 40%)' }} />
          <span style={{ color: 'hsl(150 18% 34%)' }}><b>{approved.length}</b> approved</span>
        </div>
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm" style={{ borderColor: 'hsl(0 10% 85%)', background: 'hsl(0 10% 97%)' }}>
          <XCircle className="h-3.5 w-3.5" style={{ color: 'hsl(0 18% 50%)' }} />
          <span style={{ color: 'hsl(0 14% 44%)' }}><b>{rejected.length}</b> rejected</span>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-1 p-1 rounded-lg w-fit" style={{ background: 'hsl(36 14% 92%)' }}>
        {([
          { key: 'pending',  label: 'Pending',  count: pending.length  },
          { key: 'APPROVED', label: 'Approved', count: approved.length },
          { key: 'REJECTED', label: 'Rejected', count: rejected.length },
          { key: 'all',      label: 'All',      count: allTraces.length },
        ] as const).map(({ key, label, count }) => {
          const active = filter === key
          return (
            <button
              key={key}
              onClick={() => setFilter(key)}
              style={{
                padding: '6px 14px',
                borderRadius: '6px',
                fontSize: '13px',
                fontWeight: active ? 600 : 400,
                cursor: 'pointer',
                border: 'none',
                background: active ? '#ffffff' : 'transparent',
                color: active ? TEXT : MUTED,
                boxShadow: active ? '0 1px 3px hsl(36 12% 80% / 0.8)' : 'none',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              {label}
              <span style={{
                fontSize: '11px',
                fontWeight: 600,
                padding: '1px 5px',
                borderRadius: '4px',
                background: active ? 'hsl(38 20% 46% / 0.12)' : 'hsl(36 12% 88%)',
                color: active ? 'hsl(38 20% 42%)' : MUTED,
              }}>
                {count}
              </span>
            </button>
          )
        })}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-20 rounded-lg animate-pulse" style={{ background: 'hsl(36 14% 91%)' }} />
          ))}
        </div>
      ) : traces.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-16" style={{ color: MUTED }}>
          <CheckCircle className="h-8 w-8" style={{ color: 'hsl(150 18% 50%)' }} />
          <p className="text-sm">No items in this category</p>
        </div>
      ) : (
        <div className="space-y-2">
          {traces.map((trace: any) => {
            const toolName  = trace.tool_call?.tool_name || 'unknown'
            const Icon      = TOOL_ICONS[toolName] || Zap
            const color     = TOOL_COLORS[toolName] || MUTED
            const status    = trace.approval_status
            const isPending = !status
            const isApproved = status === 'APPROVED'
            const prompt    = String(trace.input_context?.prompt || '').slice(0, 80)
            const loading   = deciding[trace.trace_id]

            return (
              <div
                key={trace.trace_id}
                className="rounded-lg border p-4"
                style={{
                  borderColor: isPending ? 'hsl(36 14% 84%)' : isApproved ? 'hsl(150 10% 82%)' : 'hsl(0 10% 85%)',
                  background: isPending ? 'hsl(36 12% 98%)' : isApproved ? 'hsl(150 10% 97%)' : 'hsl(0 10% 98%)',
                }}
              >
                <div className="flex items-start justify-between gap-4">
                  {/* Left: tool + info */}
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="p-2 rounded-md flex-shrink-0 mt-0.5" style={{ background: `${color}15` }}>
                      <Icon className="h-4 w-4" style={{ color }} />
                    </div>
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold" style={{ color }}>{toolName}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{
                          background: isPending ? 'hsl(36 14% 90%)' : isApproved ? 'hsl(150 10% 90%)' : 'hsl(0 10% 90%)',
                          color:      isPending ? 'hsl(36 18% 40%)' : isApproved ? 'hsl(150 18% 36%)' : 'hsl(0 14% 44%)',
                        }}>
                          {isPending ? 'PENDING' : status}
                        </span>
                      </div>
                      {prompt && <p className="text-xs truncate" style={{ color: TEXT }}>{prompt}</p>}
                      <p className="text-[10px]" style={{ color: MUTED }}>
                        Agent {trace.agent_id?.substring(0, 8)}…
                        {' · '}{formatDate(trace.timestamp)}
                        {trace.approved_by && ` · by ${trace.approved_by}`}
                      </p>
                    </div>
                  </div>

                  {/* Right: action buttons (only for pending) */}
                  {isPending && (
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={() => decide(trace.trace_id, 'REJECTED')}
                        disabled={!!loading}
                        className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border font-medium transition-colors disabled:opacity-40"
                        style={{ borderColor: 'hsl(0 10% 82%)', color: 'hsl(0 14% 46%)', background: '#fff' }}
                      >
                        <XCircle className="h-3.5 w-3.5" />
                        {loading === 'rejecting' ? '…' : 'Reject'}
                      </button>
                      <button
                        onClick={() => decide(trace.trace_id, 'APPROVED')}
                        disabled={!!loading}
                        className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md font-medium transition-colors disabled:opacity-40"
                        style={{ background: 'hsl(150 14% 45% / 0.68)', color: '#fff', border: 'none' }}
                      >
                        <CheckCircle className="h-3.5 w-3.5" />
                        {loading === 'approving' ? '…' : 'Approve'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
