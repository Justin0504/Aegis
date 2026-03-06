'use client'

import { useState, useEffect } from 'react'
import { Plus, Trash2, Bell, BellOff } from 'lucide-react'
import { loadRules, saveRules, AlertRule, AlertCondition, AlertSeverity } from '@/lib/alerts'

const CONDITION_LABELS: Record<AlertCondition, string> = {
  violation_count: 'Error count in window',
  error_rate: 'Error rate (%)',
  consecutive_errors: 'Consecutive errors',
  tool_latency: 'Avg latency (ms)',
}

const INPUT = {
  base: 'w-full rounded-md px-2.5 py-1.5 text-sm border outline-none',
  style: { background: '#fff', borderColor: 'hsl(36 12% 88%)', color: 'hsl(30 10% 15%)' },
}

export function AlertRules() {
  const [rules, setRules] = useState<AlertRule[]>([])
  const [saved, setSaved] = useState(false)

  useEffect(() => { setRules(loadRules()) }, [])

  function update(id: string, patch: Partial<AlertRule>) {
    setRules(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r))
  }

  function remove(id: string) {
    setRules(prev => prev.filter(r => r.id !== id))
  }

  function add() {
    const newRule: AlertRule = {
      id: `rule-${Date.now()}`,
      name: 'New Alert',
      enabled: true,
      condition: 'violation_count',
      threshold: 5,
      windowMinutes: 10,
      severity: 'warning',
      webhookUrl: '',
      cooldownMinutes: 15,
    }
    setRules(prev => [...prev, newRule])
  }

  function save() {
    saveRules(rules)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="space-y-3">
      {rules.length === 0 && (
        <p className="text-sm py-4 text-center" style={{ color: 'hsl(30 8% 55%)' }}>
          No alert rules — add one below
        </p>
      )}

      {rules.map(rule => (
        <div
          key={rule.id}
          className="rounded-lg border p-4 space-y-3"
          style={{ borderColor: 'hsl(36 12% 88%)', background: rule.enabled ? '#fff' : 'hsl(36 14% 97%)' }}
        >
          {/* Row 1: name + severity + enable/delete */}
          <div className="flex items-center gap-2">
            <input
              className={INPUT.base}
              style={INPUT.style}
              value={rule.name}
              onChange={e => update(rule.id, { name: e.target.value })}
              placeholder="Rule name"
            />
            <select
              className={INPUT.base}
              style={{ ...INPUT.style, width: 'auto', flexShrink: 0 }}
              value={rule.severity}
              onChange={e => update(rule.id, { severity: e.target.value as AlertSeverity })}
            >
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </select>
            <button
              onClick={() => update(rule.id, { enabled: !rule.enabled })}
              className="p-1.5 rounded flex-shrink-0"
              style={{ color: rule.enabled ? 'hsl(150 18% 40%)' : 'hsl(30 8% 55%)' }}
              title={rule.enabled ? 'Disable' : 'Enable'}
            >
              {rule.enabled ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
            </button>
            <button
              onClick={() => remove(rule.id)}
              className="p-1.5 rounded flex-shrink-0"
              style={{ color: 'hsl(0 14% 52%)' }}
              title="Delete"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>

          {/* Row 2: condition + threshold + window */}
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1" style={{ color: 'hsl(30 8% 50%)' }}>
                Condition
              </label>
              <select
                className={INPUT.base}
                style={INPUT.style}
                value={rule.condition}
                onChange={e => update(rule.id, { condition: e.target.value as AlertCondition })}
              >
                {(Object.entries(CONDITION_LABELS) as [AlertCondition, string][]).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1" style={{ color: 'hsl(30 8% 50%)' }}>
                Threshold
              </label>
              <input
                type="number"
                className={INPUT.base}
                style={INPUT.style}
                value={rule.threshold}
                min={1}
                onChange={e => update(rule.id, { threshold: Number(e.target.value) })}
              />
            </div>
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1" style={{ color: 'hsl(30 8% 50%)' }}>
                Window (min)
              </label>
              <input
                type="number"
                className={INPUT.base}
                style={INPUT.style}
                value={rule.windowMinutes}
                min={1}
                onChange={e => update(rule.id, { windowMinutes: Number(e.target.value) })}
              />
            </div>
          </div>

          {/* Row 3: webhook + cooldown */}
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1" style={{ color: 'hsl(30 8% 50%)' }}>
                Webhook URL (Slack / custom)
              </label>
              <input
                className={INPUT.base}
                style={INPUT.style}
                value={rule.webhookUrl || ''}
                onChange={e => update(rule.id, { webhookUrl: e.target.value })}
                placeholder="https://hooks.slack.com/services/…"
              />
            </div>
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1" style={{ color: 'hsl(30 8% 50%)' }}>
                Cooldown (min)
              </label>
              <input
                type="number"
                className={INPUT.base}
                style={INPUT.style}
                value={rule.cooldownMinutes}
                min={1}
                onChange={e => update(rule.id, { cooldownMinutes: Number(e.target.value) })}
              />
            </div>
          </div>
        </div>
      ))}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={add}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border transition-colors"
          style={{ borderColor: 'hsl(36 12% 85%)', color: 'hsl(30 8% 45%)', background: '#fff' }}
        >
          <Plus className="h-3.5 w-3.5" /> Add Rule
        </button>
        <button
          onClick={save}
          className="flex items-center gap-1.5 text-sm px-4 py-1.5 rounded-md font-medium transition-colors ml-auto"
          style={{
            background: saved ? 'hsl(150 18% 40%)' : 'hsl(38 20% 46%)',
            color: '#fff',
          }}
        >
          {saved ? 'Saved ✓' : 'Save Rules'}
        </button>
      </div>
    </div>
  )
}
