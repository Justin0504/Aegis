'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  Loader2, Download, RefreshCw, CheckCircle2, XCircle, Stamp,
  Calendar, ChevronDown, ChevronRight, ShieldAlert,
} from 'lucide-react'
import { gw } from '@/lib/gateway'
import { TierGate } from '@/components/pro-features/tier-gate'

const BORDER = 'hsl(var(--border))'
const MUTED  = 'hsl(var(--muted-foreground))'
const TEXT   = 'hsl(var(--foreground))'
const BG     = 'hsl(var(--card))'
const CODE_BG = 'hsl(var(--secondary))'
const ACCENT = 'hsl(var(--primary))'
const OK     = 'hsl(150 30% 40%)'
const OK_BG  = 'hsl(150 30% 92%)'
const BAD    = 'hsl(0 42% 40%)'
const BAD_BG = 'hsl(0 28% 92%)'
const MONO   = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'

interface Article {
  article: 'Art.12' | 'Art.13' | 'Art.14' | 'Art.15'
  title: string
  summary: string
  compliant: boolean
  evidence: Record<string, unknown>
  gaps: string[]
}

interface EuPack {
  meta: {
    version: string
    framework: string
    regulation: string
    generated_at: string
    org_id: string
    gateway_version: string
    reporting_window_days: number
    note: string
  }
  articles: Article[]
  compliant: boolean
  signature?: {
    algorithm: string
    key_id: string
    signature: string
    public_key_pem: string
  }
}

const WINDOW_OPTIONS = [30, 60, 90, 180, 365] as const

export function EuAiActView() {
  const [loading, setLoading] = useState(false)
  const [windowDays, setWindowDays] = useState<number>(90)
  const [pack, setPack] = useState<EuPack | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['Art.12', 'Art.13', 'Art.14', 'Art.15']))

  async function load(days: number) {
    setLoading(true)
    try {
      const res = await gw(`evidence-pack/eu-ai-act/export?window_days=${days}`)
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`)
      }
      const data = await res.json() as EuPack
      setPack(data)
    } catch (err) {
      toast.error(`Failed to load evidence pack: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load(windowDays) }, [])

  function download() {
    if (!pack) return
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const stamp = pack.meta.generated_at.replace(/[:.]/g, '-')
    a.href = url
    a.download = `aegis-eu-ai-act-${pack.meta.org_id}-${stamp}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  function toggle(art: string) {
    const next = new Set(expanded)
    if (next.has(art)) next.delete(art)
    else next.add(art)
    setExpanded(next)
  }

  const compliantCount = pack?.articles.filter((a) => a.compliant).length ?? 0
  const totalArticles  = pack?.articles.length ?? 4

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <TierGate
        requires="team"
        feature="EU AI Act evidence pack"
        description="Signed, article-by-article JSON export for Article 12-15 record-keeping, transparency, human oversight, and robustness controls. Auditor-ready. Available on Team tier and above."
      >
      <div className="mb-6">
        <h1 className="text-xl font-semibold" style={{ color: TEXT }}>
          EU AI Act · Article 12-15 Evidence Pack
        </h1>
        <p className="mt-1 text-sm" style={{ color: MUTED }}>
          Regulation (EU) 2024/1689 · high-risk-system obligations take effect{' '}
          <strong style={{ color: TEXT }}>2026-08-02</strong>. Each article carries
          concrete evidence from your gateway's audit surface and a compliance floor.
          Downloaded packs are Ed25519-signed for offline auditor verification.
        </p>
      </div>

      <div className="mb-4 flex items-center gap-3 p-3 rounded border"
           style={{ borderColor: BORDER, backgroundColor: BG }}>
        <Calendar className="h-4 w-4" style={{ color: MUTED }} />
        <label className="text-xs" style={{ color: MUTED }}>Reporting window:</label>
        <select value={windowDays}
          onChange={(e) => { const d = Number(e.target.value); setWindowDays(d); load(d); }}
          className="text-xs px-2 py-1 rounded border bg-transparent"
          style={{ borderColor: BORDER, color: TEXT }}>
          {WINDOW_OPTIONS.map((d) => (
            <option key={d} value={d}>{d} days</option>
          ))}
        </select>

        <div className="flex-1" />

        <button onClick={() => load(windowDays)} disabled={loading}
          className="text-xs px-2 py-1 rounded border"
          style={{ borderColor: BORDER, color: MUTED }}>
          {loading
            ? (<><Loader2 className="h-3 w-3 inline mr-1 animate-spin" /> Loading</>)
            : (<><RefreshCw className="h-3 w-3 inline mr-1" /> Refresh</>)}
        </button>
        <button onClick={download} disabled={!pack || loading}
          className="text-xs px-2 py-1 rounded font-medium"
          style={{ backgroundColor: ACCENT, color: 'white', opacity: (!pack || loading) ? 0.5 : 1 }}>
          <Download className="h-3 w-3 inline mr-1" /> Download signed pack
        </button>
      </div>

      {pack && (
        <>
          {/* Verdict banner */}
          <div className="mb-4 p-4 rounded border flex items-center gap-3"
               style={{
                 borderColor: pack.compliant ? OK : BAD,
                 backgroundColor: pack.compliant ? OK_BG : BAD_BG,
               }}>
            {pack.compliant
              ? <CheckCircle2 className="h-5 w-5" style={{ color: OK }} />
              : <XCircle      className="h-5 w-5" style={{ color: BAD }} />}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold" style={{ color: pack.compliant ? OK : BAD }}>
                {pack.compliant
                  ? `All ${totalArticles} articles have supporting evidence`
                  : `${compliantCount} of ${totalArticles} articles have supporting evidence`}
              </div>
              <div className="text-xs mt-0.5" style={{ color: MUTED }}>
                Compliance floor only — auditor determines whether the underlying evidence is <em>sufficient</em>.
              </div>
            </div>
            {pack.signature && (
              <div className="text-xs flex items-center gap-1 px-2 py-1 rounded"
                   style={{ backgroundColor: BG, color: MUTED, fontFamily: MONO }}>
                <Stamp className="h-3 w-3" />
                {pack.signature.algorithm} · {pack.signature.key_id.slice(0, 12)}…
              </div>
            )}
          </div>

          {/* Article cards */}
          <div className="space-y-3">
            {pack.articles.map((art) => {
              const isOpen = expanded.has(art.article)
              const style = art.compliant
                ? { fg: OK,  bg: OK_BG,  icon: CheckCircle2, label: 'Evidence present' }
                : { fg: BAD, bg: BAD_BG, icon: XCircle,       label: `${art.gaps.length} gap${art.gaps.length === 1 ? '' : 's'}` }
              const Icon = style.icon
              return (
                <div key={art.article} className="rounded border overflow-hidden"
                     style={{ borderColor: BORDER, backgroundColor: BG }}>
                  <button onClick={() => toggle(art.article)}
                    className="w-full p-4 text-left flex items-start gap-3 transition-colors">
                    {isOpen
                      ? <ChevronDown  className="h-4 w-4 mt-0.5 flex-shrink-0" style={{ color: MUTED }} />
                      : <ChevronRight className="h-4 w-4 mt-0.5 flex-shrink-0" style={{ color: MUTED }} />}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-sm font-medium" style={{ color: TEXT }}>
                          {art.article}
                        </span>
                        <span className="text-sm" style={{ color: TEXT }}>{art.title}</span>
                        <span className="ml-auto text-[10px] uppercase px-1.5 py-0.5 rounded font-medium flex items-center gap-1"
                          style={{ color: style.fg, backgroundColor: style.bg, letterSpacing: '0.05em' }}>
                          <Icon className="h-3 w-3" /> {style.label}
                        </span>
                      </div>
                      <p className="mt-1 text-xs" style={{ color: MUTED }}>{art.summary}</p>
                    </div>
                  </button>

                  {isOpen && (
                    <div className="border-t px-4 py-3 space-y-3"
                         style={{ borderColor: BORDER, backgroundColor: CODE_BG }}>
                      {art.gaps.length > 0 && (
                        <div className="rounded border p-2 flex gap-2 text-xs"
                             style={{ borderColor: BAD, backgroundColor: BAD_BG, color: BAD }}>
                          <ShieldAlert className="h-4 w-4 flex-shrink-0" />
                          <ul className="space-y-1">
                            {art.gaps.map((g, i) => <li key={i}>{g}</li>)}
                          </ul>
                        </div>
                      )}
                      <div>
                        <div className="text-[10px] uppercase mb-1 font-medium" style={{ color: MUTED, letterSpacing: '0.05em' }}>
                          Evidence
                        </div>
                        <pre className="text-xs p-2 rounded border overflow-x-auto"
                             style={{
                               borderColor: BORDER, backgroundColor: BG,
                               fontFamily: MONO, color: TEXT, whiteSpace: 'pre-wrap',
                             }}>
{JSON.stringify(art.evidence, null, 2)}
                        </pre>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Provenance footer */}
          <div className="mt-6 p-3 rounded border text-xs grid grid-cols-2 gap-3"
               style={{ borderColor: BORDER, backgroundColor: BG, color: MUTED, fontFamily: MONO }}>
            <div>
              <div style={{ color: TEXT }}>Generated</div>
              <div>{pack.meta.generated_at}</div>
            </div>
            <div>
              <div style={{ color: TEXT }}>Reporting window</div>
              <div>{pack.meta.reporting_window_days} days</div>
            </div>
            <div>
              <div style={{ color: TEXT }}>Org</div>
              <div>{pack.meta.org_id}</div>
            </div>
            <div>
              <div style={{ color: TEXT }}>Gateway version</div>
              <div>{pack.meta.gateway_version}</div>
            </div>
          </div>
        </>
      )}

      {!pack && !loading && (
        <div className="mt-8 flex items-center justify-center h-32 text-sm rounded border"
             style={{ color: MUTED, borderColor: BORDER, backgroundColor: BG }}>
          No pack loaded. Click Refresh to fetch the latest.
        </div>
      )}
      </TierGate>
    </div>
  )
}
