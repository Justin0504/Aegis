'use client'

import { useState, useEffect } from 'react'
import { AlertRules } from './alert-rules'
import { useRuleEvaluator } from './use-rule-evaluator'
import { CheckCircle, XCircle, Loader2, Copy, Check, Eye, EyeOff, RefreshCw } from 'lucide-react'

const BORDER = 'hsl(36 12% 88%)'
const MUTED  = 'hsl(30 8% 55%)'
const TEXT   = 'hsl(30 10% 15%)'
const BG     = '#fff'

const QUICK_START = `pip install agentguard-aegis

import agentguard
agentguard.auto("http://localhost:8080", agent_id="my-agent")

# Everything below is unchanged — no decorators needed
client = anthropic.Anthropic()
response = client.messages.create(...)

# Or with env vars (zero code changes):
# AGENTGUARD_URL=http://localhost:8080 python your_agent.py`

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border" style={{ borderColor: BORDER, background: BG }}>
      <div className="px-5 py-3 border-b" style={{ borderColor: BORDER }}>
        <p className="text-sm font-semibold" style={{ color: TEXT }}>{title}</p>
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  )
}

export function SettingsView() {
  const [gatewayUrl, setGatewayUrl]     = useState('http://localhost:8080')
  const [health, setHealth]             = useState<'checking' | 'online' | 'offline'>('checking')
  const [copied, setCopied]             = useState(false)
  const [urlSaved, setUrlSaved]         = useState(false)

  // Gateway API Key
  const [apiKey, setApiKey]             = useState('')
  const [keyCopied, setKeyCopied]       = useState(false)
  const [keyVisible, setKeyVisible]     = useState(false)
  const [keySaved, setKeySaved]         = useState(false)
  const [regenerating, setRegenerating] = useState(false)

  // AI Assistant
  const [aiProvider, setAiProvider]     = useState<'openai' | 'anthropic'>('openai')
  const [aiKey, setAiKey]               = useState('')
  const [aiKeyVisible, setAiKeyVisible] = useState(false)
  const [aiSaved, setAiSaved]           = useState(false)

  // Wire alert rule evaluator
  useRuleEvaluator()

  // Load saved settings
  useEffect(() => {
    const savedUrl      = localStorage.getItem('aegis:gateway_url')
    const savedKey      = localStorage.getItem('aegis:api_key')
    const savedProvider = localStorage.getItem('aegis:ai_provider') as 'openai' | 'anthropic' | null
    const savedAiKey    = localStorage.getItem('aegis:ai_key')
    if (savedUrl)      setGatewayUrl(savedUrl)
    if (savedKey)      setApiKey(savedKey)
    if (savedProvider) setAiProvider(savedProvider)
    if (savedAiKey)    setAiKey(savedAiKey)
  }, [])

  // Auto-fetch gateway key on first load (bootstrap)
  useEffect(() => {
    const existing = localStorage.getItem('aegis:api_key')
    if (existing) return
    fetch('/api/gateway/auth/key', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.api_key) { setApiKey(d.api_key); localStorage.setItem('aegis:api_key', d.api_key) } })
      .catch(() => {})
  }, [])

  // Live health check
  useEffect(() => {
    let cancelled = false
    async function check() {
      setHealth('checking')
      try {
        const res = await fetch(`/api/gateway/health`, { cache: 'no-store' })
        if (!cancelled) setHealth(res.ok ? 'online' : 'offline')
      } catch {
        if (!cancelled) setHealth('offline')
      }
    }
    check()
    const t = setInterval(check, 15_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [gatewayUrl])

  function saveGatewayUrl() {
    localStorage.setItem('aegis:gateway_url', gatewayUrl)
    setUrlSaved(true)
    setTimeout(() => setUrlSaved(false), 2000)
  }

  function saveApiKey() {
    localStorage.setItem('aegis:api_key', apiKey)
    setKeySaved(true)
    setTimeout(() => setKeySaved(false), 2000)
  }

  async function regenerateKey() {
    if (!confirm('Regenerate the API key? The old key will stop working immediately.')) return
    setRegenerating(true)
    try {
      const res = await fetch('/api/gateway/auth/regenerate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      })
      const data = await res.json()
      if (data.api_key) {
        setApiKey(data.api_key)
        localStorage.setItem('aegis:api_key', data.api_key)
      }
    } catch {}
    setRegenerating(false)
  }

  function saveAiConfig() {
    localStorage.setItem('aegis:ai_provider', aiProvider)
    localStorage.setItem('aegis:ai_key', aiKey)
    setAiSaved(true)
    setTimeout(() => setAiSaved(false), 2000)
  }

  function copyQuickStart() {
    navigator.clipboard.writeText(QUICK_START)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const inputStyle = {
    flex: 1, fontSize: '13px', borderRadius: '6px', border: `1px solid ${BORDER}`,
    padding: '7px 10px', outline: 'none', fontFamily: 'monospace',
    background: 'hsl(36 12% 98%)', color: TEXT,
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p style={{ color: MUTED }}>Gateway configuration, alert rules, and SDK setup</p>
      </div>

      {/* Gateway */}
      <Section title="Gateway">
        <div className="space-y-3">
          <div>
            <label className="text-xs font-semibold uppercase tracking-wide block mb-1.5" style={{ color: MUTED }}>
              Gateway URL
            </label>
            <div className="flex gap-2">
              <input
                value={gatewayUrl}
                onChange={e => setGatewayUrl(e.target.value)}
                style={inputStyle}
              />
              <button
                onClick={saveGatewayUrl}
                className="px-3 py-2 rounded-md text-sm font-medium"
                style={{ background: urlSaved ? 'hsl(150 18% 40%)' : 'hsl(38 20% 46%)', color: '#fff' }}
              >
                {urlSaved ? 'Saved ✓' : 'Save'}
              </button>
            </div>
            <p className="text-[11px] mt-1" style={{ color: MUTED }}>
              Also set via <code className="font-mono">GATEWAY_URL</code> env var when deploying
            </p>
          </div>

          <div className="grid grid-cols-3 gap-3 pt-1">
            {[
              { label: 'Status', value: health === 'checking'
                  ? <span className="flex items-center gap-1"><Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: MUTED }} /> Checking…</span>
                  : health === 'online'
                  ? <span className="flex items-center gap-1"><CheckCircle className="h-3.5 w-3.5" style={{ color: 'hsl(150 18% 40%)' }} /><span style={{ color: 'hsl(150 18% 40%)' }}>Online</span></span>
                  : <span className="flex items-center gap-1"><XCircle className="h-3.5 w-3.5" style={{ color: 'hsl(0 14% 46%)' }} /><span style={{ color: 'hsl(0 14% 46%)' }}>Offline</span></span>
              },
              { label: 'WebSocket', value: <span className="font-mono text-xs">{gatewayUrl.replace('http', 'ws')}/mcp</span> },
              { label: 'Traces API', value: <span className="font-mono text-xs">{gatewayUrl}/api/v1/traces</span> },
            ].map(({ label, value }) => (
              <div key={label} className="rounded-lg p-3" style={{ background: 'hsl(36 14% 95%)' }}>
                <p className="text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: MUTED }}>{label}</p>
                <div className="text-sm" style={{ color: TEXT }}>{value}</div>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* Gateway API Key */}
      <Section title="Gateway API Key">
        <p className="text-xs mb-3" style={{ color: MUTED }}>
          Protects the management API. Auto-generated on first start. Paste it here to enable authenticated dashboard access.
        </p>
        <div className="space-y-2">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                type={keyVisible ? 'text' : 'password'}
                placeholder="Paste your gateway API key…"
                style={{ ...inputStyle, flex: undefined, width: '100%', paddingRight: '32px' }}
              />
              <button
                onClick={() => setKeyVisible(v => !v)}
                style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: MUTED }}
              >
                {keyVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
            <button
              onClick={() => { navigator.clipboard.writeText(apiKey); setKeyCopied(true); setTimeout(() => setKeyCopied(false), 2000) }}
              style={{ padding: '7px 10px', borderRadius: '6px', border: `1px solid ${BORDER}`, background: '#fff', color: MUTED, cursor: 'pointer' }}
              title="Copy"
            >
              {keyCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
            <button
              onClick={saveApiKey}
              style={{ padding: '7px 14px', borderRadius: '6px', fontSize: '13px', fontWeight: 600, background: keySaved ? 'hsl(150 18% 40%)' : 'hsl(38 20% 46%)', color: '#fff', border: 'none', cursor: 'pointer' }}
            >
              {keySaved ? 'Saved ✓' : 'Save'}
            </button>
            <button
              onClick={regenerateKey}
              disabled={regenerating}
              style={{ padding: '7px 10px', borderRadius: '6px', border: `1px solid hsl(0 10% 82%)`, background: '#fff', color: 'hsl(0 14% 50%)', cursor: regenerating ? 'wait' : 'pointer', opacity: regenerating ? 0.5 : 1 }}
              title="Regenerate key (old key stops working)"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${regenerating ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <p className="text-[11px]" style={{ color: MUTED }}>
            Find the key in gateway startup logs: <code className="font-mono">🔑 Dashboard API key: ...</code>
          </p>
        </div>
      </Section>

      {/* AI Assistant */}
      <Section title="AI Assistant">
        <p className="text-xs mb-3" style={{ color: MUTED }}>
          Used for natural language policy generation. Your key is stored locally and never sent to the gateway.
        </p>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-xs font-semibold uppercase tracking-wide block mb-1.5" style={{ color: MUTED }}>Provider</label>
            <select
              value={aiProvider}
              onChange={e => setAiProvider(e.target.value as 'openai' | 'anthropic')}
              style={{ width: '100%', padding: '7px 10px', borderRadius: '6px', fontSize: '13px', border: `1px solid ${BORDER}`, background: '#fff', color: TEXT, outline: 'none' }}
            >
              <option value="openai">OpenAI (gpt-4o-mini)</option>
              <option value="anthropic">Anthropic (claude-haiku)</option>
            </select>
          </div>
          <div className="col-span-2">
            <label className="text-xs font-semibold uppercase tracking-wide block mb-1.5" style={{ color: MUTED }}>API Key</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  value={aiKey}
                  onChange={e => setAiKey(e.target.value)}
                  type={aiKeyVisible ? 'text' : 'password'}
                  placeholder={aiProvider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
                  style={{ ...inputStyle, flex: undefined, width: '100%', paddingRight: '32px' }}
                />
                <button
                  onClick={() => setAiKeyVisible(v => !v)}
                  style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: MUTED }}
                >
                  {aiKeyVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
              <button
                onClick={saveAiConfig}
                style={{ padding: '7px 14px', borderRadius: '6px', fontSize: '13px', fontWeight: 600, background: aiSaved ? 'hsl(150 18% 40%)' : 'hsl(38 20% 46%)', color: '#fff', border: 'none', cursor: 'pointer', flexShrink: 0 }}
              >
                {aiSaved ? 'Saved ✓' : 'Save'}
              </button>
            </div>
          </div>
        </div>
        <p className="text-[11px] mt-2" style={{ color: MUTED }}>
          Once saved, use <strong>✨ Describe</strong> on the Policies page to generate policies from plain English.
        </p>
      </Section>

      {/* Alert Rules */}
      <Section title="Alert Rules">
        <p className="text-xs mb-3" style={{ color: MUTED }}>
          Rules are evaluated against live traces every 30 seconds. Supports Webhook, Slack, and PagerDuty destinations.
        </p>
        <AlertRules />
      </Section>

      {/* SDK Quick Start */}
      <Section title="SDK Quick Start">
        <div className="relative">
          <pre
            className="text-xs rounded-lg p-4 overflow-auto"
            style={{ background: 'hsl(36 14% 96%)', color: TEXT, fontFamily: 'monospace' }}
          >
            {QUICK_START}
          </pre>
          <button
            onClick={copyQuickStart}
            className="absolute top-2 right-2 p-1.5 rounded text-xs flex items-center gap-1"
            style={{ background: 'hsl(36 12% 88%)', color: MUTED }}
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          {[
            { label: 'Anthropic',  status: '✅ auto' },
            { label: 'OpenAI',     status: '✅ auto' },
            { label: 'LangChain',  status: '✅ auto' },
            { label: 'CrewAI',     status: '✅ auto' },
            { label: 'Gemini',     status: '✅ auto' },
            { label: 'Bedrock',    status: '✅ auto' },
            { label: 'Mistral',    status: '✅ auto' },
            { label: 'LlamaIndex', status: '✅ auto' },
            { label: 'smolagents', status: '✅ auto' },
          ].map(({ label, status }) => (
            <div key={label} className="rounded-md px-3 py-2 flex justify-between items-center"
              style={{ background: 'hsl(36 14% 96%)', border: `1px solid ${BORDER}` }}>
              <span className="text-xs font-medium" style={{ color: TEXT }}>{label}</span>
              <span className="text-[10px]" style={{ color: 'hsl(150 14% 42%)' }}>{status}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* MCP Server (Claude Desktop) */}
      <Section title="Claude Desktop Integration (MCP)">
        <p className="text-sm mb-3" style={{ color: MUTED }}>
          AEGIS exposes audit tools (<code>query_traces</code>, <code>list_violations</code>, <code>get_agent_stats</code>, <code>list_policies</code>) as an MCP server. Add to your Claude Desktop config:
        </p>
        <pre
          className="text-xs rounded-lg p-4 overflow-auto"
          style={{ background: 'hsl(36 14% 96%)', color: TEXT, fontFamily: 'monospace' }}
        >{`{
  "mcpServers": {
    "aegis": {
      "url": "${gatewayUrl.replace('http', 'ws')}/mcp-audit"
    }
  }
}`}</pre>
      </Section>

      {/* Kill Switch */}
      <Section title="Kill Switch">
        <p className="text-sm" style={{ color: MUTED }}>
          An agent is automatically revoked after 3 policy violations within 1 hour.
          Manual revocation:
        </p>
        <code
          className="block mt-2 text-xs rounded-md px-3 py-2 font-mono"
          style={{ background: 'hsl(36 14% 96%)', color: TEXT }}
        >
          POST {gatewayUrl}/api/v1/agents/:id/revoke
        </code>
      </Section>
    </div>
  )
}
