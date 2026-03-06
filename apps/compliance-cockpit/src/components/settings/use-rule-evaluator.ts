'use client'

import { useEffect } from 'react'
import { loadRules, evaluateRules, AlertEvent, AlertRule } from '@/lib/alerts'

const EVAL_INTERVAL_MS = 30_000   // evaluate every 30s

async function fetchRecentTraces(): Promise<any[]> {
  try {
    const res = await fetch('/api/gateway/traces?limit=200', { cache: 'no-store' })
    if (!res.ok) return []
    const data = await res.json()
    return data.traces || []
  } catch {
    return []
  }
}

async function hmacSignature(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body))
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
  return `sha256=${hex}`
}

async function fireWebhook(url: string, event: AlertEvent, secret?: string): Promise<void> {
  if (!url) return
  try {
    const body = JSON.stringify({ webhookUrl: url, payload: buildSlackPayload(event) })
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (secret) headers['X-AEGIS-Signature'] = await hmacSignature(secret, body)
    await fetch('/api/alerts/webhook', { method: 'POST', headers, body })
  } catch { /* best effort */ }
}

async function fireSlack(url: string, event: AlertEvent, secret?: string): Promise<void> {
  if (!url) return
  try {
    const body = JSON.stringify({ webhookUrl: url, payload: buildSlackPayload(event) })
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (secret) headers['X-AEGIS-Signature'] = await hmacSignature(secret, body)
    await fetch('/api/alerts/webhook', { method: 'POST', headers, body })
  } catch { /* best effort */ }
}

function buildSlackPayload(event: AlertEvent) {
  return {
    text: `*AEGIS Alert* — ${event.ruleName} (${event.severity.toUpperCase()})\n${event.message}`,
    attachments: [{
      color: event.severity === 'critical' ? 'danger' : 'warning',
      fields: [
        { title: 'Rule',      value: event.ruleName,              short: true },
        { title: 'Severity',  value: event.severity.toUpperCase(), short: true },
        { title: 'Value',     value: String(event.value),         short: true },
        { title: 'Threshold', value: String(event.threshold),     short: true },
        { title: 'Detail',    value: event.message,               short: false },
      ],
      ts: Math.floor(event.firedAt.getTime() / 1000),
    }],
  }
}

async function firePagerDuty(integrationKey: string, event: AlertEvent): Promise<void> {
  if (!integrationKey) return
  try {
    await fetch('https://events.pagerduty.com/v2/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        routing_key:  integrationKey,
        event_action: 'trigger',
        dedup_key:    `aegis-${event.ruleId}`,
        payload: {
          summary:   `AEGIS Alert — ${event.ruleName}: ${event.message}`,
          severity:  event.severity === 'critical' ? 'critical' : 'warning',
          source:    'aegis-gateway',
          custom_details: {
            rule:      event.ruleName,
            value:     event.value,
            threshold: event.threshold,
            firedAt:   event.firedAt.toISOString(),
          },
        },
      }),
    })
  } catch { /* best effort */ }
}

function fireOsNotification(event: AlertEvent): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  try {
    const title = `AEGIS — ${event.ruleName}`
    const body  = `${event.severity.toUpperCase()}: ${event.message}`
    new Notification(title, { body, tag: `alert-${event.ruleId}` })
  } catch { /* best effort */ }
}

async function dispatchAlert(rule: AlertRule, event: AlertEvent): Promise<void> {
  const dest = rule.destinationType ?? 'webhook'
  const val  = rule.webhookUrl ?? ''

  if (dest === 'pagerduty') {
    await firePagerDuty(val, event)
  } else if (dest === 'slack') {
    await fireSlack(val, event, rule.signingSecret)
  } else {
    await fireWebhook(val, event, rule.signingSecret)
  }
}

export function useRuleEvaluator() {
  useEffect(() => {
    let cancelled = false

    async function evaluate() {
      if (cancelled) return
      const rules  = loadRules().filter(r => r.enabled)
      if (rules.length === 0) return

      const traces = await fetchRecentTraces()
      if (traces.length === 0) return

      const fired = evaluateRules(rules, traces)
      for (const event of fired) {
        const rule = rules.find(r => r.id === event.ruleId)
        if (rule) await dispatchAlert(rule, event)
        fireOsNotification(event)
        console.info(`[AEGIS] Alert fired: ${event.ruleName} — ${event.message}`)
      }
    }

    evaluate()
    const t = setInterval(evaluate, EVAL_INTERVAL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [])
}
