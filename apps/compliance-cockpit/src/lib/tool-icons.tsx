/**
 * Agent-tool name → colored icon badge.
 *
 * Two layers:
 *
 *   1. BRAND OVERRIDE — if the tool name matches a known SaaS / cloud
 *      service (gmail_send, slack_post, stripe_charge, github_create_pr,
 *      pg_select, etc.) we render that service's real logo via
 *      <BrandIcon> (which pulls from Simple Icons CDN with an
 *      icon.horse favicon fallback). Colored, unstyled — no disc, no
 *      cutout. The brand's identity IS the color.
 *
 *   2. CATEGORY FALLBACK — for generic tools (web_search, send_email,
 *      execute_sql, shell, …) we render a Lucide glyph on a saturated
 *      category color, the historical "service-icon" look.
 *
 * Adding a new brand: extend `PATTERNS` here + `BRANDS` in
 * components/ui/brand-icon.tsx. Nothing else to do.
 */

import {
  Globe, FileText, Database, Mail, Terminal, FileCode2, Zap,
  FileEdit, Trash2, Search, Lock, Cog,
  type LucideIcon,
} from 'lucide-react'
import { BrandIcon } from '@/components/ui/brand-icon'

// ── BRAND DETECTION ─────────────────────────────────────────────────────────
// Regex patterns that map a raw tool name (`gmail_send`, `execute_pg_query`,
// `stripe_charge_capture`) to a brand slug registered in
// components/ui/brand-icon.tsx. Rightmost pattern wins to allow narrower
// overrides later; today all patterns are disjoint.

const PATTERNS: Array<[RegExp, string]> = [
  // Email
  [/(^|_)gmail(_|$)/,      'gmail'],
  [/(^|_)outlook(_|$)/,    'outlook'],
  [/(^|_)icloud(_|$)/,     'icloud'],
  [/(^|_)proton(_|$)/,     'proton'],
  // Messaging
  [/(^|_)slack(_|$)/,      'slack'],
  // Payments
  [/(^|_)stripe(_|$)/,     'stripe'],
  // Dev / infra
  [/(^|_)github(_|$)|(^|_)gh(_|$)/, 'github'],
  [/(^|_)aws(_|$)|(^|_)s3(_|$)|(^|_)lambda(_|$)/, 'aws'],
  [/(^|_)notion(_|$)/,     'notion'],
  [/(^|_)postgres(_|$)|(^|_)pg(_|$)/, 'postgres'],
  // LLMs
  [/(^|_)openai(_|$)|(^|_)gpt(_|$)/, 'openai'],
  [/(^|_)anthropic(_|$)|(^|_)claude(_|$)/, 'anthropic'],
  [/(^|_)gemini(_|$)/,     'gemini'],
  [/(^|_)mistral(_|$)/,    'mistral'],
  // Search
  [/(^|_)google(_|$)/,     'google'],
  [/(^|_)bing(_|$)/,       'bing'],
  [/(^|_)duckduckgo(_|$)|(^|_)ddg(_|$)/, 'duckduckgo'],
  [/(^|_)perplexity(_|$)/, 'perplexity'],
  [/(^|_)brave(_|$)/,      'brave'],
  // Backend / frontend SaaS
  [/(^|_)vercel(_|$)/,     'vercel'],
  [/(^|_)cloudflare(_|$)|(^|_)cf(_|$)/, 'cloudflare'],
  [/(^|_)supabase(_|$)/,   'supabase'],
  [/(^|_)firebase(_|$)/,   'firebase'],
  [/(^|_)redis(_|$)/,      'redis'],
  [/(^|_)mongodb(_|$)|(^|_)mongo(_|$)/, 'mongodb'],
  [/(^|_)twilio(_|$)/,     'twilio'],
  [/(^|_)sendgrid(_|$)/,   'sendgrid'],
  [/(^|_)linear(_|$)/,     'linear'],
  [/(^|_)jira(_|$)/,       'jira'],
  [/(^|_)hubspot(_|$)/,    'hubspot'],
  [/(^|_)datadog(_|$)|(^|_)dd(_|$)/, 'datadog'],
  [/(^|_)docker(_|$)/,     'docker'],
  [/(^|_)kubernetes(_|$)|(^|_)k8s(_|$)|(^|_)kubectl(_|$)/, 'kubernetes'],
]

function detectBrand(toolName: string | null | undefined): string | null {
  if (!toolName) return null
  const n = toolName.toLowerCase()
  for (const [pat, brand] of PATTERNS) {
    if (pat.test(n)) return brand
  }
  return null
}

// ── CATEGORY FALLBACK ─────────────────────────────────────────────────────

type ToolKey =
  | 'search'  | 'file_read' | 'file_write' | 'file_delete'
  | 'db'      | 'shell'     | 'email'      | 'http'
  | 'code'    | 'secret'    | 'config'     | 'other'

const ICON: Record<ToolKey, LucideIcon> = {
  search:      Search,
  file_read:   FileText,
  file_write:  FileEdit,
  file_delete: Trash2,
  db:          Database,
  shell:       Terminal,
  email:       Mail,
  http:        Globe,
  code:        FileCode2,
  secret:      Lock,
  config:      Cog,
  other:       Zap,
}

const COLOR: Record<ToolKey, string> = {
  search:      '#4285F4',
  file_read:   '#0EA5E9',
  file_write:  '#F59E0B',
  file_delete: '#EF4444',
  db:          '#336791',
  shell:       '#1F2937',
  email:       '#EA4335',
  http:        '#FF6C37',
  code:        '#61DAFB',
  secret:      '#D97706',
  config:      '#6B7280',
  other:       '#9CA3AF',
}

function classify(toolName: string | null | undefined): ToolKey {
  if (!toolName) return 'other'
  const n = toolName.toLowerCase()
  if (/search|lookup|find|query_(?:wiki|kb|knowledge)|fancy_lookup/.test(n)) return 'search'
  if (/(?:^|_)delete[_-]?(?:file|object)|rm$|unlink/.test(n))    return 'file_delete'
  if (/write|append|put_(?:file|object)|upload|save/.test(n))    return 'file_write'
  if (/read|cat|head|tail|get_(?:file|object)|fetch_file/.test(n)) return 'file_read'
  if (/sql|query|select|insert|update|delete_row|^db|_db|database/.test(n)) return 'db'
  if (/shell|run_cmd|execute_(?:code|cmd|shell)|bash|sh$|spawn/.test(n)) return 'shell'
  if (/email|mail|smtp/.test(n)) return 'email'
  if (/http|fetch|request|webhook|post|get_url|api_call/.test(n)) return 'http'
  if (/code|compile|build|publish|deploy|npm|pip/.test(n)) return 'code'
  if (/secret|token|key|password|credential/.test(n)) return 'secret'
  if (/config|setting|env/.test(n)) return 'config'
  return 'other'
}

/** Legacy API kept for backward compatibility — returns Lucide + hex. */
export function toolIconFor(toolName: string | null | undefined): { Icon: LucideIcon; color: string } {
  const key = classify(toolName)
  return { Icon: ICON[key], color: COLOR[key] }
}

/**
 * Tool-name icon.
 *
 *   <ToolIcon name="execute_sql" />          — Postgres-blue Database (fallback)
 *   <ToolIcon name="gmail_send" />           — Real Gmail logo (brand override)
 *   <ToolIcon name="stripe_charge" />        — Real Stripe logo
 *   <ToolIcon name="execute_shell" size={28}/> — terminal-black >_ (fallback)
 *
 * Brand overrides are rendered as unstyled colored logos with no
 * background disc. Category fallbacks keep the existing colored-disc
 * look because they're generic + need visual grouping.
 */
export function ToolIcon({
  name,
  size = 22,
  className,
}: {
  name: string | null | undefined
  size?: number
  className?: string
}) {
  const brand = detectBrand(name)
  if (brand) {
    return <BrandIcon brand={brand} size={size} className={className} title={brand} />
  }

  // Category fallback — colored disc + Lucide glyph. Same look the
  // Cockpit shipped with, preserved so unbranded tools still visually
  // group by category.
  const key = classify(name)
  const Icon = ICON[key]
  const color = COLOR[key]
  const glyphSize = Math.round(size * 0.6)
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
        boxShadow: '0 1px 2px hsl(0 0% 0% / 0.10), inset 0 -1px 0 hsl(0 0% 0% / 0.08)',
      }}
      aria-label={key}
    >
      <Icon size={glyphSize} color="#fff" strokeWidth={2.2} aria-hidden="true" />
    </span>
  )
}
