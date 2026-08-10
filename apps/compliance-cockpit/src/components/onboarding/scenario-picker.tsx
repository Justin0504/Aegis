'use client'

import { Code2, PlayCircle, FileCode2, Terminal } from 'lucide-react'

const BORDER  = 'hsl(var(--border))'
const TEXT    = 'hsl(var(--foreground))'
const MUTED   = 'hsl(var(--muted-foreground))'
const SURFACE = 'hsl(var(--card))'
const PRIMARY = 'hsl(var(--primary))'

export type ScenarioId = 'python' | 'javascript' | 'demo' | 'proxy'

interface Scenario {
  id: ScenarioId
  title: string
  blurb: string
  icon: any
  tag: string
}

// One tight line per card — enough to disambiguate, no more.
// If a visitor needs the long story, they'll get it on the next
// step of the wizard.
const SCENARIOS: Scenario[] = [
  { id: 'python',     title: 'Python',     blurb: 'Anthropic, OpenAI, LangChain, CrewAI, Gemini, Mistral',   icon: Code2,      tag: 'pip'     },
  { id: 'javascript', title: 'JS / TS',    blurb: 'OpenAI, Anthropic, Vercel AI SDK, Mastra',                icon: FileCode2,  tag: 'npm'     },
  { id: 'proxy',      title: 'HTTP proxy', blurb: 'Point base_url at us — any language, no SDK',             icon: Terminal,   tag: 'drop-in' },
  { id: 'demo',       title: 'No agent yet', blurb: 'Watch a 60-second demo agent trip every panel',         icon: PlayCircle, tag: 'demo'    },
]

export function ScenarioPicker({ onPick }: { onPick: (id: ScenarioId) => void }) {
  return (
    <section className="space-y-4">
      <header>
        <h1
          className="text-2xl md:text-3xl leading-tight"
          style={{ fontFamily: 'var(--font-serif), ui-serif, Georgia, serif', color: TEXT, letterSpacing: '-0.012em' }}
        >
          Get your first agent <em style={{ fontStyle: 'italic' }}>under guard</em>.
        </h1>
        <p className="text-sm mt-1" style={{ color: MUTED }}>
          Pick your stack — a minute each.
        </p>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {SCENARIOS.map(s => {
          const Icon = s.icon
          return (
            <button
              key={s.id}
              onClick={() => onPick(s.id)}
              className="text-left rounded-md px-3.5 py-3 flex items-center gap-3 transition-colors"
              style={{ background: SURFACE, border: `1px solid ${BORDER}` }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = PRIMARY }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = BORDER }}
            >
              <Icon className="h-4 w-4 flex-shrink-0" style={{ color: TEXT }} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate" style={{ color: TEXT }}>{s.title}</span>
                  <span
                    className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded font-mono flex-shrink-0"
                    style={{ background: 'hsl(var(--background))', color: MUTED, border: `1px solid ${BORDER}` }}
                  >
                    {s.tag}
                  </span>
                </div>
                <p className="text-[11px] truncate mt-0.5" style={{ color: MUTED }}>{s.blurb}</p>
              </div>
            </button>
          )
        })}
      </div>
    </section>
  )
}
