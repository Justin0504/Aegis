'use client'

/**
 * MCP tools pinned by the proxy: what each server offers, whether its
 * description has changed since it was approved, and whether it reads
 * like an instruction to the model. A changed or suspicious tool is
 * refused by the proxy until someone re-pins it here, having read both
 * texts.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Plug, ShieldCheck, ShieldAlert, ShieldX, ChevronDown } from 'lucide-react'
import { fmtWhen } from '@/lib/time'

const MUTED = 'hsl(var(--muted-foreground))'
const TEXT = 'hsl(var(--foreground))'
const BORDER = 'hsl(var(--border))'

const STATUS = {
  pinned:     { label: 'Pinned',     fg: 'hsl(152 58% 34%)', bg: 'hsl(152 60% 36% / 0.10)', Icon: ShieldCheck },
  changed:    { label: 'Changed',    fg: 'hsl(0 72% 42%)',   bg: 'hsl(0 72% 50% / 0.10)',   Icon: ShieldX },
  suspicious: { label: 'Suspicious', fg: 'hsl(32 95% 36%)',  bg: 'hsl(36 100% 50% / 0.13)', Icon: ShieldAlert },
} as const

function Row({ t, onRepin }: { t: any; onRepin: () => void }) {
  const [open, setOpen] = useState(t.status !== 'pinned')
  const st = STATUS[(t.status as keyof typeof STATUS) ?? 'pinned'] ?? STATUS.pinned
  const differs = t.status === 'changed' && t.pinned_description !== t.last_description
  return (
    <li className="border-t first:border-t-0" style={{ borderColor: BORDER }}>
      <div className="flex items-center gap-3 py-2.5">
        <button onClick={() => setOpen(o => !o)} className="flex items-center gap-3 min-w-0 flex-1 text-left">
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 transition-transform" style={{ color: MUTED, transform: open ? 'rotate(180deg)' : undefined }} />
          <span className="font-mono text-[13px] truncate" style={{ color: TEXT }}>{t.tool_name}</span>
          <span className="text-[11.5px] truncate" style={{ color: MUTED }}>{t.server_id}</span>
        </button>
        <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium flex-shrink-0" style={{ color: st.fg, background: st.bg }}>
          <st.Icon className="h-3 w-3" /> {st.label}
        </span>
        <span className="text-[11.5px] flex-shrink-0 w-20 text-right" style={{ color: MUTED }}>{fmtWhen(t.changed_at ?? t.last_seen_at)}</span>
        {t.status !== 'pinned' && (
          <button onClick={onRepin} className="text-[12px] font-medium px-2.5 h-7 rounded-full border flex-shrink-0 hover:bg-[hsl(var(--secondary))]" style={{ borderColor: BORDER, color: TEXT }}>
            Re-pin
          </button>
        )}
      </div>
      {open && (
        <div className="pb-3 pl-7 grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border p-3" style={{ borderColor: BORDER }}>
            <p className="text-[10.5px] font-semibold uppercase tracking-wider mb-1" style={{ color: MUTED }}>{differs ? 'Approved description' : 'Description'}</p>
            <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap" style={{ color: TEXT }}>{t.pinned_description || <em style={{ color: MUTED }}>none</em>}</p>
          </div>
          {differs && (
            <div className="rounded-lg border p-3" style={{ borderColor: 'hsl(0 72% 50% / 0.4)' }}>
              <p className="text-[10.5px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'hsl(0 72% 42%)' }}>What the server sends now</p>
              <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap" style={{ color: TEXT }}>{t.last_description}</p>
            </div>
          )}
          {t.status === 'suspicious' && (
            <p className="text-[12px] md:col-span-2" style={{ color: 'hsl(32 95% 36%)' }}>
              Reads like an instruction to the model: {(t.markers ?? []).join(', ')}.
            </p>
          )}
        </div>
      )}
    </li>
  )
}

export function McpToolsPanel() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['mcp-tools'],
    queryFn: async () => { const r = await fetch('/api/gateway/mcp/tools'); if (!r.ok) throw new Error('mcp'); return r.json() },
    refetchInterval: 15_000,
  })
  const tools: any[] = data?.tools ?? []
  async function repin(t: any) {
    await fetch('/api/gateway/mcp/tools/repin', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server_id: t.server_id, tool_name: t.tool_name }) })
    qc.invalidateQueries({ queryKey: ['mcp-tools'] })
  }
  if (isLoading) return <div className="h-16 rounded-lg animate-pulse" style={{ background: 'hsl(var(--secondary))' }} />
  if (!tools.length) {
    return (
      <div className="flex items-start gap-3 text-[13px]" style={{ color: MUTED }}>
        <Plug className="h-4 w-4 mt-0.5 flex-shrink-0" />
        <p>No MCP server has reported its tools yet. Wrap a server with <span className="font-mono">python -m agentguard.mcp_proxy --server …</span> and its tool descriptions are pinned here; a description that changes after approval, or that instructs the model, is refused until you re-pin it.</p>
      </div>
    )
  }
  const bad = tools.filter(t => t.status !== 'pinned')
  return (
    <div>
      <p className="text-[13px] mb-2" style={{ color: MUTED }}>
        {tools.length} tool{tools.length === 1 ? '' : 's'} from {data.servers} server{data.servers === 1 ? '' : 's'}, pinned by description and schema.
        {bad.length ? ` ${bad.length} refused until re-pinned.` : ' Nothing has changed since approval.'}
      </p>
      <ul>{[...bad, ...tools.filter(t => t.status === 'pinned')].map(t => <Row key={`${t.server_id}/${t.tool_name}`} t={t} onRepin={() => repin(t)} />)}</ul>
    </div>
  )
}
