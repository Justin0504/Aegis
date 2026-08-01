'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Copy, Loader2, Sparkles, ArrowRight, Cpu, ShieldOff, ShieldHalf, Compass } from 'lucide-react'
import { gw } from '@/lib/gateway'
import { BrandIcon } from '@/components/ui/brand-icon'

interface CandidateAgent {
  pid: number
  name: string
  cmdline: string
  cwd: string | null
  matched: string[]
  lang: 'Python' | 'JavaScript'
}

// Tauri exposes `window.__TAURI__.core.invoke('command_name', args?)`.
// Outside Tauri (plain browser), the property is undefined — we silently
// skip the scan and the section never renders.
function tauriInvoke<T>(name: string): Promise<T> | null {
  if (typeof window === 'undefined') return null
  const tauri = (window as any).__TAURI__
  if (!tauri?.core?.invoke) return null
  return tauri.core.invoke(name) as Promise<T>
}

const BORDER  = 'hsl(var(--border))'
const TEXT    = 'hsl(var(--foreground))'
const MUTED   = 'hsl(var(--muted-foreground))'
const SURFACE = 'hsl(var(--card))'
const BG      = 'hsl(var(--background))'
const PRIMARY = 'hsl(var(--primary))'
const ON_PRIM = 'hsl(var(--primary-foreground))'

interface Framework {
  id: string
  name: string
  lang: 'Python' | 'JavaScript' | 'Go'
  install: string
  snippet: string
}

const FRAMEWORKS: Framework[] = [
  {
    id: 'anthropic',
    name: 'Anthropic SDK',
    lang: 'Python',
    install: 'pip install agentguard-aegis anthropic',
    snippet: `import agentguard
agentguard.auto("http://localhost:8080", agent_id="my-agent")

import anthropic
client = anthropic.Anthropic()
# Your existing code — completely unchanged.`,
  },
  {
    id: 'openai',
    name: 'OpenAI SDK',
    lang: 'Python',
    install: 'pip install agentguard-aegis openai',
    snippet: `import agentguard
agentguard.auto("http://localhost:8080", agent_id="my-agent")

from openai import OpenAI
client = OpenAI()`,
  },
  {
    id: 'langchain',
    name: 'LangChain',
    lang: 'Python',
    install: 'pip install agentguard-aegis langchain',
    snippet: `import agentguard
agentguard.auto("http://localhost:8080", agent_id="my-agent")

# Any LangChain agent / tool call now flows through AEGIS.`,
  },
  {
    id: 'crewai',
    name: 'CrewAI',
    lang: 'Python',
    install: 'pip install agentguard-aegis crewai',
    snippet: `import agentguard
agentguard.auto("http://localhost:8080", agent_id="my-crew")

from crewai import Agent, Task, Crew`,
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    lang: 'Python',
    install: 'pip install agentguard-aegis google-generativeai',
    snippet: `import agentguard
agentguard.auto("http://localhost:8080", agent_id="my-agent")

import google.generativeai as genai`,
  },
  {
    id: 'bedrock',
    name: 'AWS Bedrock',
    lang: 'Python',
    install: 'pip install agentguard-aegis boto3',
    snippet: `import agentguard
agentguard.auto("http://localhost:8080", agent_id="my-agent")

import boto3
bedrock = boto3.client("bedrock-runtime")`,
  },
  {
    id: 'mistral',
    name: 'Mistral',
    lang: 'Python',
    install: 'pip install agentguard-aegis mistralai',
    snippet: `import agentguard
agentguard.auto("http://localhost:8080", agent_id="my-agent")

from mistralai import Mistral
client = Mistral(api_key=...)`,
  },
  {
    id: 'llamaindex',
    name: 'LlamaIndex',
    lang: 'Python',
    install: 'pip install agentguard-aegis llama-index',
    snippet: `import agentguard
agentguard.auto("http://localhost:8080", agent_id="my-agent")

from llama_index.core.agent import ReActAgent`,
  },
  {
    id: 'smolagents',
    name: 'smolagents',
    lang: 'Python',
    install: 'pip install agentguard-aegis smolagents',
    snippet: `import agentguard
agentguard.auto("http://localhost:8080", agent_id="my-agent")

from smolagents import ToolCallingAgent`,
  },
  {
    id: 'anthropic-js',
    name: 'Anthropic (JS)',
    lang: 'JavaScript',
    install: 'npm install @justinnn/agentguard @anthropic-ai/sdk',
    snippet: `import agentguard from '@justinnn/agentguard'
agentguard.auto('http://localhost:8080', { agentId: 'my-agent' })

import Anthropic from '@anthropic-ai/sdk'
const client = new Anthropic()`,
  },
  {
    id: 'openai-js',
    name: 'OpenAI (JS)',
    lang: 'JavaScript',
    install: 'npm install @justinnn/agentguard openai',
    snippet: `import agentguard from '@justinnn/agentguard'
agentguard.auto('http://localhost:8080', { agentId: 'my-agent' })

import OpenAI from 'openai'
const client = new OpenAI()`,
  },
  {
    id: 'vercel-ai',
    name: 'Vercel AI SDK',
    lang: 'JavaScript',
    install: 'npm install @justinnn/agentguard ai',
    snippet: `import agentguard from '@justinnn/agentguard'
agentguard.auto('http://localhost:8080', { agentId: 'my-agent' })

import { generateText } from 'ai'`,
  },
  {
    id: 'mastra',
    name: 'Mastra',
    lang: 'JavaScript',
    install: 'npm install @justinnn/agentguard @mastra/core',
    snippet: `import agentguard from '@justinnn/agentguard'
agentguard.auto('http://localhost:8080', { agentId: 'my-agent' })

import { Agent } from '@mastra/core/agent'`,
  },
  {
    id: 'go',
    name: 'Go SDK',
    lang: 'Go',
    install: 'go get github.com/Justin0504/Aegis/packages/sdk-go',
    snippet: `import "github.com/Justin0504/Aegis/packages/sdk-go/agentguard"

func main() {
    agentguard.Auto("http://localhost:8080", "my-agent")
    // your code
}`,
  },
]

const LANGS: Array<Framework['lang'] | 'All'> = ['All', 'Python', 'JavaScript', 'Go']

export function WelcomeView() {
  const router = useRouter()
  const [filter, setFilter] = useState<Framework['lang'] | 'All'>('All')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [traceCount, setTraceCount] = useState<number | null>(null)
  const [polling, setPolling] = useState(true)
  const [candidates, setCandidates] = useState<CandidateAgent[] | null>(null)
  const [expandedPid, setExpandedPid] = useState<number | null>(null)
  const [highlightPid, setHighlightPid] = useState<number | null>(null)

  // Deep-link from the system tray. When the user clicks the AEGIS tray
  // icon and there's at least one unprotected agent, the Tauri shell
  // appends `?pid=<n>`. We pick that up, expand the matching card, and
  // scroll it into view. The highlight ring fades after 2s.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const raw = new URLSearchParams(window.location.search).get('pid')
    if (!raw) return
    const pid = Number(raw)
    if (!Number.isFinite(pid) || pid <= 0) return
    setExpandedPid(pid)
    setHighlightPid(pid)
    const t = setTimeout(() => setHighlightPid(null), 2_000)
    return () => clearTimeout(t)
  }, [])

  // Once candidates have loaded, scroll the highlighted PID into view.
  useEffect(() => {
    if (highlightPid === null || !candidates?.some((c) => c.pid === highlightPid)) return
    const el = document.getElementById(`candidate-${highlightPid}`)
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [highlightPid, candidates])

  // Tauri-only: scan the host for agent-shaped processes that aren't yet
  // protected. Re-run every 5s so newly-launched agents show up.
  useEffect(() => {
    const invoke = tauriInvoke<CandidateAgent[]>('list_candidate_agents')
    if (!invoke) return // not running inside Tauri
    let cancelled = false
    const tick = () => {
      tauriInvoke<CandidateAgent[]>('list_candidate_agents')
        ?.then((rows) => {
          if (!cancelled) setCandidates(rows)
        })
        .catch(() => {})
    }
    tick()
    const t = setInterval(tick, 5000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  // Poll for the first trace. Only auto-redirect on the *transition*
  // from zero → first trace within this session — returning users who
  // already have traces should be allowed to browse /welcome (SDK
  // snippets, process scanner) without being yanked away every time
  // a new trace lands. We arm the redirect only when the very first
  // poll finds zero traces; if it's already non-zero, this is a repeat
  // visit and we just stop polling silently.
  useEffect(() => {
    if (!polling) return
    let cancelled = false
    let baselineWasZero: boolean | null = null
    const tick = async () => {
      try {
        const res = await gw('stats')
        if (!res.ok) return
        const stats = await res.json()
        const n = stats?.totals?.traces ?? stats?.total_traces ?? 0
        if (cancelled) return
        setTraceCount(n)
        if (baselineWasZero === null) {
          baselineWasZero = n === 0
          if (!baselineWasZero) {
            // Returning user — don't trigger the celebration redirect.
            setPolling(false)
            return
          }
        }
        if (n > 0 && baselineWasZero) {
          setPolling(false)
          setTimeout(() => router.push('/'), 1200)
        }
      } catch {
        /* gateway down — just keep polling */
      }
    }
    tick()
    const t = setInterval(tick, 2500)
    return () => { cancelled = true; clearInterval(t) }
  }, [polling, router])

  const visible = useMemo(
    () => (filter === 'All' ? FRAMEWORKS : FRAMEWORKS.filter((f) => f.lang === filter)),
    [filter],
  )

  function copy(id: string, text: string) {
    navigator.clipboard.writeText(text).catch(() => {})
    setCopiedId(id)
    setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500)
  }

  return (
    <div className="space-y-8">
      {/* Hero */}
      <header className="space-y-3">
        <p className="text-xs uppercase tracking-widest" style={{ color: MUTED }}>
          <Sparkles className="inline h-3 w-3 mr-1.5 -mt-0.5" /> Welcome to AEGIS
        </p>
        <h1
          className="text-4xl md:text-5xl leading-tight"
          style={{
            fontFamily: 'var(--font-serif), ui-serif, Georgia, serif',
            color: TEXT,
            letterSpacing: '-0.012em',
          }}
        >
          One line of code. <em style={{ fontStyle: 'italic' }}>Zero changes</em> to your agent.
        </h1>
        <p className="text-base md:text-lg max-w-2xl" style={{ color: MUTED }}>
          Pick the framework you're using below. Drop the snippet in. AEGIS will
          start classifying, scoring, and recording every tool call your agent
          makes — and this page will redirect to the dashboard the second your
          first trace lands.
        </p>
      </header>

      {/* Live waiting indicator */}
      <div
        className="flex items-center gap-3 px-4 py-3 rounded-md text-sm"
        style={{ background: SURFACE, border: `1px solid ${BORDER}`, color: TEXT }}
      >
        {traceCount === null ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" style={{ color: MUTED }} />
            <span style={{ color: MUTED }}>Connecting to the local gateway…</span>
          </>
        ) : traceCount === 0 ? (
          <>
            <span className="relative inline-flex h-2.5 w-2.5">
              <span
                className="absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping"
                style={{ background: PRIMARY }}
              />
              <span
                className="relative inline-flex rounded-full h-2.5 w-2.5"
                style={{ background: PRIMARY }}
              />
            </span>
            <span>Waiting for your first trace… run any tool call with the SDK installed.</span>
          </>
        ) : (
          <>
            <Check className="h-4 w-4" style={{ color: PRIMARY }} />
            <span>
              Got your first trace ({traceCount} so far). Redirecting to the dashboard…
            </span>
            <ArrowRight className="h-4 w-4 ml-1" />
          </>
        )}
      </div>

      {/* Try the playgrounds — zero-setup, work before any SDK is wired up. */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <a
          href="/code-shield"
          className="rounded-md p-4 transition-colors group"
          style={{ background: SURFACE, border: `1px solid ${BORDER}` }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.borderColor = PRIMARY
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.borderColor = BORDER
          }}
        >
          <h3
            className="text-sm font-medium inline-flex items-center gap-2 mb-1"
            style={{ color: TEXT }}
          >
            <ShieldHalf className="h-4 w-4" /> Try Code Shield
            <ArrowRight className="h-3.5 w-3.5 opacity-60 group-hover:translate-x-0.5 transition-transform" />
          </h3>
          <p className="text-xs leading-relaxed" style={{ color: MUTED }}>
            Paste a snippet of agent-generated code. AEGIS runs 19 rules
            (eval, secrets, rm&nbsp;-rf, dangerous SQL…) in {'< 1 ms'}.
            No agent needed.
          </p>
        </a>
        <a
          href="/alignment"
          className="rounded-md p-4 transition-colors group"
          style={{ background: SURFACE, border: `1px solid ${BORDER}` }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.borderColor = PRIMARY
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.borderColor = BORDER
          }}
        >
          <h3
            className="text-sm font-medium inline-flex items-center gap-2 mb-1"
            style={{ color: TEXT }}
          >
            <Compass className="h-4 w-4" /> Try Alignment
            <ArrowRight className="h-3.5 w-3.5 opacity-60 group-hover:translate-x-0.5 transition-transform" />
          </h3>
          <p className="text-xs leading-relaxed" style={{ color: MUTED }}>
            Compose a goal + thought chain + tool call. The judge LLM
            scores it 0–1 and tags drift signals — same engine your SDK
            callbacks reach.
          </p>
        </a>
      </section>

      {/* Detected processes (Tauri only) ─────────────────────────────────── */}
      {candidates !== null && (
        <section
          className="rounded-md p-4"
          style={{ background: SURFACE, border: `1px solid ${BORDER}` }}
        >
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2
                className="text-lg font-medium inline-flex items-center gap-2"
                style={{ color: TEXT }}
              >
                <Cpu className="h-4 w-4" /> Detected on this machine
              </h2>
              <p className="text-xs mt-0.5" style={{ color: MUTED }}>
                Best-effort scan of running Python &amp; Node processes whose
                command line references an LLM/agent library and has{' '}
                <em>not</em> yet been routed through AEGIS.
              </p>
            </div>
            <span className="text-xs" style={{ color: MUTED }}>
              {candidates.length === 0 ? 'nothing to flag' : `${candidates.length} unprotected`}
            </span>
          </div>

          {candidates.length === 0 ? (
            <p className="text-xs italic" style={{ color: MUTED }}>
              No agent-shaped processes detected. (Start one with{' '}
              <code className="font-mono">anthropic</code> or{' '}
              <code className="font-mono">openai</code> imported and it'll
              show up here within 5&nbsp;s.)
            </p>
          ) : (
            <ul className="space-y-2">
              {candidates.map((c) => {
                const expanded = expandedPid === c.pid
                const highlighted = highlightPid === c.pid
                return (
                  <li
                    key={c.pid}
                    id={`candidate-${c.pid}`}
                    className="rounded p-3 transition-all"
                    style={{
                      background: BG,
                      border: `1px solid ${highlighted ? PRIMARY : BORDER}`,
                      boxShadow: highlighted ? `0 0 0 3px ${PRIMARY}33` : undefined,
                    }}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-sm">
                          <ShieldOff className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'hsl(0 50% 45%)' }} />
                          <span className="font-mono text-xs" style={{ color: MUTED }}>
                            PID {c.pid}
                          </span>
                          <span
                            className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
                            style={{ background: SURFACE, color: MUTED }}
                          >
                            {c.lang}
                          </span>
                          <span className="text-xs" style={{ color: TEXT }}>
                            uses {c.matched.slice(0, 3).join(', ')}
                            {c.matched.length > 3 && ` +${c.matched.length - 3}`}
                          </span>
                        </div>
                        <div
                          className="text-[11px] font-mono mt-1 truncate"
                          style={{ color: MUTED }}
                          title={c.cmdline}
                        >
                          {c.cmdline}
                        </div>
                      </div>
                      <button
                        onClick={() => setExpandedPid(expanded ? null : c.pid)}
                        className="text-xs px-2.5 py-1 rounded border whitespace-nowrap transition-colors"
                        style={{
                          background: expanded ? PRIMARY : SURFACE,
                          color: expanded ? ON_PRIM : TEXT,
                          borderColor: expanded ? PRIMARY : BORDER,
                        }}
                      >
                        {expanded ? 'Hide' : 'Protect this'}
                      </button>
                    </div>

                    {expanded && (
                      <div
                        className="mt-3 pt-3 text-[12px] space-y-2"
                        style={{ borderTop: `1px solid ${BORDER}` }}
                      >
                        <p style={{ color: MUTED }}>
                          Add these two lines to the top of this process's
                          entry script, then re-run it:
                        </p>
                        <pre
                          className="px-3 py-2 rounded font-mono whitespace-pre overflow-x-auto"
                          style={{ background: SURFACE, border: `1px solid ${BORDER}`, color: TEXT }}
                        >
{c.lang === 'Python'
  ? `import agentguard\nagentguard.auto("http://localhost:8080", agent_id="pid-${c.pid}")`
  : `import agentguard from '@justinnn/agentguard'\nagentguard.auto('http://localhost:8080', { agentId: 'pid-${c.pid}' })`}
                        </pre>
                        {c.cwd && (
                          <p style={{ color: MUTED }}>
                            <span className="opacity-75">cwd:</span>{' '}
                            <span className="font-mono">{c.cwd}</span>
                          </p>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      )}

      {/* Language filter */}
      <div className="flex items-center gap-2">
        {LANGS.map((l) => {
          const active = filter === l
          return (
            <button
              key={l}
              onClick={() => setFilter(l)}
              className="text-xs px-3 py-1.5 rounded-full border transition-colors"
              style={{
                background: active ? PRIMARY : SURFACE,
                color: active ? ON_PRIM : MUTED,
                borderColor: active ? PRIMARY : BORDER,
              }}
            >
              {l}
            </button>
          )
        })}
        <span className="text-xs ml-auto" style={{ color: MUTED }}>
          {visible.length} framework{visible.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Framework cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {visible.map((fw) => (
          <article
            key={fw.id}
            className="rounded-md p-4 flex flex-col gap-3"
            style={{ background: SURFACE, border: `1px solid ${BORDER}` }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <BrandIcon brand={fw.id.replace(/-js$/, '')} size={20} title={fw.name} />
                <div>
                  <h3
                    className="font-medium text-[15px]"
                    style={{ color: TEXT, letterSpacing: '-0.005em' }}
                  >
                    {fw.name}
                  </h3>
                  <p className="text-[11px] uppercase tracking-wider mt-0.5" style={{ color: MUTED }}>
                    {fw.lang}
                  </p>
                </div>
              </div>
              <button
                onClick={() => copy(fw.id, fw.snippet)}
                className="text-xs px-2 py-1 rounded border inline-flex items-center gap-1.5 transition-colors"
                style={{
                  background: BG,
                  color: copiedId === fw.id ? PRIMARY : TEXT,
                  borderColor: BORDER,
                }}
                aria-label="Copy snippet"
              >
                {copiedId === fw.id ? (
                  <>
                    <Check className="h-3 w-3" /> copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" /> copy
                  </>
                )}
              </button>
            </div>

            <pre
              className="text-[12px] leading-relaxed px-3 py-2 rounded overflow-x-auto font-mono whitespace-pre"
              style={{ background: BG, border: `1px solid ${BORDER}`, color: TEXT }}
            >
{fw.snippet}
            </pre>
            <p className="text-[11px]" style={{ color: MUTED }}>
              <span className="font-mono">{fw.install}</span>
            </p>
          </article>
        ))}
      </div>

      {/* Skip link */}
      <div className="pt-2 text-sm">
        <a
          href="/"
          className="inline-flex items-center gap-1 transition-colors"
          style={{ color: MUTED }}
        >
          Skip to dashboard <ArrowRight className="h-3.5 w-3.5" />
        </a>
      </div>
    </div>
  )
}
