'use client'

import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { loadRules, evaluateRules, AlertEvent } from '@/lib/alerts'

export function useAlerts(traces: any[]) {
  const prevLengthRef = useRef(0)

  useEffect(() => {
    // Only evaluate when new traces arrive
    if (traces.length <= prevLengthRef.current) return
    prevLengthRef.current = traces.length

    const rules = loadRules()
    const events = evaluateRules(rules, traces)

    for (const event of events) {
      showToast(event)
      if (event.ruleId) {
        const rule = rules.find(r => r.id === event.ruleId)
        if (rule?.webhookUrl) sendWebhook(rule.webhookUrl, event)
      }
    }
  }, [traces])
}

function showToast(event: AlertEvent) {
  const opts = {
    description: event.message,
    duration: event.severity === 'critical' ? 10000 : 6000,
  }

  if (event.severity === 'critical') {
    toast.error(`[AEGIS] ${event.ruleName}`, opts)
  } else {
    toast.warning(`[AEGIS] ${event.ruleName}`, opts)
  }
}

async function sendWebhook(url: string, event: AlertEvent) {
  const payload = {
    text: `*[AEGIS Alert]* ${event.ruleName}`,
    attachments: [{
      color: event.severity === 'critical' ? '#dc2626' : '#d97706',
      fields: [
        { title: 'Condition', value: event.message, short: false },
        { title: 'Severity', value: event.severity.toUpperCase(), short: true },
        { title: 'Time', value: event.firedAt.toISOString(), short: true },
      ],
    }],
  }

  try {
    await fetch('/api/alerts/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: url, payload }),
    })
  } catch {
    // silently ignore webhook failures
  }
}
