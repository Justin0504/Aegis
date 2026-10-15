'use client'

import { useState } from 'react'
import Link from 'next/link'

interface Plan {
  id: 'free' | 'pro' | 'team' | 'enterprise'
  name: string
  price: string
  blurb: string
  features: string[]
  cta: string
  highlight?: boolean
}

const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    blurb: 'Self-host or use our hosted gateway. Same engine.',
    features: ['1 org, 1 agent', '100 checks / month', '24-hour retention', 'Core rules + community packs'],
    cta: 'Current plan',
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$19/mo',
    blurb: 'Startups gating production agents.',
    features: ['5 orgs, 100 agents', '100,000 checks / mo', '30-day retention', 'SCIM 2.0 + OIDC SSO', 'Workflow-aware policy generator'],
    cta: 'Upgrade to Pro',
    highlight: true,
  },
  {
    id: 'team',
    name: 'Team',
    price: '$99/mo',
    blurb: 'Mid-market teams ready for compliance reviews.',
    features: ['Unlimited orgs / agents', '1M checks / mo', '90-day retention', 'SAML 2.0 + ADFS', 'Witness cosignature on transparency log'],
    cta: 'Upgrade to Team',
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: 'Custom',
    blurb: 'Regulated industries — BYOC, on-prem, airgap.',
    features: ['Unlimited everything', 'Custom retention', 'SOC 2 Type II report', '99.9% SLA, 24/7 PagerDuty', 'BAA / DPA / MSA'],
    cta: 'Talk to sales',
  },
]

export default function BillingPage() {
  const [busy, setBusy] = useState<string | null>(null)
  const [interval, setInterval] = useState<'month' | 'year'>('month')
  const orgId = typeof window !== 'undefined' ? localStorage.getItem('aegis.orgId') : null

  async function upgrade(plan: 'pro' | 'team') {
    if (!orgId) { window.location.href = '/login'; return }
    setBusy(plan)
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId, plan, interval }),
      })
      const data = await res.json()
      if (data.url) window.location.href = data.url
      else throw new Error(data.error ?? 'checkout failed')
    } catch (e: any) {
      alert(e.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="shell" style={{ maxWidth: 920 }}>
      <Link href="/" className="brand">AEGIS</Link>
      <h1>Pricing.</h1>
      <p className="lede">All plans include the full detector chain, cryptographic audit, and the 4 vertical policy packs.</p>

      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '1.4rem' }}>
        <button
          className={interval === 'month' ? '' : 'ghost'}
          onClick={() => setInterval('month')}
          style={{ padding: '0.4rem 0.9rem', fontSize: 13 }}
        >Monthly</button>
        <button
          className={interval === 'year' ? '' : 'ghost'}
          onClick={() => setInterval('year')}
          style={{ padding: '0.4rem 0.9rem', fontSize: 13 }}
        >Annual <span style={{ opacity: 0.7 }}>(save 17%)</span></button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
        {PLANS.map(p => (
          <div key={p.id} className="card" style={{
            borderColor: p.highlight ? 'var(--primary)' : 'var(--border)',
            position: 'relative',
          }}>
            {p.highlight && (
              <div style={{
                position: 'absolute', top: -10, left: 16,
                background: 'var(--primary)', color: 'var(--primary-fg)',
                fontSize: 10, letterSpacing: 0.08, textTransform: 'uppercase',
                padding: '2px 8px', borderRadius: 4, fontWeight: 600,
              }}>Most popular</div>
            )}
            <h3 style={{ margin: '0 0 0.2rem', fontSize: 18 }}>{p.name}</h3>
            <div style={{ fontSize: 24, fontWeight: 700, margin: '0 0 0.4rem' }}>
              {p.price}
              {interval === 'year' && p.id !== 'free' && p.id !== 'enterprise' && (
                <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 6, fontWeight: 400 }}>
                  billed annually
                </span>
              )}
            </div>
            <p style={{ color: 'var(--muted)', fontSize: 13, minHeight: 36 }}>{p.blurb}</p>
            <ul style={{ paddingLeft: 0, listStyle: 'none', fontSize: 13, lineHeight: 1.8, margin: '0.8rem 0 1.2rem' }}>
              {p.features.map(f => (
                <li key={f} style={{ paddingLeft: 16, position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 0, color: 'var(--ok)', fontWeight: 700 }}>✓</span>
                  {f}
                </li>
              ))}
            </ul>
            {p.id === 'free' ? (
              <button disabled className="ghost" style={{ width: '100%' }}>{p.cta}</button>
            ) : p.id === 'enterprise' ? (
              <a href="mailto:sales@aegis.dev" style={{ display: 'block' }}>
                <button className="ghost" style={{ width: '100%' }}>{p.cta}</button>
              </a>
            ) : (
              <button
                onClick={() => upgrade(p.id as 'pro' | 'team')}
                disabled={busy === p.id}
                style={{ width: '100%' }}
              >
                {busy === p.id ? 'Loading…' : p.cta}
              </button>
            )}
          </div>
        ))}
      </div>

      <p className="meta">
        Self-host is always free. <a href="https://github.com/Justin0504/Aegis">Run the gateway on your own infra →</a>
      </p>
    </div>
  )
}
