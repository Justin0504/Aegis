'use client'

/**
 * Memory & Cross-Agent — Layer-5 detection surface.
 *
 * Wraps three event streams that AEGIS already extracts from traces
 * but didn't surface as a distinct page:
 *
 *  1. Unsafe memory recall — agent reads tainted memory + taint reaches
 *     a tool argument.
 *  2. Cross-agent contamination — undeclared data crossing between
 *     agents (shared memory / file / tool result / message).
 *  3. Pre-instruction PII — sensitive value appears in tool args
 *     before any user prompt references it.
 *
 * Roadmap item #5 from docs/RESEARCH-ROADMAP.md. Mirrors the
 * detection scope HiddenLayer markets as its 2026 "Memory & Context
 * Safety" layer — except AEGIS has the trace plumbing to render it
 * for free.
 */

import { useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import {
  Brain, Users, EyeOff, AlertTriangle, Shield, ArrowRight,
} from 'lucide-react'
import { ToolIcon } from '@/lib/tool-icons'
import { formatDate } from '@/lib/utils'
import {
  USE_MOCK,
  mockMemoryEvents,
  mockCrossAgentEvents,
  mockPreInstructionPii,
  type MemorySeverity,
} from '@/lib/mock-traces'

const TEXT   = 'hsl(var(--foreground))'
const MUTED  = 'hsl(var(--muted-foreground))'
const BORDER = 'hsl(var(--border))'

const SEV_FG: Record<MemorySeverity, string> = {
  critical: 'hsl(0   55% 36%)',
  high:     'hsl(20  45% 38%)',
  medium:   'hsl(38  45% 36%)',
  low:      'hsl(150 22% 38%)',
}
const SEV_BG: Record<MemorySeverity, string> = {
  critical: 'hsl(0   45% 95%)',
  high:     'hsl(20  45% 95%)',
  medium:   'hsl(38  45% 94%)',
  low:      'hsl(150 22% 94%)',
}

type Tab = 'memory' | 'crossagent' | 'pii'

export function MemoryView() {
  const [tab, setTab] = useState<Tab>('memory')

  const memEvents = USE_MOCK ? mockMemoryEvents() : []
  const xaEvents  = USE_MOCK ? mockCrossAgentEvents() : []
  const piiEvents = USE_MOCK ? mockPreInstructionPii() : []

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.02em]">Memory</h1>
          <p className="mt-1.5 text-[14.5px] max-w-[68ch]" style={{ color: MUTED }}>
            Tainted recall, undeclared agent-to-agent data crossings, and personal data that
            reaches a tool before any prompt mentioned it.
          </p>
        </div>
        <div className="flex gap-3 text-xs" style={{ color: MUTED }}>
          <Stat label="recall events" value={memEvents.length} />
          <Stat label="crossings"     value={xaEvents.length}  />
          <Stat label="pre-instr PII" value={piiEvents.length} />
        </div>
      </div>

      {/* Tab strip */}
      <div className="flex gap-1 border-b" style={{ borderColor: BORDER }}>
        <TabButton active={tab === 'memory'}     onClick={() => setTab('memory')}     icon={Brain}    label="Memory recall"          count={memEvents.length} />
        <TabButton active={tab === 'crossagent'} onClick={() => setTab('crossagent')} icon={Users}    label="Cross-agent contamination" count={xaEvents.length} />
        <TabButton active={tab === 'pii'}        onClick={() => setTab('pii')}        icon={EyeOff}   label="Pre-instruction PII"    count={piiEvents.length} />
      </div>

      {/* Tab body */}
      {tab === 'memory'     && <MemoryRecallList events={memEvents} />}
      {tab === 'crossagent' && <CrossAgentList   events={xaEvents}  />}
      {tab === 'pii'        && <PiiList          events={piiEvents} />}
    </div>
  )
}

// ─── Memory recall ────────────────────────────────────────────────

function MemoryRecallList({ events }: { events: ReturnType<typeof mockMemoryEvents> }) {
  if (events.length === 0) return <Empty kind="recall" />
  return (
    <div className="space-y-2">
      {events.map(e => (
        <EventCard key={e.id} severity={e.severity} time={e.timestamp}>
          <div className="flex items-start gap-3">
            <ToolIcon name={e.reached_tool ?? 'memory'} size={22} />
            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex items-center gap-2 text-xs" style={{ color: MUTED }}>
                <span className="font-mono">{e.agent_id}</span>
                <span>·</span>
                <span>recalled <span className="font-mono">{e.memory_key}</span></span>
                <span>·</span>
                <span>origin: <strong style={{ color: TEXT }}>{e.origin}</strong></span>
                {e.reached_tool && (
                  <>
                    <ArrowRight className="h-3 w-3" />
                    <span className="font-mono">{e.reached_tool}</span>
                  </>
                )}
              </div>
              <p className="text-sm" style={{ color: TEXT }}>{e.summary}</p>
              <Recommendation text={e.recommendation} />
            </div>
          </div>
        </EventCard>
      ))}
    </div>
  )
}

// ─── Cross-agent ──────────────────────────────────────────────────

function CrossAgentList({ events }: { events: ReturnType<typeof mockCrossAgentEvents> }) {
  if (events.length === 0) return <Empty kind="crossings" />
  return (
    <div className="space-y-2">
      {events.map(e => (
        <EventCard key={e.id} severity={e.severity} time={e.timestamp}>
          <div className="flex items-start gap-3">
            <Users className="h-5 w-5 flex-shrink-0 mt-0.5" style={{ color: SEV_FG[e.severity] }} />
            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex items-center gap-2 text-xs flex-wrap" style={{ color: MUTED }}>
                <span className="font-mono">{e.from_agent}</span>
                <ArrowRight className="h-3 w-3" />
                <span className="font-mono">{e.to_agent}</span>
                <span>·</span>
                <span>via <strong style={{ color: TEXT }}>{e.channel}</strong></span>
                <span>·</span>
                <span style={{ color: e.declared ? 'hsl(150 22% 40%)' : 'hsl(0 55% 38%)' }}>
                  {e.declared ? 'declared' : 'undeclared'}
                </span>
              </div>
              <p className="text-sm" style={{ color: TEXT }}>{e.summary}</p>
              <p className="text-xs" style={{ color: MUTED }}>{e.payload_summary}</p>
              <Recommendation text={e.recommendation} />
            </div>
          </div>
        </EventCard>
      ))}
    </div>
  )
}

// ─── Pre-instruction PII ──────────────────────────────────────────

function PiiList({ events }: { events: ReturnType<typeof mockPreInstructionPii> }) {
  if (events.length === 0) return <Empty kind="pii" />
  return (
    <div className="space-y-2">
      {events.map(e => (
        <EventCard key={e.id} severity={e.severity} time={e.timestamp}>
          <div className="flex items-start gap-3">
            <EyeOff className="h-5 w-5 flex-shrink-0 mt-0.5" style={{ color: SEV_FG[e.severity] }} />
            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex items-center gap-2 text-xs flex-wrap" style={{ color: MUTED }}>
                <span className="font-mono">{e.agent_id}</span>
                <span>·</span>
                <span>entity: <strong style={{ color: TEXT }}>{e.entity_type}</strong></span>
                <span>·</span>
                <span>tool: <span className="font-mono">{e.surfaced_in_tool}</span></span>
                <span>·</span>
                <span style={{ color: e.in_user_prompt ? 'hsl(150 22% 40%)' : 'hsl(0 55% 38%)' }}>
                  {e.in_user_prompt ? 'in prompt' : 'NOT in prompt'}
                </span>
              </div>
              <p className="text-sm" style={{ color: TEXT }}>{e.summary}</p>
              <Recommendation text={e.recommendation} />
            </div>
          </div>
        </EventCard>
      ))}
    </div>
  )
}

// ─── Shared building blocks ───────────────────────────────────────

function EventCard({ severity, time, children }: {
  severity: MemorySeverity; time: string; children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-lg border p-3.5 transition-colors"
      style={{ borderColor: BORDER, background: 'hsl(var(--card))' }}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <span
          className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded"
          style={{ background: SEV_BG[severity], color: SEV_FG[severity] }}
        >
          {severity}
        </span>
        <span className="text-[10px]" style={{ color: MUTED }}>{formatDate(time)}</span>
      </div>
      {children}
    </div>
  )
}

function Recommendation({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-1.5 mt-1">
      <Shield className="h-3 w-3 flex-shrink-0 mt-0.5" style={{ color: 'hsl(220 18% 50%)' }} />
      <p className="text-xs" style={{ color: 'hsl(220 18% 35%)' }}>{text}</p>
    </div>
  )
}

function TabButton({
  active, onClick, icon: Icon, label, count,
}: {
  active: boolean; onClick: () => void;
  icon: typeof Brain; label: string; count: number;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 px-3 py-2 text-sm transition-colors border-b-2 -mb-px"
      style={{
        borderColor: active ? TEXT : 'transparent',
        color:       active ? TEXT : MUTED,
        fontWeight:  active ? 600  : 400,
      }}
    >
      <Icon className="h-4 w-4" />
      <span>{label}</span>
      <span
        className="text-[10px] px-1.5 py-0.5 rounded"
        style={{ background: 'hsl(var(--secondary))', color: MUTED }}
      >{count}</span>
    </button>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="px-3 py-2 rounded border" style={{ borderColor: BORDER, background: 'hsl(var(--card))' }}>
      <div className="text-base font-semibold tabular-nums" style={{ color: TEXT }}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider" style={{ color: MUTED }}>{label}</div>
    </div>
  )
}

function Empty({ kind }: { kind: 'recall' | 'crossings' | 'pii' }) {
  const msg = kind === 'recall'
    ? 'No unsafe memory recalls in the last 24h. Tainted memory is quarantined before it reaches tools.'
    : kind === 'crossings'
      ? 'No undeclared cross-agent crossings in the last 24h.'
      : 'No pre-instruction PII detections in the last 24h.';
  return (
    <div className="flex flex-col items-center justify-center py-12 gap-2" style={{ color: MUTED }}>
      <Shield className="h-7 w-7 opacity-40" />
      <p className="text-sm">{msg}</p>
    </div>
  )
}
