'use client'

/**
 * Global ⌘K / Ctrl+K command palette.
 *
 * One keyboard-driven jumpbox for every top-level surface in the
 * Cockpit — nav pages, registered agents, DSL policies, license
 * activation, sign-out. Same UX as Linear, Vercel, Notion, GitHub:
 * user hits ⌘K, types a word, presses Enter, arrives.
 *
 * ## Design intent
 *
 * - Zero visual chrome beyond the modal itself. No categories,
 *   no filters, no shortcuts hint bar. The filter IS the input;
 *   the list is a list. Keeps the "simple UI" invariant.
 * - Filter is subsequence-based (types → typescript matches "tst")
 *   not regex — same behaviour as VS Code's Cmd-P, which is what
 *   most operators have muscle memory for.
 * - Async data: agents come from /api/gateway/agents once when the
 *   palette first opens, cached until page reload. Zero network on
 *   subsequent opens.
 * - Escape closes; Enter fires; ↑/↓ moves; nothing else needed.
 *
 * Wired at the Providers boundary so it's available on every route.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  LayoutDashboard, FileText, CheckCircle, Undo2, AlertTriangle, UserRound,
  Shield, Layers, Brain, ClipboardList, FileCheck2, Settings, Sparkles,
  ScrollText, ShieldHalf, ScanLine, Compass, FlaskConical, LogOut,
  Zap, KeyRound, Search,
} from 'lucide-react'
import { gw } from '@/lib/gateway'

interface Command {
  id: string
  name: string
  hint?: string
  keywords?: string[]
  icon: typeof LayoutDashboard
  action: () => void | Promise<void>
}

const MUTED   = 'hsl(var(--muted-foreground))'
const TEXT    = 'hsl(var(--foreground))'
const BORDER  = 'hsl(var(--border))'
const SURFACE = 'hsl(var(--card))'
const HIGHLIGHT = 'hsl(var(--secondary))'

export function CommandPalette() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [agents, setAgents] = useState<Array<{ id: string; name?: string }>>([])
  const inputRef = useRef<HTMLInputElement>(null)

  // Toggle on ⌘K / Ctrl+K globally.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isMod = e.metaKey || e.ctrlKey
      if (isMod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      } else if (e.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // Focus + reset on open. Fetch agents lazily.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setCursor(0)
    setTimeout(() => inputRef.current?.focus(), 20)
    if (agents.length === 0) {
      gw('agents').then(r => r.ok ? r.json() : { items: [] })
        .then((d) => setAgents(d.items ?? d.agents ?? []))
        .catch(() => {})
    }
  }, [open, agents.length])

  const commands: Command[] = useMemo(() => {
    const nav: Command[] = [
      { id: 'nav:overview',   name: 'Overview',       icon: LayoutDashboard, action: () => router.push('/') },
      { id: 'nav:activity',   name: 'Activity',       hint: 'traces',    icon: FileText,      action: () => router.push('/traces') },
      { id: 'nav:approvals',  name: 'Approvals',      hint: 'pending review', icon: CheckCircle, action: () => router.push('/approvals') },
      { id: 'nav:rollbacks',  name: 'Rollbacks',      icon: Undo2,          action: () => router.push('/rollbacks') },
      { id: 'nav:violations', name: 'Violations',     icon: AlertTriangle,  action: () => router.push('/violations') },
      { id: 'nav:agents',     name: 'Agents',         icon: UserRound,      action: () => router.push('/agents') },
      { id: 'nav:policies',   name: 'Policies',       hint: 'DSL rules',    icon: Shield,     action: () => router.push('/policies') },
      { id: 'nav:proxy',      name: 'Proxy setup',    hint: 'zero-code',    icon: Zap,        action: () => router.push('/proxy') },
      { id: 'nav:policy-packs', name: 'Policy Packs', hint: 'install',      icon: Shield,     action: () => router.push('/dsl/packs') },
      { id: 'nav:coverage',   name: 'Coverage',       icon: Layers,         action: () => router.push('/coverage') },
      { id: 'nav:memory',     name: 'Memory',         icon: Brain,          action: () => router.push('/memory') },
      { id: 'nav:audit',      name: 'Audit Log',      icon: ClipboardList,  action: () => router.push('/audit-log') },
      { id: 'nav:compliance', name: 'Compliance',     icon: FileCheck2,     action: () => router.push('/compliance') },
      { id: 'nav:dsl',        name: 'Policy DSL',     hint: 'editor',       icon: ScrollText, action: () => router.push('/dsl') },
      { id: 'nav:codeshield', name: 'Code Shield',    icon: ShieldHalf,     action: () => router.push('/code-shield') },
      { id: 'nav:scan',       name: 'Pre-Deploy Scan', icon: ScanLine,      action: () => router.push('/scan') },
      { id: 'nav:alignment',  name: 'Alignment',      icon: Compass,        action: () => router.push('/alignment') },
      { id: 'nav:playground', name: 'Playground',     icon: FlaskConical,   action: () => router.push('/playground') },
      { id: 'nav:welcome',    name: 'Welcome / Install SDK', icon: Sparkles, action: () => router.push('/welcome') },
      { id: 'nav:settings',   name: 'Settings',       icon: Settings,       action: () => router.push('/settings') },
    ]
    const actions: Command[] = [
      { id: 'act:activate', name: 'Activate license', hint: 'paste key', icon: KeyRound, action: () => router.push('/activate') },
      {
        id: 'act:signout', name: 'Sign out', icon: LogOut,
        action: async () => { await fetch('/api/auth/signout', { method: 'POST' }).catch(() => {}); window.location.href = '/' },
      },
    ]
    const agentCmds: Command[] = agents.slice(0, 30).map((a) => ({
      id: `agent:${a.id}`,
      name: a.name ?? a.id,
      hint: 'agent',
      keywords: [a.id],
      icon: UserRound,
      action: () => router.push(`/agents/${a.id}`),
    }))
    return [...nav, ...actions, ...agentCmds]
  }, [router, agents])

  const filtered = useMemo(() => filterAndScore(commands, query), [commands, query])
  const active = filtered[Math.min(cursor, filtered.length - 1)]

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (e.key === 'Enter' && active) {
      e.preventDefault()
      setOpen(false)
      Promise.resolve(active.action()).catch(() => {})
    }
  }

  if (!open) return null

  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        background: 'hsl(0 0% 0% / 0.35)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '15vh',
      }}
      role="dialog" aria-modal="true" aria-label="Command palette"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(560px, 92vw)',
          background: SURFACE,
          border: `1px solid ${BORDER}`,
          borderRadius: 12,
          boxShadow: '0 20px 60px hsl(0 0% 0% / 0.18)',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: `1px solid ${BORDER}` }}>
          <Search className="h-4 w-4" style={{ color: MUTED, flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setCursor(0) }}
            onKeyDown={onKeyDown}
            placeholder="Jump to a page, agent, or action…"
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              fontSize: 14, color: TEXT,
            }}
          />
          <kbd style={{
            fontSize: 10, fontFamily: 'var(--font-mono)', color: MUTED,
            padding: '2px 6px', border: `1px solid ${BORDER}`, borderRadius: 4,
          }}>esc</kbd>
        </div>
        <ul style={{ maxHeight: '55vh', overflowY: 'auto', padding: 6, listStyle: 'none', margin: 0 }}>
          {filtered.length === 0 && (
            <li style={{ padding: '18px', textAlign: 'center', color: MUTED, fontSize: 13 }}>
              No matches for "{query}"
            </li>
          )}
          {filtered.map((cmd, i) => {
            const Icon = cmd.icon
            const isActive = i === cursor
            return (
              <li
                key={cmd.id}
                onMouseMove={() => setCursor(i)}
                onClick={() => { setOpen(false); Promise.resolve(cmd.action()).catch(() => {}) }}
                style={{
                  padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 10,
                  background: isActive ? HIGHLIGHT : 'transparent',
                }}
              >
                <Icon className="h-4 w-4" style={{ color: MUTED, flexShrink: 0 }} />
                <span style={{ fontSize: 13, color: TEXT, flex: 1 }}>{cmd.name}</span>
                {cmd.hint && (
                  <span style={{ fontSize: 11, color: MUTED }}>{cmd.hint}</span>
                )}
              </li>
            )
          })}
        </ul>
        <div style={{
          padding: '8px 14px', borderTop: `1px solid ${BORDER}`,
          fontSize: 10, color: MUTED, display: 'flex', gap: 12,
        }}>
          <span><kbd style={kbdSt}>↑↓</kbd> navigate</span>
          <span><kbd style={kbdSt}>↵</kbd> select</span>
          <span style={{ marginLeft: 'auto' }}><kbd style={kbdSt}>⌘K</kbd> to toggle</span>
        </div>
      </div>
    </div>
  )
}

const kbdSt: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  padding: '1px 5px',
  border: `1px solid ${BORDER}`,
  borderRadius: 3,
  color: MUTED,
}

/**
 * VS-Code-Cmd-P-style scoring: subsequence match on name + keywords.
 * Empty query returns full list. Shorter items with earlier matches
 * rank higher.
 */
function filterAndScore(commands: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase()
  if (!q) return commands
  const results: Array<{ cmd: Command; score: number }> = []
  for (const cmd of commands) {
    const haystack = [cmd.name, cmd.hint ?? '', ...(cmd.keywords ?? [])]
      .join(' ').toLowerCase()
    const score = subsequenceScore(q, haystack)
    if (score !== null) results.push({ cmd, score })
  }
  results.sort((a, b) => a.score - b.score)
  return results.map(r => r.cmd)
}

function subsequenceScore(needle: string, haystack: string): number | null {
  let hi = 0
  let firstMatch = -1
  let gaps = 0
  for (let ni = 0; ni < needle.length; ni++) {
    const c = needle[ni]
    let found = -1
    for (; hi < haystack.length; hi++) {
      if (haystack[hi] === c) { found = hi; break }
    }
    if (found === -1) return null
    if (firstMatch === -1) firstMatch = found
    else gaps += found - hi
    hi = found + 1
  }
  // Lower is better: reward early matches + tight matches.
  return firstMatch * 2 + gaps
}
