export type AnomalyType =
  | 'frequency_spike'
  | 'latency_spike'
  | 'consecutive_failures'
  | 'error_rate_spike'

export type AnomalySeverity = 'low' | 'medium' | 'high'

export interface Anomaly {
  id: string
  type: AnomalyType
  severity: AnomalySeverity
  title: string
  detail: string
  toolName?: string
  agentId?: string
  detectedAt: Date
  value: number
  baseline: number
}

export function detectAnomalies(traces: any[]): Anomaly[] {
  if (traces.length < 5) return []

  const anomalies: Anomaly[] = []
  const now = Date.now()

  // ── 1. Frequency spike: tool called >3x its per-5-min average ──────────
  const recentWindow  = 5  * 60 * 1000   // 5 min
  const baselineWindow = 60 * 60 * 1000  // 60 min baseline

  const toolCounts: Record<string, { recent: number; baseline: number }> = {}

  for (const t of traces) {
    const tool = t.tool_call?.tool_name
    if (!tool) continue
    const age = now - new Date(t.timestamp).getTime()
    if (!toolCounts[tool]) toolCounts[tool] = { recent: 0, baseline: 0 }
    if (age <= recentWindow)   toolCounts[tool].recent++
    if (age <= baselineWindow) toolCounts[tool].baseline++
  }

  for (const [tool, counts] of Object.entries(toolCounts)) {
    // baseline avg per 5-min window = (baseline count / 60min) * 5min
    const baselinePer5m = (counts.baseline / 60) * 5
    if (baselinePer5m > 0 && counts.recent > baselinePer5m * 3) {
      const ratio = Math.round(counts.recent / baselinePer5m)
      anomalies.push({
        id: `freq-${tool}`,
        type: 'frequency_spike',
        severity: ratio > 10 ? 'high' : ratio > 5 ? 'medium' : 'low',
        title: 'Frequency Spike',
        detail: `${tool} called ${counts.recent}x in last 5 min (${ratio}x baseline)`,
        toolName: tool,
        detectedAt: new Date(),
        value: counts.recent,
        baseline: Math.round(baselinePer5m),
      })
    }
  }

  // ── 2. Latency spike: avg latency in last 10 min >3x overall baseline ──
  const latencyWindow = 10 * 60 * 1000
  const withDur = traces.filter(t => t.observation?.duration_ms !== undefined)

  if (withDur.length >= 5) {
    const recentDur  = withDur.filter(t => now - new Date(t.timestamp).getTime() <= latencyWindow)
    const baselineDur = withDur

    if (recentDur.length >= 3) {
      const recentAvg   = recentDur.reduce((s, t)   => s + t.observation.duration_ms, 0) / recentDur.length
      const baselineAvg = baselineDur.reduce((s, t) => s + t.observation.duration_ms, 0) / baselineDur.length

      if (recentAvg > baselineAvg * 3) {
        anomalies.push({
          id: 'latency-spike',
          type: 'latency_spike',
          severity: recentAvg > baselineAvg * 10 ? 'high' : recentAvg > baselineAvg * 5 ? 'medium' : 'low',
          title: 'Latency Spike',
          detail: `Avg ${Math.round(recentAvg)}ms in last 10min (baseline ${Math.round(baselineAvg)}ms)`,
          detectedAt: new Date(),
          value: Math.round(recentAvg),
          baseline: Math.round(baselineAvg),
        })
      }
    }
  }

  // ── 3. Consecutive failures ─────────────────────────────────────────────
  const sorted = [...traces].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  )
  let streak = 0
  let streakAgent: string | undefined
  for (const t of sorted.slice(0, 20)) {
    if (t.observation?.error) {
      streak++
      streakAgent = t.agent_id
    } else break
  }
  if (streak >= 3) {
    anomalies.push({
      id: 'consecutive-failures',
      type: 'consecutive_failures',
      severity: streak >= 8 ? 'high' : streak >= 5 ? 'medium' : 'low',
      title: 'Consecutive Failures',
      detail: `${streak} consecutive errors (latest: ${streakAgent?.substring(0, 8)}…)`,
      agentId: streakAgent,
      detectedAt: new Date(),
      value: streak,
      baseline: 0,
    })
  }

  // ── 4. Error rate spike: last 10 min >50% errors vs baseline <20% ─────
  const errWindow = 10 * 60 * 1000
  const recentAll  = traces.filter(t => now - new Date(t.timestamp).getTime() <= errWindow)
  const baselineAll = traces

  if (recentAll.length >= 5 && baselineAll.length >= 10) {
    const recentErrRate   = recentAll.filter(t => t.observation?.error).length / recentAll.length
    const baselineErrRate = baselineAll.filter(t => t.observation?.error).length / baselineAll.length

    if (recentErrRate > 0.5 && recentErrRate > baselineErrRate * 2) {
      anomalies.push({
        id: 'error-rate-spike',
        type: 'error_rate_spike',
        severity: recentErrRate > 0.8 ? 'high' : recentErrRate > 0.6 ? 'medium' : 'low',
        title: 'Error Rate Spike',
        detail: `${Math.round(recentErrRate * 100)}% errors in last 10min (baseline ${Math.round(baselineErrRate * 100)}%)`,
        detectedAt: new Date(),
        value: Math.round(recentErrRate * 100),
        baseline: Math.round(baselineErrRate * 100),
      })
    }
  }

  return anomalies
}
