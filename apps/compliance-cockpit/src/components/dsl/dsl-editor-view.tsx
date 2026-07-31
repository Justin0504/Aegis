'use client'

import { useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import { toast } from 'sonner'
import { Loader2, Save, FlaskConical, Trash2, FileCode, Sparkles } from 'lucide-react'
import { gw } from '@/lib/gateway'

// Monaco is heavy — load only on the client when the page mounts.
const MonacoEditor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full text-sm" style={{ color: MUTED }}>
      <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading editor…
    </div>
  ),
})

// Read from the shared design tokens defined in globals.css :root so the page
// automatically follows any palette update (currently the Claude-cream theme).
const BG = 'hsl(var(--background))'
const PANEL = 'hsl(var(--card))'
const BORDER = 'hsl(var(--border))'
const TEXT = 'hsl(var(--foreground))'
const MUTED = 'hsl(var(--muted-foreground))'
const ACCENT = 'hsl(var(--primary))'
const RED = 'hsl(var(--destructive))'
const GREEN = 'hsl(150 22% 38%)' // no green token in palette; component-local

interface DslExample {
  id: string
  name: string
  description: string
  dsl: unknown
}

const EMPTY_DSL = `version: 1
rules:
  - name: example-rule
    when:
      classifier.category: shell
    then:
      decision: block
      reason: "shell tools disabled"
`

const SAMPLE_CONTEXT = JSON.stringify(
  {
    classifier: { category: 'network', signals: ['content:network'] },
    anomaly: { score: 0.65, decision: 'flag' },
    policy: { passed: true, riskLevel: 'LOW', violations: [] },
    tool: { name: 'fetch_url', args: { url: 'https://example.com/api' } },
    agent: { id: 'agent-uuid-here' },
    tenant: { id: 'default', deploymentMode: 'standard' },
  },
  null,
  2,
)

function tryParseDsl(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, error: 'Empty document' }
  // Accept JSON directly
  if (trimmed.startsWith('{')) {
    try {
      return { ok: true, value: JSON.parse(trimmed) }
    } catch (e) {
      return { ok: false, error: `JSON parse error: ${(e as Error).message}` }
    }
  }
  // Otherwise treat as YAML — but we don't bundle a YAML parser, so we use a
  // minimal "is this likely YAML?" check and ask the user to use JSON for now.
  // Most enterprise users will edit JSON; a YAML mode lives behind a flag.
  return {
    ok: false,
    error: 'Use JSON format for now. (Tip: copy from the example.)',
  }
}

const DEFAULT_JSON = `{
  "version": 1,
  "rules": [
    {
      "name": "pending-high-anomaly",
      "when": { "anomaly.score": { ">": 0.7 } },
      "then": { "decision": "pending", "reason": "anomaly score above 0.7" }
    }
  ]
}
`

export function DslEditorView() {
  const [editorText, setEditorText] = useState<string>(DEFAULT_JSON)
  const [savedDsl, setSavedDsl] = useState<unknown>(null)
  const [examples, setExamples] = useState<DslExample[]>([])
  const [loadedExampleId, setLoadedExampleId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [dryRunCtx, setDryRunCtx] = useState<string>(SAMPLE_CONTEXT)
  const [dryRunResult, setDryRunResult] = useState<unknown>(null)

  // ── NL → DSL compile (Sparkles button) ───────────────────────────
  // Backend endpoint exists at POST /api/v1/dsl/compile-nl since
  // Phase 2; this UI just wires the flow. When no LLM adapter is
  // configured on the gateway, the server falls back to a heuristic
  // pattern-matcher — the UI shows which backend fired so the
  // operator knows whether they got the "good" or "cheap" version.
  const [nlModalOpen, setNlModalOpen] = useState(false)
  const [nlText, setNlText]           = useState('')
  const [nlCompiling, setNlCompiling] = useState(false)
  const [nlResult, setNlResult]       = useState<null | {
    compiled: any
    references?: { node_uuids?: string[]; binding_uuids?: string[] }
    explanation?: string
    backend?: 'llm' | 'heuristic'
    warnings?: string[]
  }>(null)

  async function handleCompileNL() {
    if (!nlText.trim()) return
    setNlCompiling(true)
    setNlResult(null)
    try {
      const res = await gw('dsl/compile-nl', {
        method: 'POST',
        body: JSON.stringify({ description: nlText.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        // 503 = compiler not configured on this gateway. Explain
        // the fix in-place instead of showing a raw HTTP error.
        if (res.status === 503) {
          throw new Error(
            'NL compiler not configured on this gateway. Set AEGIS_LOCAL_LLM_URL (Ollama/vLLM) or ANTHROPIC_API_KEY / OPENAI_API_KEY, then restart the gateway.',
          )
        }
        throw new Error(data?.error ?? `HTTP ${res.status}`)
      }
      setNlResult(data)
    } catch (e) {
      toast.error('Compile failed: ' + (e as Error).message)
    } finally {
      setNlCompiling(false)
    }
  }

  function acceptCompiled() {
    if (!nlResult?.compiled) return
    // Merge new rules into the current document (don't replace) so
    // operator can build up a policy incrementally.
    const currentParsed = tryParseDsl(editorText)
    const current: any = currentParsed.ok ? currentParsed.value : { version: 1, rules: [] }
    const newRules = nlResult.compiled.rules ?? []
    const existingNames = new Set((current.rules ?? []).map((r: any) => r.name))
    const additions = newRules.filter((r: any) => !existingNames.has(r.name))
    const merged = {
      version: 1,
      rules: [...(current.rules ?? []), ...additions],
    }
    setEditorText(JSON.stringify(merged, null, 2))
    setNlModalOpen(false)
    setNlText('')
    setNlResult(null)
    toast.success(
      additions.length === newRules.length
        ? `Added ${additions.length} rule${additions.length === 1 ? '' : 's'} — review and click Save`
        : `Added ${additions.length} new rule(s); ${newRules.length - additions.length} skipped (name collision — your existing rule wins)`,
    )
  }

  useEffect(() => {
    (async () => {
      try {
        const [dslRes, exRes] = await Promise.all([gw('dsl'), gw('dsl/examples')])
        if (dslRes.ok) {
          const data = await dslRes.json()
          if (data?.dsl) {
            setSavedDsl(data.dsl)
            setEditorText(JSON.stringify(data.dsl, null, 2))
          }
        }
        if (exRes.ok) {
          const data = await exRes.json()
          if (Array.isArray(data.examples)) setExamples(data.examples)
        }
      } catch (e) {
        toast.error('Failed to load DSL: ' + (e as Error).message)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const parsed = useMemo(() => tryParseDsl(editorText), [editorText])
  const isDirty =
    parsed.ok && JSON.stringify(parsed.value) !== JSON.stringify(savedDsl)

  async function handleSave() {
    if (!parsed.ok) {
      toast.error(parsed.error)
      return
    }
    setSaving(true)
    try {
      const res = await gw('dsl', {
        method: 'PUT',
        body: JSON.stringify(parsed.value),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      setSavedDsl(data.dsl)
      toast.success('DSL saved. Live for new tool calls.')
    } catch (e) {
      toast.error('Save failed: ' + (e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!confirm('Delete the current DSL? Tool calls will fall back to default policies.')) return
    setSaving(true)
    try {
      const res = await gw('dsl', { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      setSavedDsl(null)
      setEditorText(DEFAULT_JSON)
      toast.success('DSL removed.')
    } catch (e) {
      toast.error('Delete failed: ' + (e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDryRun() {
    if (!parsed.ok) {
      toast.error(parsed.error)
      return
    }
    let ctx: unknown
    try {
      ctx = JSON.parse(dryRunCtx)
    } catch (e) {
      toast.error('Sample context is not valid JSON')
      return
    }
    try {
      const res = await gw('dsl/dry-run', {
        method: 'POST',
        body: JSON.stringify({ dsl: parsed.value, context: ctx }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      setDryRunResult(data.match ?? null)
    } catch (e) {
      toast.error('Dry-run failed: ' + (e as Error).message)
    }
  }

  function loadExample(id: string) {
    const ex = examples.find((e) => e.id === id)
    if (!ex) return
    setEditorText(JSON.stringify(ex.dsl, null, 2))
    setLoadedExampleId(id)
    toast.info(`Loaded "${ex.name}" — review then Save to apply.`)
  }

  // Examples are grouped by the dominant signal they exercise so the
  // dropdown is browsable. Heuristic: scan the rule conditions for the
  // first known signal prefix (alignment.*, code_shield.*, anomaly.*, etc.)
  // and bucket by that. Falls back to "general" if nothing matches.
  const groupedExamples = useMemo(() => {
    const buckets: Record<string, DslExample[]> = {
      'Agent alignment': [],
      'Code Shield':     [],
      'Behavioral anomaly': [],
      'Classifier / tool': [],
      'Tenant mode':     [],
      'Other':           [],
    }
    for (const ex of examples) {
      const serialized = JSON.stringify(ex.dsl)
      if (serialized.includes('alignment.')) buckets['Agent alignment'].push(ex)
      else if (serialized.includes('code_shield.')) buckets['Code Shield'].push(ex)
      else if (serialized.includes('anomaly.')) buckets['Behavioral anomaly'].push(ex)
      else if (serialized.includes('tenant.')) buckets['Tenant mode'].push(ex)
      else if (serialized.includes('classifier.') || serialized.includes('tool.')) buckets['Classifier / tool'].push(ex)
      else buckets['Other'].push(ex)
    }
    return Object.entries(buckets).filter(([, list]) => list.length > 0)
  }, [examples])

  const loadedExample = useMemo(
    () => examples.find((e) => e.id === loadedExampleId) ?? null,
    [examples, loadedExampleId],
  )

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: TEXT }}>
            Policy DSL
          </h1>
          <p className="text-sm mt-1" style={{ color: MUTED }}>
            Custom rules. Can tighten — never loosen — the defaults.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            onChange={(e) => {
              if (e.target.value) loadExample(e.target.value)
            }}
            value={loadedExampleId ?? ''}
            className="text-sm px-3 py-1.5 rounded-md border"
            style={{ background: PANEL, borderColor: BORDER, color: TEXT }}
            title="Load a built-in DSL example"
          >
            <option value="" disabled>
              Load example…
            </option>
            {groupedExamples.map(([group, list]) => (
              <optgroup key={group} label={group}>
                {list.map((ex) => (
                  <option key={ex.id} value={ex.id}>
                    {ex.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <button
            onClick={() => setNlModalOpen(true)}
            disabled={saving}
            className="text-sm px-3 py-1.5 rounded-md inline-flex items-center gap-1.5 disabled:opacity-40"
            style={{ background: 'hsl(36 45% 90%)', color: 'hsl(36 45% 25%)', border: '1px solid hsl(36 45% 65%)' }}
            title="Describe a rule in plain English — AEGIS compiles it to DSL"
          >
            <Sparkles className="h-3.5 w-3.5" /> Describe with AI
          </button>
          <button
            onClick={handleDelete}
            disabled={!savedDsl || saving}
            className="text-sm px-3 py-1.5 rounded-md border inline-flex items-center gap-1.5 disabled:opacity-40"
            style={{ background: PANEL, borderColor: BORDER, color: RED }}
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </button>
          <button
            onClick={handleSave}
            disabled={!parsed.ok || !isDirty || saving}
            className="text-sm px-3 py-1.5 rounded-md inline-flex items-center gap-1.5 disabled:opacity-40"
            style={{ background: ACCENT, color: 'white' }}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </button>
        </div>
      </div>

      {/* Status row */}
      <div
        className="flex items-center justify-between text-xs px-3 py-2 rounded-md border"
        style={{ background: PANEL, borderColor: BORDER, color: MUTED }}
      >
        <span className="inline-flex items-center gap-1.5">
          <FileCode className="h-3.5 w-3.5" />
          {loading
            ? 'Loading…'
            : savedDsl
              ? `Saved DSL: ${(savedDsl as any).rules?.length ?? 0} rule(s) live`
              : 'No DSL saved yet — the editor shows a starter; nothing applies until you click Save.'}
        </span>
        {isDirty && (
          <span style={{ color: ACCENT }}>● unsaved changes</span>
        )}
        {!parsed.ok && (
          <span style={{ color: RED }}>{parsed.error}</span>
        )}
      </div>

      {loadedExample && (
        <div
          className="text-xs rounded-md border px-3 py-2 leading-relaxed"
          style={{ background: PANEL, borderColor: BORDER, color: MUTED }}
        >
          <span style={{ color: TEXT, fontWeight: 500 }}>
            {loadedExample.name}
          </span>{' '}
          — {loadedExample.description}
        </div>
      )}

      {/* Editor + Side panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div
          className="lg:col-span-2 rounded-md border overflow-hidden"
          style={{ background: PANEL, borderColor: BORDER, minHeight: 480 }}
        >
          <MonacoEditor
            height="480px"
            language="json"
            theme="vs"
            value={editorText}
            onChange={(v) => setEditorText(v ?? '')}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              lineNumbers: 'on',
              tabSize: 2,
              wordWrap: 'on',
              automaticLayout: true,
              scrollBeyondLastLine: false,
            }}
          />
        </div>

        <div className="space-y-3">
          {/* Dry-run */}
          <div
            className="rounded-md border p-3 space-y-2"
            style={{ background: PANEL, borderColor: BORDER }}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium inline-flex items-center gap-1.5" style={{ color: TEXT }}>
                <FlaskConical className="h-3.5 w-3.5" /> Dry-run
              </h3>
              <button
                onClick={handleDryRun}
                disabled={!parsed.ok}
                className="text-xs px-2 py-1 rounded border disabled:opacity-40"
                style={{ background: BG, borderColor: BORDER, color: TEXT }}
              >
                Run
              </button>
            </div>
            <p className="text-[11px]" style={{ color: MUTED }}>
              Evaluate current draft against a sample context — no save.
            </p>
            <textarea
              value={dryRunCtx}
              onChange={(e) => setDryRunCtx(e.target.value)}
              spellCheck={false}
              className="w-full text-[11px] font-mono px-2 py-2 rounded border"
              rows={10}
              style={{ background: BG, borderColor: BORDER, color: TEXT }}
            />
            <div
              className="text-xs px-2 py-2 rounded border min-h-[64px] font-mono whitespace-pre-wrap"
              style={{
                background: BG,
                borderColor: BORDER,
                color: dryRunResult ? TEXT : MUTED,
              }}
            >
              {dryRunResult
                ? JSON.stringify(dryRunResult, null, 2)
                : 'No match yet — click Run.'}
            </div>
          </div>

          {/* Semantics cheat-sheet */}
          <div
            className="rounded-md border p-3 text-[11px] space-y-1"
            style={{ background: PANEL, borderColor: BORDER, color: MUTED }}
          >
            <div style={{ color: TEXT }} className="font-medium mb-1">
              Decision merge
            </div>
            <div>
              <code>strictest</code>(AJV, anomaly, DSL) wins.
            </div>
            <div>
              Order: <code style={{ color: RED }}>block</code> &gt;{' '}
              <code style={{ color: ACCENT }}>pending</code> &gt;{' '}
              <code style={{ color: GREEN }}>allow</code>.
            </div>
            <div className="pt-1">
              DSL <code style={{ color: GREEN }}>allow</code> can never
              override an AJV/anomaly block.
            </div>
          </div>
        </div>
      </div>

      {/* ── NL → DSL compile modal ─────────────────────────────── */}
      {nlModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
             style={{ background: 'rgba(10, 10, 10, 0.4)' }}
             onClick={() => setNlModalOpen(false)}>
          <div className="rounded-xl border shadow-lg max-w-2xl w-full max-h-[85vh] overflow-auto"
               style={{ background: PANEL, borderColor: BORDER }}
               onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: BORDER }}>
              <div className="inline-flex items-center gap-2 font-semibold" style={{ color: TEXT }}>
                <Sparkles className="h-4 w-4" style={{ color: 'hsl(36 45% 40%)' }} />
                Describe a rule in plain English
              </div>
              <button onClick={() => setNlModalOpen(false)}
                className="text-sm px-2 py-1 rounded"
                style={{ color: MUTED }}>✕</button>
            </div>

            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: TEXT }}>
                  What should this rule do?
                </label>
                <textarea
                  value={nlText}
                  onChange={(e) => setNlText(e.target.value)}
                  placeholder="Example: Block stripe_refund tool calls over $10,000 unless it's the billing agent's node."
                  rows={4}
                  className="w-full p-2.5 text-sm rounded border font-mono"
                  style={{ background: 'hsl(var(--background))', borderColor: BORDER, color: TEXT }}
                  autoFocus
                />
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {[
                    'Block stripe_refund tool calls over $10,000.',
                    'Require approval for any send_email to an external domain.',
                    'Block any tool call whose arguments contain a raw credit card number.',
                    'Require approval for shell tool calls in production.',
                  ].map((preset) => (
                    <button key={preset} onClick={() => setNlText(preset)}
                      className="text-xs px-2 py-1 rounded border"
                      style={{ borderColor: BORDER, color: MUTED }}>
                      {preset.length > 45 ? preset.slice(0, 42) + '…' : preset}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button onClick={handleCompileNL}
                  disabled={!nlText.trim() || nlCompiling}
                  className="text-sm px-3 py-1.5 rounded font-medium inline-flex items-center gap-1.5 disabled:opacity-40"
                  style={{ background: ACCENT, color: 'white' }}>
                  {nlCompiling
                    ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Compiling…</>
                    : <><Sparkles className="h-3.5 w-3.5" /> Compile</>}
                </button>
                {nlResult?.backend && (
                  <span className="text-xs px-2 py-0.5 rounded"
                    style={{
                      background: nlResult.backend === 'llm' ? 'hsl(150 30% 92%)' : 'hsl(36 45% 92%)',
                      color:      nlResult.backend === 'llm' ? 'hsl(150 30% 32%)' : 'hsl(36 45% 32%)',
                    }}>
                    {nlResult.backend === 'llm' ? '✓ LLM compiled' : '↳ heuristic (no LLM configured)'}
                  </span>
                )}
              </div>

              {nlResult?.compiled && (
                <div className="space-y-2">
                  <div className="text-xs font-medium" style={{ color: TEXT }}>
                    Compiled DSL preview ({nlResult.compiled.rules?.length ?? 0} rule{nlResult.compiled.rules?.length === 1 ? '' : 's'})
                  </div>
                  <pre className="text-xs p-3 rounded border overflow-auto max-h-64"
                    style={{ background: 'hsl(var(--background))', borderColor: BORDER, color: TEXT, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                    <code>{JSON.stringify(nlResult.compiled, null, 2)}</code>
                  </pre>
                  {nlResult.explanation && (
                    <div className="text-xs p-2 rounded" style={{ background: 'hsl(var(--background))', color: MUTED }}>
                      <span style={{ color: TEXT, fontWeight: 500 }}>Explanation:</span> {nlResult.explanation}
                    </div>
                  )}
                  {nlResult.warnings && nlResult.warnings.length > 0 && (
                    <ul className="text-xs space-y-0.5" style={{ color: 'hsl(36 45% 40%)' }}>
                      {nlResult.warnings.map((w, i) => <li key={i}>⚠ {w}</li>)}
                    </ul>
                  )}
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t flex items-center justify-end gap-2" style={{ borderColor: BORDER }}>
              <button onClick={() => setNlModalOpen(false)}
                className="text-sm px-3 py-1.5 rounded border"
                style={{ borderColor: BORDER, color: MUTED }}>Cancel</button>
              <button onClick={acceptCompiled}
                disabled={!nlResult?.compiled}
                className="text-sm px-3 py-1.5 rounded font-medium disabled:opacity-40"
                style={{ background: GREEN, color: 'white' }}>
                Add to policy
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
