'use client'

/**
 * Real, colored brand logos.
 *
 * Two-tier fetch strategy so we never render a broken image:
 *
 *   1. Simple Icons CDN — https://cdn.simpleicons.org/<slug>
 *      Pixel-perfect brand marks, CC0-licensed, 3200+ brands.
 *      Slug is case-insensitive but must exist in the catalogue —
 *      some brands (OpenAI is the notable example) aren't there.
 *
 *   2. icon.horse — https://icon.horse/icon/<domain>
 *      Real favicon at good resolution. Universal fallback because
 *      any actual brand has a website with a favicon.
 *
 *   3. Placeholder dot — silent, no console error, no layout shift.
 *
 * Both CDNs set year-long cache headers, so once a user has seen an
 * icon in one place it renders instantly everywhere.
 *
 * ## Adding a brand
 *
 * Add an entry to BRANDS. Always include `domain` — even when the
 * slug is present, the domain is what powers the fallback.
 */

import { useState } from 'react'

interface BrandDef {
  /** Simple Icons slug — null if the brand isn't in the catalogue. */
  slug: string | null
  /** Canonical domain for icon.horse fallback. */
  domain: string
}

const BRANDS: Record<string, BrandDef> = {
  // ── LLM providers ──────────────────────────────────────────────
  anthropic:      { slug: 'anthropic',      domain: 'anthropic.com' },
  openai:         { slug: null,             domain: 'openai.com' },       // not in Simple Icons
  gemini:         { slug: 'googlegemini',   domain: 'gemini.google.com' },
  google:         { slug: 'google',         domain: 'google.com' },
  mistral:        { slug: 'mistralai',      domain: 'mistral.ai' },
  cohere:         { slug: 'cohere',         domain: 'cohere.com' },
  huggingface:    { slug: 'huggingface',    domain: 'huggingface.co' },

  // ── Agent / IDE clients ────────────────────────────────────────
  'claude-code':  { slug: 'anthropic',      domain: 'claude.ai' },
  cursor:         { slug: 'cursor',         domain: 'cursor.com' },
  codeium:        { slug: 'codeium',        domain: 'codeium.com' },
  copilot:        { slug: 'githubcopilot',  domain: 'github.com' },
  vscode:         { slug: 'visualstudiocode', domain: 'code.visualstudio.com' },

  // ── Frameworks ─────────────────────────────────────────────────
  langchain:      { slug: 'langchain',      domain: 'langchain.com' },
  crewai:         { slug: null,             domain: 'crewai.com' },
  llamaindex:     { slug: 'llamaindex',     domain: 'llamaindex.ai' },
  'vercel-ai':    { slug: 'vercel',         domain: 'vercel.com' },
  bedrock:        { slug: 'amazonaws',      domain: 'aws.amazon.com' },
  smolagents:     { slug: 'huggingface',    domain: 'huggingface.co' },
  mastra:         { slug: null,             domain: 'mastra.ai' },

  // ── Payments ───────────────────────────────────────────────────
  stripe:         { slug: 'stripe',         domain: 'stripe.com' },
  visa:           { slug: 'visa',           domain: 'visa.com' },
  mastercard:     { slug: 'mastercard',     domain: 'mastercard.com' },
  plaid:          { slug: 'plaid',          domain: 'plaid.com' },
  brex:           { slug: 'brex',           domain: 'brex.com' },
  circle:         { slug: 'circle',         domain: 'circle.com' },
  coinbase:       { slug: 'coinbase',       domain: 'coinbase.com' },
  ethereum:       { slug: 'ethereum',       domain: 'ethereum.org' },
  solana:         { slug: 'solana',         domain: 'solana.com' },
  'modern-treasury': { slug: null,          domain: 'moderntreasury.com' },
  column:         { slug: null,             domain: 'column.com' },
  chainalysis:    { slug: null,             domain: 'chainalysis.com' },

  // ── Cloud / infra ──────────────────────────────────────────────
  aws:            { slug: 'amazonaws',      domain: 'aws.amazon.com' },
  microsoft:      { slug: 'microsoftazure', domain: 'azure.microsoft.com' },
  azure:          { slug: 'microsoftazure', domain: 'azure.microsoft.com' },
  gcp:            { slug: 'googlecloud',    domain: 'cloud.google.com' },
  oracle:         { slug: 'oracle',         domain: 'oracle.com' },
  apple:          { slug: 'apple',          domain: 'apple.com' },
  cloudflare:     { slug: 'cloudflare',     domain: 'cloudflare.com' },
  vercel:         { slug: 'vercel',         domain: 'vercel.com' },

  // ── Dev tools ──────────────────────────────────────────────────
  github:         { slug: 'github',         domain: 'github.com' },
  gitlab:         { slug: 'gitlab',         domain: 'gitlab.com' },
  slack:          { slug: 'slack',          domain: 'slack.com' },
  notion:         { slug: 'notion',         domain: 'notion.so' },
  linear:         { slug: 'linear',         domain: 'linear.app' },
  jira:           { slug: 'jira',           domain: 'atlassian.com' },
  datadog:        { slug: 'datadog',        domain: 'datadoghq.com' },
  docker:         { slug: 'docker',         domain: 'docker.com' },
  kubernetes:     { slug: 'kubernetes',     domain: 'kubernetes.io' },
  supabase:       { slug: 'supabase',       domain: 'supabase.com' },
  firebase:       { slug: 'firebase',       domain: 'firebase.google.com' },
  postgres:       { slug: 'postgresql',     domain: 'postgresql.org' },
  redis:          { slug: 'redis',          domain: 'redis.io' },
  mongodb:        { slug: 'mongodb',        domain: 'mongodb.com' },

  // ── Email / messaging services (surfaced via tool-icons) ───────
  gmail:          { slug: 'gmail',          domain: 'gmail.com' },
  outlook:        { slug: 'microsoftoutlook', domain: 'outlook.com' },
  icloud:         { slug: 'icloud',         domain: 'icloud.com' },
  proton:         { slug: 'protonmail',     domain: 'proton.me' },
  twilio:         { slug: 'twilio',         domain: 'twilio.com' },
  sendgrid:       { slug: null,             domain: 'sendgrid.com' },
  hubspot:        { slug: 'hubspot',        domain: 'hubspot.com' },

  // ── Search engines ─────────────────────────────────────────────
  bing:           { slug: null,             domain: 'bing.com' },
  duckduckgo:     { slug: 'duckduckgo',     domain: 'duckduckgo.com' },
  perplexity:     { slug: 'perplexity',     domain: 'perplexity.ai' },
  brave:          { slug: 'brave',          domain: 'brave.com' },
}

interface Props {
  brand: string
  size?: number
  className?: string
  title?: string
}

export function BrandIcon({ brand, size = 16, className, title }: Props) {
  const [stage, setStage] = useState<'simpleicons' | 'iconhorse' | 'placeholder'>('simpleicons')
  const key = brand.toLowerCase().trim()
  const def: BrandDef | undefined = BRANDS[key]

  // Unknown brand — go straight to icon.horse using whatever the caller
  // gave us as a domain guess. If that flops we render a placeholder.
  const resolved: BrandDef = def ?? { slug: null, domain: guessDomain(brand) }

  let src: string | null = null
  if (stage === 'simpleicons' && resolved.slug) {
    src = `https://cdn.simpleicons.org/${encodeURIComponent(resolved.slug)}/${encodeURIComponent(resolved.slug)}`
  } else if (stage === 'iconhorse' || (stage === 'simpleicons' && !resolved.slug)) {
    src = `https://icon.horse/icon/${encodeURIComponent(resolved.domain)}`
  }

  if (stage === 'placeholder' || !src) {
    return <PlaceholderDot size={size} className={className} title={title ?? brand} />
  }

  return (
    <img
      src={src}
      alt=""
      title={title ?? brand}
      width={size}
      height={size}
      onError={() => {
        setStage(prev =>
          prev === 'simpleicons' && resolved.slug ? 'iconhorse' : 'placeholder',
        )
      }}
      className={className}
      style={{ display: 'inline-block', verticalAlign: 'middle', borderRadius: 2 }}
      draggable={false}
    />
  )
}

function PlaceholderDot({ size, className, title }: { size: number; className?: string; title: string }) {
  return (
    <span
      aria-label={title}
      title={title}
      className={className}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        border: '1px dotted hsl(var(--muted-foreground))',
        verticalAlign: 'middle',
      }}
    />
  )
}

function guessDomain(input: string): string {
  // Strip protocol + path + spaces so `https://example.com/foo` → `example.com`.
  const s = input.trim().replace(/^https?:\/\//, '').split(/[\/\s]/)[0]
  return s.includes('.') ? s : `${s}.com`
}

/**
 * Resolve a raw string (host, model name, provider label) to a
 * brand key. Returns null when nothing matches so callers hide the
 * icon slot instead of showing a placeholder.
 */
export function brandForHostOrModel(input: string | null | undefined): string | null {
  if (!input) return null
  const s = input.toLowerCase()
  if (s.includes('anthropic')  || s.startsWith('claude') || s.includes('claude-'))   return 'anthropic'
  if (s.includes('openai')     || s.startsWith('gpt')    || s.includes('o1-') || s.includes('o3-')) return 'openai'
  if (s.includes('gemini')     || s.includes('generativelanguage.googleapis'))       return 'gemini'
  if (s.includes('mistral'))   return 'mistral'
  if (s.includes('cohere'))    return 'cohere'
  if (s.includes('stripe'))    return 'stripe'
  if (s.includes('coinbase'))  return 'coinbase'
  if (s.includes('plaid'))     return 'plaid'
  if (s.includes('moderntreasury') || s.includes('modern-treasury')) return 'modern-treasury'
  if (s.includes('column.com')) return 'column'
  if (s.includes('chainalysis')) return 'chainalysis'
  if (s.includes('supabase'))  return 'supabase'
  if (s.includes('github'))    return 'github'
  if (s.includes('cursor'))    return 'cursor'
  return null
}
