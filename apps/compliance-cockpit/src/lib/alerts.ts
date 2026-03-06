export type AlertCondition = 'violation_count' | 'error_rate' | 'consecutive_errors' | 'tool_latency'
export type AlertSeverity = 'warning' | 'critical'

export interface AlertRule {
  id: string
  name: string
  enabled: boolean
  condition: AlertCondition
  threshold: number        // e.g. 3 violations, 50% error rate, 5000ms
  windowMinutes: number    // time window to evaluate over
  severity: AlertSeverity
  webhookUrl?: string      // Slack or generic webhook
  cooldownMinutes: number  // don't re-fire within this period
}

export interface AlertEvent {
  ruleId: string
  ruleName: string
  severity: AlertSeverity
  message: string
  value: number
  threshold: number
  firedAt: Date
}

const STORAGE_KEY = 'aegis:alert-rules'
const FIRED_KEY   = 'aegis:alert-fired'

export function loadRules(): AlertRule[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : defaultRules()
  } catch {
    return defaultRules()
  }
}

export function saveRules(rules: AlertRule[]): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rules))
}

export function getLastFired(): Record<string, number> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(FIRED_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export function markFired(ruleId: string): void {
  if (typeof window === 'undefined') return
  const map = getLastFired()
  map[ruleId] = Date.now()
  localStorage.setItem(FIRED_KEY, JSON.stringify(map))
}

export function evaluateRules(rules: AlertRule[], traces: any[]): AlertEvent[] {
  const now = Date.now()
  const lastFired = getLastFired()
  const events: AlertEvent[] = []

  for (const rule of rules) {
    if (!rule.enabled) continue

    // Cooldown check
    const lastTs = lastFired[rule.id] || 0
    if (now - lastTs < rule.cooldownMinutes * 60 * 1000) continue

    // Filter traces within window
    const windowMs = rule.windowMinutes * 60 * 1000
    const recent = traces.filter(t => {
      const ts = new Date(t.timestamp).getTime()
      return now - ts <= windowMs
    })

    let value = 0
    let message = ''

    switch (rule.condition) {
      case 'violation_count': {
        value = recent.filter(t => t.observation?.error).length
        message = `${value} errors in last ${rule.windowMinutes}min`
        break
      }
      case 'error_rate': {
        if (recent.length === 0) continue
        const errors = recent.filter(t => t.observation?.error).length
        value = Math.round((errors / recent.length) * 100)
        message = `Error rate ${value}% (${errors}/${recent.length} traces)`
        break
      }
      case 'consecutive_errors': {
        const sorted = [...recent].sort((a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        )
        let count = 0
        for (const t of sorted) {
          if (t.observation?.error) count++
          else break
        }
        value = count
        message = `${value} consecutive errors`
        break
      }
      case 'tool_latency': {
        const withDur = recent.filter(t => t.observation?.duration_ms !== undefined)
        if (withDur.length === 0) continue
        const avg = withDur.reduce((s, t) => s + t.observation.duration_ms, 0) / withDur.length
        value = Math.round(avg)
        message = `Average latency ${value}ms`
        break
      }
    }

    if (value >= rule.threshold) {
      events.push({ ruleId: rule.id, ruleName: rule.name, severity: rule.severity, message, value, threshold: rule.threshold, firedAt: new Date() })
      markFired(rule.id)
    }
  }

  return events
}

function defaultRules(): AlertRule[] {
  return [
    {
      id: 'default-violations',
      name: 'High Error Count',
      enabled: true,
      condition: 'violation_count',
      threshold: 5,
      windowMinutes: 10,
      severity: 'warning',
      webhookUrl: '',
      cooldownMinutes: 15,
    },
    {
      id: 'default-consecutive',
      name: 'Consecutive Failures',
      enabled: true,
      condition: 'consecutive_errors',
      threshold: 3,
      windowMinutes: 60,
      severity: 'critical',
      webhookUrl: '',
      cooldownMinutes: 30,
    },
  ]
}
