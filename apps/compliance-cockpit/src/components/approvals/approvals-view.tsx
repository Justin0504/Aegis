'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { CheckCircle, XCircle, Clock } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import { friendlyAgent } from '@/lib/friendly-names'
import { traceSummary } from '@/lib/trace-summary'
import { ToolIcon } from '@/lib/tool-icons'
import { PendingChecks } from './pending-checks'
import { USE_MOCK, mockTraces } from '@/lib/mock-traces'

const BORDER  = 'hsl(var(--border))'
const MUTED   = 'hsl(var(--muted-foreground))'
const TEXT    = 'hsl(var(--foreground))'

export function ApprovalsView() {
  const queryClient = useQueryClient()
  const [deciding, setDeciding] = useState<Record<string, 'approving' | 'rejecting'>>({})
  const [filter, setFilter] = useState<'pending' | 'APPROVED' | 'REJECTED' | 'all'>('pending')

  // Always fetch all traces, filter client-side for accurate counts
  const { data: liveTraces = [], isLoading } = useQuery({
    enabled: !USE_MOCK,
    queryKey: ['approval-traces'],
    queryFn: async () => {
      const res = await fetch('/api/gateway/traces?limit=200')
      if (!res.ok) throw new Error('Failed')
      const data = await res.json()
      return data.traces || []
    },
    refetchInterval: 5000,
  })

  // Mock mode: sprinkle approval_status across the 15 classic traces
  // so the Pending / Approved / Rejected tabs all have real-looking content.
  const allTraces: any[] = USE_MOCK
    ? mockTraces().map((t: any, i: number) => ({
        ...t,
        approval_status:
          i % 5 === 0 ? 'APPROVED' :
          i % 5 === 1 ? 'REJECTED' :
          i % 5 === 2 ? null       :  // pending
          'APPROVED',
      }))
    : liveTraces

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
      </div>

      {/* Blocking mode — real-time pending checks (PRIMARY) */}
      <div className="rounded-xl border p-5" style={{ borderColor: 'hsl(var(--border))', background: 'hsl(var(--card))' }}>
        <div className="flex items-center gap-2 mb-4">
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: 'hsl(var(--foreground))' }} />
          <span className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
            Awaiting Your Decision
          </span>
          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium uppercase tracking-wide" style={{ background: 'hsl(var(--secondary))', color: 'hsl(var(--secondary-foreground))' }}>
            Blocking mode
          </span>
          <span className="text-[11px] ml-auto" style={{ color: 'hsl(var(--muted-foreground))' }}>
            Agents are paused until you decide
          </span>
        </div>
        <PendingChecks />
      </div>

      {/* Trace-level audit log */}
      <div>
        <p className="text-sm font-semibold mb-3" style={{ color: TEXT }}>Review queue</p>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm" style={{ borderColor: 'hsl(var(--border))', background: 'hsl(var(--card))' }}>
            <Clock className="h-3.5 w-3.5" style={{ color: 'hsl(var(--muted-foreground))' }} />
            <span style={{ color: 'hsl(var(--foreground))' }}><b>{pending.length}</b> unreviewed</span>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm" style={{ borderColor: 'hsl(var(--border))', background: 'hsl(var(--card))' }}>
            <CheckCircle className="h-3.5 w-3.5" style={{ color: 'hsl(var(--status-ok))' }} />
            <span style={{ color: 'hsl(var(--foreground))' }}><b>{approved.length}</b> approved</span>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm" style={{ borderColor: 'hsl(var(--border))', background: 'hsl(var(--card))' }}>
            <XCircle className="h-3.5 w-3.5" style={{ color: 'hsl(var(--status-drift))' }} />
            <span style={{ color: 'hsl(var(--foreground))' }}><b>{rejected.length}</b> rejected</span>
          </div>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-1 p-1 rounded-lg w-fit" style={{ background: 'hsl(var(--secondary))' }}>
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
                background: active ? 'hsl(var(--card))' : 'transparent',
                color: active ? TEXT : MUTED,
                boxShadow: active ? '0 1px 3px hsl(0 0% 0% / 0.10)' : 'none',
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
                background: active ? 'hsl(var(--foreground) / 0.08)' : 'hsl(var(--border))',
                color: active ? TEXT : MUTED,
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
            <div key={i} className="h-20 rounded-lg animate-pulse" style={{ background: 'hsl(var(--secondary))' }} />
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
            const status    = trace.approval_status
            const isPending = !status
            const isApproved = status === 'APPROVED'
            const prompt    = String(trace.input_context?.prompt || '').slice(0, 80)
            const loading   = deciding[trace.trace_id]
            const dotColor = isPending ? 'hsl(var(--status-attn))' : isApproved ? 'hsl(var(--status-ok))' : 'hsl(var(--status-drift))'

            return (
              <div
                key={trace.trace_id}
                className="rounded-lg border p-4"
                style={{
                  borderColor: 'hsl(var(--border))',
                  background: 'hsl(var(--card))',
                }}
              >
                <div className="flex items-start justify-between gap-4">
                  {/* Left: tool + info */}
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="flex flex-col items-center gap-1.5 flex-shrink-0 mt-0.5">
                      <ToolIcon name={toolName} size={26} />
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ background: dotColor }}
                        aria-label={isPending ? 'unreviewed' : status}
                      />
                    </div>
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold" style={{ color: TEXT }}>
                          {friendlyAgent(trace.agent_id)}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide border" style={{
                          background: 'transparent',
                          borderColor: 'hsl(var(--border))',
                          color: isPending ? 'hsl(var(--status-attn))' : isApproved ? 'hsl(var(--status-ok))' : 'hsl(var(--status-drift))',
                        }}>
                          {isPending ? 'Unreviewed' : status}
                        </span>
                      </div>
                      <p className="text-xs truncate" style={{ color: TEXT }}>
                        {traceSummary(trace) || toolName}
                      </p>
                      {prompt && <p className="text-[11px] truncate" style={{ color: MUTED }}>{prompt}</p>}
                      <p className="text-[10px]" style={{ color: MUTED }}>
                        {formatDate(trace.timestamp)}
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
                        style={{ borderColor: 'hsl(0 10% 82%)', color: 'hsl(0 14% 46%)', background: 'hsl(var(--card))' }}
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
