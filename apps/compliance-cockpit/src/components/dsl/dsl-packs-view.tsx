'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Loader2, ShieldCheck, ChevronDown, ChevronRight, FileText, Download, Check, AlertTriangle,
} from 'lucide-react'
import { gw } from '@/lib/gateway'

// Design tokens — same source as sibling views.
const BORDER = 'hsl(var(--border))'
const MUTED  = 'hsl(var(--muted-foreground))'
const TEXT   = 'hsl(var(--foreground))'
const BG     = 'hsl(var(--card))'
const CODE_BG = 'hsl(var(--secondary))'
const ACCENT = 'hsl(var(--primary))'
const OK     = 'hsl(150 30% 40%)'
const WARN   = 'hsl(36 45% 42%)'
const MONO   = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'

interface PackMeta {
  name: string
  description: string
  citation: string
  rule_count: number
}

interface PackFull extends PackMeta {
  dsl: {
    version: number
    rules: Array<{
      name: string
      when?: unknown
      then: { decision: 'allow' | 'pending' | 'block'; reason?: string; tags?: string[] }
    }>
  }
}

/** Preset packs live under BFSI / Healthcare / Government verticals.
 *  Vertical assignment is by pack-slug prefix; the gateway doesn't
 *  ship the vertical explicitly, so the cockpit groups client-side. */
function verticalOf(name: string): string {
  if (name.startsWith('bfsi-'))        return 'BFSI (Banking / Insurance)'
  if (name.startsWith('healthcare-'))  return 'Healthcare'
  if (name.startsWith('gov-'))         return 'Government / Public Sector'
  return 'Other'
}

const DECISION_STYLE: Record<'allow' | 'pending' | 'block',
  { fg: string; bg: string; label: string }> = {
  allow:   { fg: 'hsl(150 24% 32%)', bg: 'hsl(150 30% 92%)', label: 'allow'   },
  pending: { fg: 'hsl(36 28% 38%)',  bg: 'hsl(36 45% 90%)',  label: 'pending' },
  block:   { fg: 'hsl(0 42% 40%)',   bg: 'hsl(0 28% 92%)',   label: 'block'   },
}

export function DslPacksView() {
  const [loading, setLoading] = useState(true)
  const [packs, setPacks] = useState<PackMeta[]>([])
  const [full, setFull] = useState<Record<string, PackFull | undefined>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState<string | null>(null)

  // Confirm-before-apply model — clicking Apply on a pack opens a
  // small confirmation strip inline (rather than a modal). Prevents
  // an accidental double-click from merging 6 rules into prod DSL.
  const [confirming, setConfirming] = useState<string | null>(null)

  useEffect(() => {
    (async () => {
      try {
        const res = await gw('dsl/packs')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json() as { packs: PackMeta[] }
        setPacks(data.packs ?? [])
      } catch (err) {
        toast.error(`Failed to load packs: ${(err as Error).message}`)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  async function toggleExpand(name: string) {
    const next = new Set(expanded)
    if (next.has(name)) {
      next.delete(name)
      setExpanded(next)
      return
    }
    next.add(name)
    setExpanded(next)
    if (!full[name]) {
      try {
        const res = await gw(`dsl/packs/${name}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json() as PackFull
        setFull((prev) => ({ ...prev, [name]: data }))
      } catch (err) {
        toast.error(`Failed to load ${name}: ${(err as Error).message}`)
      }
    }
  }

  async function applyPack(name: string) {
    setApplying(name)
    try {
      const res = await gw(`dsl/packs/${name}/apply`, { method: 'POST' })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      const { added = 0, after = 0 } = (body.rule_count ?? {}) as { added?: number; after?: number }
      toast.success(
        added === 0
          ? `Pack ${name} already merged — no new rules added (tenant has ${after} rules)`
          : `Applied ${name} · +${added} rule${added === 1 ? '' : 's'} (tenant now has ${after})`,
      )
    } catch (err) {
      toast.error(`Apply failed: ${(err as Error).message}`)
    } finally {
      setApplying(null)
      setConfirming(null)
    }
  }

  const groups = useMemo(() => {
    const map = new Map<string, PackMeta[]>()
    for (const p of packs) {
      const v = verticalOf(p.name)
      const arr = map.get(v) ?? []
      arr.push(p)
      map.set(v, arr)
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [packs])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96 text-sm" style={{ color: MUTED }}>
        <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading policy packs…
      </div>
    )
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-semibold" style={{ color: TEXT }}>
          Compliance Policy Packs
        </h1>
        <p className="mt-1 text-sm" style={{ color: MUTED }}>
          One-click regulation-aligned DSL rule sets. Applying a pack MERGES its rules
          into your current tenant DSL — rules you have already customised (same name)
          are preserved.
        </p>
      </div>

      {groups.map(([vertical, list]) => (
        <div key={vertical} className="mb-8">
          <h2 className="text-xs font-semibold uppercase tracking-wide mb-3"
              style={{ color: MUTED, letterSpacing: '0.05em' }}>
            {vertical}
          </h2>
          <div className="space-y-3">
            {list.map((p) => {
              const isOpen = expanded.has(p.name)
              const isConfirming = confirming === p.name
              const isApplying = applying === p.name
              const detail = full[p.name]
              return (
                <div key={p.name}
                  className="rounded border overflow-hidden"
                  style={{ borderColor: BORDER, backgroundColor: BG }}>
                  <div className="p-4 flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4" style={{ color: ACCENT }} />
                        <span className="font-mono text-sm font-medium"
                              style={{ color: TEXT }}>
                          {p.name}
                        </span>
                        <span className="text-xs px-1.5 py-0.5 rounded"
                              style={{ color: MUTED, backgroundColor: CODE_BG, fontFamily: MONO }}>
                          {p.rule_count} rule{p.rule_count === 1 ? '' : 's'}
                        </span>
                      </div>
                      <p className="mt-2 text-sm" style={{ color: TEXT }}>
                        {p.description}
                      </p>
                      <p className="mt-2 text-xs" style={{ color: MUTED }}>
                        <FileText className="h-3 w-3 inline mr-1" />
                        {p.citation}
                      </p>
                    </div>
                    <div className="flex-shrink-0 flex items-center gap-2">
                      <button onClick={() => toggleExpand(p.name)}
                        className="text-xs px-2 py-1 rounded border transition-colors"
                        style={{ borderColor: BORDER, color: MUTED }}>
                        {isOpen ? (
                          <><ChevronDown className="h-3 w-3 inline mr-1" /> Hide rules</>
                        ) : (
                          <><ChevronRight className="h-3 w-3 inline mr-1" /> Preview rules</>
                        )}
                      </button>
                      {isConfirming ? (
                        <>
                          <button onClick={() => applyPack(p.name)}
                            disabled={isApplying}
                            className="text-xs px-2 py-1 rounded font-medium"
                            style={{ backgroundColor: OK, color: 'white' }}>
                            {isApplying
                              ? (<><Loader2 className="h-3 w-3 inline mr-1 animate-spin" /> Merging…</>)
                              : (<><Check className="h-3 w-3 inline mr-1" /> Confirm merge</>)}
                          </button>
                          <button onClick={() => setConfirming(null)}
                            disabled={isApplying}
                            className="text-xs px-2 py-1 rounded border"
                            style={{ borderColor: BORDER, color: MUTED }}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button onClick={() => setConfirming(p.name)}
                          className="text-xs px-2 py-1 rounded font-medium"
                          style={{ backgroundColor: ACCENT, color: 'white' }}>
                          <Download className="h-3 w-3 inline mr-1" /> Apply to tenant
                        </button>
                      )}
                    </div>
                  </div>

                  {isOpen && (
                    <div className="border-t p-4" style={{ borderColor: BORDER, backgroundColor: CODE_BG }}>
                      {!detail ? (
                        <div className="flex items-center text-xs" style={{ color: MUTED }}>
                          <Loader2 className="h-3 w-3 mr-2 animate-spin" /> Loading rules…
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {detail.dsl.rules.map((rule) => {
                            const style = DECISION_STYLE[rule.then.decision]
                            return (
                              <div key={rule.name}
                                className="p-2 rounded border"
                                style={{ backgroundColor: BG, borderColor: BORDER }}>
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-mono text-xs font-medium" style={{ color: TEXT }}>
                                    {rule.name}
                                  </span>
                                  <span className="text-[10px] uppercase px-1.5 py-0.5 rounded font-medium"
                                    style={{ color: style.fg, backgroundColor: style.bg, letterSpacing: '0.05em' }}>
                                    {style.label}
                                  </span>
                                  {rule.then.tags?.map((t) => (
                                    <span key={t} className="text-[10px] px-1.5 py-0.5 rounded"
                                      style={{ color: MUTED, backgroundColor: CODE_BG, fontFamily: MONO }}>
                                      #{t}
                                    </span>
                                  ))}
                                </div>
                                {rule.then.reason && (
                                  <p className="mt-1 text-xs" style={{ color: MUTED }}>
                                    {rule.then.reason}
                                  </p>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}

      <div className="mt-6 p-3 rounded border flex gap-2 text-xs"
           style={{ borderColor: BORDER, backgroundColor: CODE_BG, color: MUTED }}>
        <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" style={{ color: WARN }} />
        <div>
          <strong>Merge semantics:</strong> pack rules are APPENDED to your current tenant DSL.
          When a rule name in the pack matches a rule you have already customised, YOUR version
          is preserved — the pack never silently overwrites tenant edits. The 100-rule ceiling
          is enforced; overflow returns an error rather than dropping rules.
        </div>
      </div>
    </div>
  )
}
