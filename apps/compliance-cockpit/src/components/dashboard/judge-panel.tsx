'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { gw } from '@/lib/gateway'
import { Bot, Play, BarChart3, AlertTriangle } from 'lucide-react'

const MUTED  = 'hsl(30 8% 55%)'
const TEXT   = 'hsl(30 10% 15%)'
const BORDER = 'hsl(36 12% 88%)'
const ACCENT = 'hsl(36 60% 50%)'
const GREEN  = 'hsl(142 50% 36%)'
const RED    = 'hsl(0 60% 50%)'

function scoreColor(score: number) {
  if (score >= 4) return GREEN
  if (score >= 3) return MUTED
  return RED
}

function ScoreBar({ label, score }: { label: string; score: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <span style={{ width: 100, fontSize: 13, color: TEXT }}>{label}</span>
      <div style={{
        flex: 1, height: 8, borderRadius: 4,
        background: BORDER, overflow: 'hidden',
      }}>
        <div style={{
          width: `${(score / 5) * 100}%`, height: '100%',
          borderRadius: 4, background: scoreColor(score),
          transition: 'width 0.3s',
        }} />
      </div>
      <span style={{ width: 36, fontSize: 13, fontWeight: 600, color: scoreColor(score), textAlign: 'right' }}>
        {score.toFixed(1)}
      </span>
    </div>
  )
}

export function JudgePanel() {
  const qc = useQueryClient()
  const [provider, setProvider] = useState<string>(() =>
    typeof window !== 'undefined' ? (localStorage.getItem('aegis:ai_provider') || 'openai') : 'openai'
  )
  const [apiKey, setApiKey] = useState<string>(() =>
    typeof window !== 'undefined' ? (localStorage.getItem('aegis:ai_key') || '') : ''
  )
  const [batchSize, setBatchSize] = useState(10)

  const { data: stats, isLoading } = useQuery({
    queryKey: ['judge-stats'],
    queryFn: async () => {
      const res = await gw('judge/stats')
      if (!res.ok) return null
      return res.json()
    },
    refetchInterval: 15_000,
  })

  const batchMutation = useMutation({
    mutationFn: async () => {
      const res = await gw('judge/batch', {
        method: 'POST',
        body: JSON.stringify({ provider, apiKey, batchSize }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed')
      }
      return res.json()
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['judge-stats'] })
      qc.invalidateQueries({ queryKey: ['eval-stats'] })
    },
  })

  const o = stats?.overall

  return (
    <div className="space-y-6">
      {/* Config bar */}
      <div style={{
        display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap',
        padding: 16, borderRadius: 8, border: `1px solid ${BORDER}`, background: 'hsl(36 20% 98%)',
      }}>
        <div>
          <label style={{ fontSize: 12, color: MUTED, display: 'block', marginBottom: 4 }}>Provider</label>
          <select
            value={provider}
            onChange={e => { setProvider(e.target.value); localStorage.setItem('aegis:ai_provider', e.target.value) }}
            style={{
              padding: '6px 10px', borderRadius: 6, border: `1px solid ${BORDER}`,
              fontSize: 13, background: 'white', color: TEXT,
            }}
          >
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <label style={{ fontSize: 12, color: MUTED, display: 'block', marginBottom: 4 }}>API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={e => { setApiKey(e.target.value); localStorage.setItem('aegis:ai_key', e.target.value) }}
            placeholder="sk-..."
            style={{
              width: '100%', padding: '6px 10px', borderRadius: 6,
              border: `1px solid ${BORDER}`, fontSize: 13, color: TEXT,
            }}
          />
        </div>
        <div>
          <label style={{ fontSize: 12, color: MUTED, display: 'block', marginBottom: 4 }}>Batch Size</label>
          <input
            type="number" min={1} max={50} value={batchSize}
            onChange={e => setBatchSize(Number(e.target.value))}
            style={{
              width: 64, padding: '6px 10px', borderRadius: 6,
              border: `1px solid ${BORDER}`, fontSize: 13, color: TEXT, textAlign: 'center',
            }}
          />
        </div>
        <button
          onClick={() => batchMutation.mutate()}
          disabled={!apiKey || batchMutation.isPending}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 18px', borderRadius: 6, border: 'none',
            background: apiKey ? ACCENT : BORDER,
            color: 'white', fontWeight: 600, fontSize: 13, cursor: apiKey ? 'pointer' : 'not-allowed',
            opacity: batchMutation.isPending ? 0.6 : 1,
          }}
        >
          <Play size={14} />
          {batchMutation.isPending ? 'Judging...' : 'Run Batch'}
        </button>
      </div>

      {/* Batch result */}
      {batchMutation.isSuccess && (
        <div style={{
          padding: 12, borderRadius: 8, border: `1px solid ${GREEN}33`,
          background: `${GREEN}0a`, fontSize: 13, color: TEXT,
        }}>
          Judged {batchMutation.data.judged} traces
          {batchMutation.data.avg_score != null && ` — avg score: ${batchMutation.data.avg_score}/5`}
        </div>
      )}
      {batchMutation.isError && (
        <div style={{
          padding: 12, borderRadius: 8, border: `1px solid ${RED}33`,
          background: `${RED}0a`, fontSize: 13, color: RED,
        }}>
          Error: {(batchMutation.error as Error).message}
        </div>
      )}

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
        {[
          { label: 'Total Judged', value: o?.total_judged ?? 0, icon: Bot },
          { label: 'Avg Score', value: o?.avg_score ? `${Number(o.avg_score).toFixed(1)}/5` : 'N/A', icon: BarChart3 },
          { label: 'Good (4-5)', value: o?.good_count ?? 0, icon: Bot, color: GREEN },
          { label: 'Bad (1-2)', value: o?.bad_count ?? 0, icon: AlertTriangle, color: RED },
        ].map((s, i) => (
          <div key={i} style={{
            padding: 16, borderRadius: 8, border: `1px solid ${BORDER}`,
            textAlign: 'center',
          }}>
            <div style={{ fontSize: 11, color: MUTED, marginBottom: 4 }}>{s.label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: s.color ?? TEXT }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Per-dimension breakdown */}
      {stats?.by_dimension?.length > 0 && (
        <div>
          <h4 style={{ fontSize: 13, fontWeight: 600, color: TEXT, marginBottom: 8 }}>
            Per-Dimension Averages
          </h4>
          {stats.by_dimension.map((d: any) => (
            <ScoreBar key={d.dimension} label={d.dimension} score={Number(d.avg_score)} />
          ))}
        </div>
      )}

      {/* Recent bad traces */}
      {stats?.recent_bad?.length > 0 && (
        <div>
          <h4 style={{ fontSize: 13, fontWeight: 600, color: TEXT, marginBottom: 8 }}>
            Recent Low-Scoring Traces
          </h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {stats.recent_bad.map((t: any) => (
              <div key={t.trace_id} style={{
                padding: '10px 12px', borderRadius: 6,
                border: `1px solid ${RED}22`, background: `${RED}06`, fontSize: 13,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 12, color: MUTED }}>
                    {t.trace_id.substring(0, 20)}...
                  </span>
                  <span style={{ fontWeight: 600, color: RED }}>
                    {t.overall_score}/5 ({t.overall_label})
                  </span>
                </div>
                <div style={{ color: TEXT }}>{t.summary}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
