'use client'

/**
 * Proxy wizard — the "no-code integration" surface.
 *
 * Goal: from "I just installed AEGIS" to "every agent on my machine
 * is being traced" in three clicks, without touching any agent code.
 *
 * The wizard is deliberately step-based so the user always sees WHERE
 * they are, what admin prompts to expect, and how to reverse each
 * step. This is a security-sensitive flow (CA cert install + system
 * proxy redirect) and we treat it as such — no black-box "one big
 * button" pattern.
 *
 * Steps:
 *   1. Start the AEGIS proxy binary (listens on localhost:18081)
 *   2. Install the AEGIS root CA into the OS trust store (one admin prompt)
 *   3. Point the system proxy at 127.0.0.1:18081 (one admin prompt)
 *   4. Verify: run `curl https://api.openai.com/v1/models` and see it
 *      land in the AEGIS trace log — no code changes.
 *
 * Every step calls a Tauri IPC command (see system_proxy.rs) that
 * shells out to the OS-standard command. The wizard renders the exact
 * command verbatim in a monospace panel — no hidden magic.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Shield, ShieldCheck, ShieldOff, ChevronRight, CheckCircle2,
  AlertTriangle, Copy, Loader2, RotateCcw, Play,
} from 'lucide-react'

// Tauri IPC bridge — no-op outside Tauri (hosted Cockpit still renders).
function tauriInvoke<T>(name: string, args?: any): Promise<T> {
  if (typeof window === 'undefined') return Promise.reject(new Error('SSR'))
  const tauri = (window as any).__TAURI__
  if (!tauri?.core?.invoke) {
    return Promise.reject(new Error('not-in-tauri'))
  }
  return tauri.core.invoke(name, args) as Promise<T>
}

interface SysCmdResult {
  ok: boolean
  command: string
  stdout: string
  stderr: string
  hint?: string | null
}

const DEFAULT_ALLOWLIST = [
  { host: 'api.anthropic.com',   category: 'LLM',       enabled: true },
  { host: 'api.openai.com',      category: 'LLM',       enabled: true },
  { host: 'generativelanguage.googleapis.com', category: 'LLM', enabled: true },
  { host: 'api.mistral.ai',      category: 'LLM',       enabled: true },
  { host: 'api.stripe.com',      category: 'Payment',   enabled: true },
  { host: 'api.modern-treasury.com', category: 'Payment', enabled: false },
  { host: 'api.column.com',      category: 'Payment',   enabled: false },
  { host: 'api.chainalysis.com', category: 'Compliance',enabled: false },
]

const MUTED   = 'hsl(var(--muted-foreground))'
const TEXT    = 'hsl(var(--foreground))'
const BORDER  = 'hsl(var(--border))'
const SURFACE = 'hsl(var(--card))'
const OK      = 'hsl(150 30% 40%)'
const BAD     = 'hsl(0 42% 40%)'
const WARN    = 'hsl(36 65% 40%)'
const PRIMARY = 'hsl(var(--primary))'

export function ProxyWizard() {
  const [inTauri, setInTauri]           = useState(false)
  const [running, setRunning]           = useState<string | null>(null)
  const [proxyStatus, setProxyStatus]   = useState<SysCmdResult | null>(null)
  const [enableResult, setEnableResult] = useState<SysCmdResult | null>(null)
  const [caResult, setCaResult]         = useState<SysCmdResult | null>(null)
  const [allowlist, setAllowlist]       = useState(DEFAULT_ALLOWLIST)

  useEffect(() => {
    const tauri = typeof window !== 'undefined' && !!(window as any).__TAURI__
    setInTauri(tauri)
    if (tauri) {
      tauriInvoke<SysCmdResult>('system_proxy_status')
        .then(setProxyStatus).catch(() => {})
    }
  }, [])

  async function runStep(step: string, cmd: string, setter: (r: SysCmdResult) => void) {
    setRunning(step)
    try {
      const r = await tauriInvoke<SysCmdResult>(cmd)
      setter(r)
    } catch (e: any) {
      setter({ ok: false, command: cmd, stdout: '', stderr: e.message ?? String(e) })
    } finally {
      setRunning(null)
    }
  }

  const enabledHosts = allowlist.filter(a => a.enabled).map(a => a.host)

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <p className="text-xs uppercase tracking-widest mb-2" style={{ color: MUTED }}>
          Zero-code integration
        </p>
        <h1 className="text-3xl font-serif" style={{ fontFamily: 'var(--font-serif), Georgia, serif' }}>
          System proxy setup
        </h1>
        <p className="text-sm mt-1 max-w-2xl" style={{ color: MUTED }}>
          Route every HTTPS call your agents make through AEGIS — no SDK, no source-code changes.
          Three steps, each one auditable and reversible.
        </p>
      </div>

      {!inTauri && (
        <div className="rounded-lg border p-4 flex items-start gap-3"
             style={{ background: 'hsl(36 55% 96%)', borderColor: 'hsl(36 65% 82%)' }}>
          <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" style={{ color: WARN }} />
          <div className="text-sm">
            <div className="font-medium" style={{ color: WARN }}>Desktop only</div>
            <div className="text-xs mt-0.5" style={{ color: WARN }}>
              This wizard configures the OS proxy + trust store. It only runs inside the AEGIS desktop app
              (macOS / Windows / Linux). If you're viewing the hosted Cockpit, download the desktop app
              from <Link href="https://aegistraces.com/download" className="underline">aegistraces.com/download</Link>.
            </div>
          </div>
        </div>
      )}

      {/* ── Step 1: allowlist ─────────────────────────────────────── */}
      <Step
        n={1}
        title="Choose which hosts to monitor"
        subtitle="AEGIS decrypts only these hosts. All other HTTPS passes through untouched (no MITM)."
      >
        <div className="rounded-md border overflow-hidden" style={{ borderColor: BORDER }}>
          {allowlist.map((a, i) => (
            <div key={a.host} className="flex items-center gap-3 px-4 py-2.5 border-b last:border-b-0"
                 style={{ borderColor: BORDER, background: SURFACE }}>
              <input
                type="checkbox"
                checked={a.enabled}
                onChange={() => setAllowlist(prev => prev.map((x, ix) => ix === i ? { ...x, enabled: !x.enabled } : x))}
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-mono">{a.host}</div>
                <div className="text-xs mt-0.5" style={{ color: MUTED }}>{a.category}</div>
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs mt-2" style={{ color: MUTED }}>
          {enabledHosts.length} host{enabledHosts.length === 1 ? '' : 's'} on the allowlist.
          Traffic to any other host is TCP-tunneled without decryption.
        </p>
      </Step>

      {/* ── Step 2: install CA cert ───────────────────────────────── */}
      <Step
        n={2}
        title="Install the AEGIS root certificate"
        subtitle="Adds AEGIS's CA to the OS trust store so leaf certs generated by the proxy validate. One admin prompt."
      >
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => runStep('install-ca', 'install_proxy_ca', setCaResult)}
            disabled={!inTauri || running !== null}
            className="text-sm font-medium px-3 py-1.5 rounded flex items-center gap-1.5"
            style={{
              background: PRIMARY, color: 'hsl(var(--primary-foreground))',
              opacity: !inTauri || running !== null ? 0.5 : 1,
            }}>
            {running === 'install-ca'
              ? (<><Loader2 className="h-3.5 w-3.5 animate-spin" /> Installing…</>)
              : (<><Shield className="h-3.5 w-3.5" /> Install CA</>)}
          </button>
          <button
            onClick={() => runStep('uninstall-ca', 'uninstall_proxy_ca', setCaResult)}
            disabled={!inTauri || running !== null}
            className="text-xs px-2.5 py-1.5 rounded border flex items-center gap-1"
            style={{ borderColor: BORDER, color: MUTED }}>
            <RotateCcw className="h-3 w-3" />
            Uninstall
          </button>
        </div>
        {caResult && <CmdOutput result={caResult} />}
      </Step>

      {/* ── Step 3: configure system proxy ────────────────────────── */}
      <Step
        n={3}
        title="Point the OS proxy at 127.0.0.1:18081"
        subtitle="Every process that respects OS proxy settings (Claude Code, Cursor, curl, Python requests, Node fetch) will route through AEGIS."
      >
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => runStep('enable-proxy', 'system_proxy_enable', setEnableResult)}
            disabled={!inTauri || running !== null}
            className="text-sm font-medium px-3 py-1.5 rounded flex items-center gap-1.5"
            style={{
              background: PRIMARY, color: 'hsl(var(--primary-foreground))',
              opacity: !inTauri || running !== null ? 0.5 : 1,
            }}>
            {running === 'enable-proxy'
              ? (<><Loader2 className="h-3.5 w-3.5 animate-spin" /> Enabling…</>)
              : (<><Play className="h-3.5 w-3.5" /> Enable system proxy</>)}
          </button>
          <button
            onClick={() => runStep('disable-proxy', 'system_proxy_disable', setEnableResult)}
            disabled={!inTauri || running !== null}
            className="text-xs px-2.5 py-1.5 rounded border flex items-center gap-1"
            style={{ borderColor: BORDER, color: MUTED }}>
            <ShieldOff className="h-3 w-3" />
            Disable
          </button>
          <button
            onClick={() => runStep('status', 'system_proxy_status', setProxyStatus)}
            disabled={!inTauri || running !== null}
            className="text-xs px-2.5 py-1.5 rounded border flex items-center gap-1"
            style={{ borderColor: BORDER, color: MUTED }}>
            Refresh status
          </button>
        </div>
        {enableResult && <CmdOutput result={enableResult} />}
        {proxyStatus && enableResult === null && <CmdOutput result={proxyStatus} label="Current status" />}
      </Step>

      {/* ── Step 4: verify ────────────────────────────────────────── */}
      <Step
        n={4}
        title="Verify"
        subtitle="Run this in your terminal — you should see the request land in the Activity tab within 2 seconds."
      >
        <CodeCopy code="curl -sSL https://api.openai.com/v1/models -o /dev/null -w '%{http_code}\n'" />
      </Step>

      <div className="rounded-lg border p-4" style={{ background: SURFACE, borderColor: BORDER }}>
        <div className="text-xs uppercase tracking-widest mb-2" style={{ color: MUTED }}>
          Reversal
        </div>
        <p className="text-sm" style={{ color: TEXT }}>
          To fully undo: Disable the system proxy (Step 3), then Uninstall the CA (Step 2).
          Both operations are idempotent. AEGIS never persists anything on the OS outside these two objects.
        </p>
      </div>
    </div>
  )
}

function Step({ n, title, subtitle, children }: { n: number; title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border p-5" style={{ borderColor: BORDER, background: SURFACE }}>
      <div className="flex items-start gap-3 mb-3">
        <div className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold"
             style={{ background: 'hsl(var(--secondary))', color: TEXT }}>
          {n}
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-serif" style={{ fontFamily: 'var(--font-serif), Georgia, serif' }}>{title}</h2>
          <p className="text-xs mt-0.5" style={{ color: MUTED }}>{subtitle}</p>
        </div>
      </div>
      <div className="pl-10">{children}</div>
    </section>
  )
}

function CmdOutput({ result, label }: { result: SysCmdResult; label?: string }) {
  const Icon = result.ok ? CheckCircle2 : AlertTriangle
  const color = result.ok ? OK : BAD
  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center gap-1.5 text-xs" style={{ color }}>
        <Icon className="h-3.5 w-3.5" />
        {label ?? (result.ok ? 'Success' : 'Failed')}
      </div>
      <pre className="text-xs rounded p-2.5 font-mono overflow-x-auto"
           style={{ background: 'hsl(var(--muted))', color: TEXT, borderLeft: `3px solid ${color}` }}>
        <div style={{ color: MUTED }}># {result.command}</div>
        {result.stdout && <div>{result.stdout}</div>}
        {result.stderr && <div style={{ color: BAD }}>{result.stderr}</div>}
      </pre>
      {result.hint && (
        <div className="text-xs px-2 py-1.5 rounded" style={{ background: 'hsl(var(--muted))', color: MUTED }}>
          {result.hint}
        </div>
      )}
    </div>
  )
}

function CodeCopy({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="relative">
      <pre className="text-xs rounded p-3 font-mono overflow-x-auto"
           style={{ background: 'hsl(var(--muted))', color: TEXT }}>{code}</pre>
      <button
        onClick={() => {
          navigator.clipboard.writeText(code).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
        className="absolute top-2 right-2 text-xs px-2 py-1 rounded flex items-center gap-1"
        style={{ background: SURFACE, color: MUTED, border: `1px solid ${BORDER}` }}>
        <Copy className="h-3 w-3" />
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
