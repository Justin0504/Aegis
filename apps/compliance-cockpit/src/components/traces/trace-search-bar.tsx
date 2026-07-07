'use client'

/**
 * TraceSearchBar — Datadog / Sentry-style DSL query bar for the traces
 * list. Wires up to POST /api/v1/traces/search (see
 * packages/gateway-mcp/src/services/trace-query-dsl.ts for the DSL
 * grammar).
 *
 * Behaviour:
 *   - When the input is empty, we hand back an empty query and the
 *     traces view falls back to the plain /traces list endpoint.
 *   - When populated, we call /search with the DSL string and hand
 *     back the results (or the compile error).
 *   - "Save" opens a small inline naming panel and POSTs to
 *     /saved-queries. Newly-saved queries show in the dropdown
 *     immediately.
 *   - Saved-queries dropdown lists everything visible to this org;
 *     clicking one loads its DSL into the bar and runs it.
 *
 * All state is local to this component — parent gets the search
 * result (or null when empty) via the `onResults` callback.
 */

import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Search, X, Save, Bookmark, AlertCircle, Loader2, Trash2 } from 'lucide-react'

const BORDER  = 'hsl(var(--border))'
const MUTED   = 'hsl(var(--muted-foreground))'
const TEXT    = 'hsl(var(--foreground))'
const CARD    = 'hsl(var(--card))'
const BG      = 'hsl(var(--background))'

interface SavedQuery {
  id: string
  name: string
  dsl: string
  created_at: string
  last_run_at: string | null
}

interface SearchResult {
  traces: any[]
  total: number
  took_ms: number
}

interface Props {
  /**
   * Called whenever the search state changes. `null` means "no active
   * query, fall back to the plain /traces list endpoint".
   */
  onResults: (result: SearchResult | null) => void
}

export function TraceSearchBar({ onResults }: Props) {
  const qc = useQueryClient()
  const [dsl, setDsl] = useState('')
  const [committedDsl, setCommittedDsl] = useState('')   // set on Enter or dropdown click
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [savedOpen, setSavedOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement | null>(null)

  // Close saved-queries dropdown on outside click — small manual
  // implementation rather than pulling in a Radix Popover.
  useEffect(() => {
    if (!savedOpen) return
    const onDown = (e: MouseEvent) => {
      if (!dropdownRef.current?.contains(e.target as Node)) setSavedOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [savedOpen])

  // The actual search request. Kept as a React Query so refetching +
  // caching + retries come for free.
  const { data, isFetching, error, refetch } = useQuery<SearchResult>({
    queryKey: ['traces-search', committedDsl],
    enabled:  Boolean(committedDsl),
    queryFn: async () => {
      const res = await fetch('/api/gateway/traces/search', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ q: committedDsl, limit: 200 }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `search failed: ${res.status}`)
      }
      return res.json()
    },
    // No refetch on window focus — a query bar is user-initiated;
    // silent background re-runs would flicker the results panel.
    refetchOnWindowFocus: false,
  })

  // Push results (or null) up to the parent every time the search
  // state changes. Using an effect rather than doing it inline in
  // queryFn keeps the parent's render decoupled from the fetch.
  useEffect(() => {
    if (!committedDsl) { onResults(null); return }
    if (data)          { onResults(data); return }
    // Loading / error — leave the previous state until we resolve
  }, [data, committedDsl, onResults])

  // Saved queries list. Not eagerly loaded — populated when the user
  // opens the dropdown (or after a successful save).
  const { data: savedQueries } = useQuery<{ saved_queries: SavedQuery[] }>({
    queryKey: ['saved-queries'],
    queryFn: async () => {
      const res = await fetch('/api/gateway/traces/saved-queries')
      if (!res.ok) throw new Error(`load saved queries: ${res.status}`)
      return res.json()
    },
    refetchOnWindowFocus: false,
  })

  // Commit a query — set committedDsl (which triggers the query) +
  // close any open panels.
  const runQuery = (q: string) => {
    setDsl(q)
    setCommittedDsl(q.trim())
    setSaveOpen(false)
    setSavedOpen(false)
  }

  const clearQuery = () => {
    setDsl('')
    setCommittedDsl('')
    setSaveOpen(false)
    onResults(null)
  }

  const submitSave = async () => {
    if (!saveName.trim() || !committedDsl) return
    const res = await fetch('/api/gateway/traces/saved-queries', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: saveName.trim(), dsl: committedDsl }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      alert(`Save failed: ${body.error ?? res.status}`)
      return
    }
    setSaveOpen(false)
    setSaveName('')
    qc.invalidateQueries({ queryKey: ['saved-queries'] })
  }

  const deleteSaved = async (id: string) => {
    if (!confirm('Delete this saved query?')) return
    const res = await fetch(`/api/gateway/traces/saved-queries/${id}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 204) {
      alert(`Delete failed: ${res.status}`)
      return
    }
    qc.invalidateQueries({ queryKey: ['saved-queries'] })
  }

  const errorMsg = error instanceof Error ? error.message : null

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {/* Query input */}
        <div className="flex-1 relative">
          <Search
            className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2"
            style={{ color: MUTED }}
          />
          <input
            type="text"
            value={dsl}
            onChange={(e) => setDsl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runQuery(dsl)
              if (e.key === 'Escape' && committedDsl) clearQuery()
            }}
            placeholder='agent:… AND risk:>MEDIUM AND @args.amount:>10000 — press Enter'
            spellCheck={false}
            className="w-full pl-9 pr-9 py-2 rounded-lg border text-sm font-mono"
            style={{ background: CARD, borderColor: BORDER, color: TEXT }}
          />
          {(dsl || committedDsl) && (
            <button
              onClick={clearQuery}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-black/5"
              style={{ color: MUTED }}
              title="Clear"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Save current query */}
        {committedDsl && !errorMsg && (
          <button
            onClick={() => { setSaveOpen((v) => !v); setSavedOpen(false) }}
            className="px-3 py-2 rounded-lg border text-sm inline-flex items-center gap-1.5"
            style={{ background: CARD, borderColor: BORDER, color: TEXT }}
            title="Save this query"
          >
            <Save className="h-4 w-4" /> Save
          </button>
        )}

        {/* Saved queries dropdown */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => { setSavedOpen((v) => !v); setSaveOpen(false) }}
            className="px-3 py-2 rounded-lg border text-sm inline-flex items-center gap-1.5"
            style={{ background: CARD, borderColor: BORDER, color: TEXT }}
            title="Saved queries"
          >
            <Bookmark className="h-4 w-4" />
            Saved {(savedQueries?.saved_queries?.length ?? 0) > 0 && (
              <span className="text-[10px]" style={{ color: MUTED }}>
                ({savedQueries!.saved_queries.length})
              </span>
            )}
          </button>
          {savedOpen && (
            <div
              className="absolute right-0 top-full mt-1 w-96 rounded-lg border shadow-lg z-10 max-h-80 overflow-y-auto"
              style={{ background: CARD, borderColor: BORDER }}
            >
              {savedQueries?.saved_queries?.length ? (
                <ul className="py-1">
                  {savedQueries.saved_queries.map((q) => (
                    <li key={q.id} className="flex items-center gap-2 px-3 py-2 hover:bg-black/[0.03]">
                      <button
                        onClick={() => runQuery(q.dsl)}
                        className="flex-1 min-w-0 text-left"
                      >
                        <div className="text-sm font-medium truncate" style={{ color: TEXT }}>{q.name}</div>
                        <div className="text-xs font-mono truncate" style={{ color: MUTED }}>{q.dsl}</div>
                      </button>
                      <button
                        onClick={() => deleteSaved(q.id)}
                        className="p-1 rounded hover:bg-black/5"
                        style={{ color: MUTED }}
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="px-3 py-4 text-sm text-center" style={{ color: MUTED }}>
                  No saved queries yet. Run a query and click Save.
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Save-name inline panel */}
      {saveOpen && (
        <div
          className="flex items-center gap-2 p-2.5 rounded-lg border"
          style={{ background: BG, borderColor: BORDER }}
        >
          <input
            autoFocus
            type="text"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitSave() }}
            placeholder="Name this query (e.g. high-cost-stripe)"
            className="flex-1 px-2 py-1.5 rounded-md border text-sm"
            style={{ background: CARD, borderColor: BORDER, color: TEXT }}
          />
          <button
            onClick={submitSave}
            disabled={!saveName.trim()}
            className="px-3 py-1.5 rounded-md text-sm font-medium disabled:opacity-40"
            style={{ background: TEXT, color: BG }}
          >
            Save
          </button>
          <button
            onClick={() => { setSaveOpen(false); setSaveName('') }}
            className="px-2 py-1.5 rounded-md text-sm"
            style={{ color: MUTED }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Status row: results / error / DSL cheat-sheet toggle */}
      <div className="flex items-center gap-3 text-xs" style={{ color: MUTED }}>
        {isFetching && committedDsl && (
          <span className="inline-flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" /> searching
          </span>
        )}
        {!isFetching && committedDsl && data && (
          <span>
            <b style={{ color: TEXT }}>{data.total}</b> match
            {data.total === 1 ? '' : 'es'} · {data.took_ms}ms
            {' · '}
            <button onClick={() => refetch()} className="underline">refresh</button>
          </span>
        )}
        {!committedDsl && (
          <span>
            Datadog-style query. Fields: <code style={{ color: TEXT }}>agent</code>,{' '}
            <code style={{ color: TEXT }}>tool</code>, <code style={{ color: TEXT }}>risk</code>,{' '}
            <code style={{ color: TEXT }}>status</code>, <code style={{ color: TEXT }}>@args.X</code>,
            free-text <code style={{ color: TEXT }}>"phrase"</code>. AND / OR / NOT / parens.
          </span>
        )}
      </div>

      {errorMsg && (
        <div
          className="p-2.5 rounded-lg border inline-flex items-start gap-2 text-sm"
          style={{ background: 'hsl(0 40% 96%)', borderColor: 'hsl(0 30% 80%)', color: 'hsl(0 45% 30%)' }}
        >
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}
    </div>
  )
}
