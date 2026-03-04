'use client'

import { useQuery } from '@tanstack/react-query'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

export function AgentActivity() {
  const { data } = useQuery({
    queryKey: ['agent-activity'],
    queryFn: async () => {
      // Mock data for now
      const now = new Date()
      return Array.from({ length: 24 }, (_, i) => ({
        time: new Date(now.getTime() - (23 - i) * 60 * 60 * 1000)
          .toISOString()
          .substring(11, 16),
        traces: Math.floor(Math.random() * 100) + 50,
      }))
    },
    refetchInterval: 60000, // Refresh every minute
  })

  return (
    <ResponsiveContainer width="100%" height={350}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis
          dataKey="time"
          className="text-xs"
          tick={{ fill: 'currentColor' }}
        />
        <YAxis className="text-xs" tick={{ fill: 'currentColor' }} />
        <Tooltip
          contentStyle={{
            backgroundColor: 'hsl(var(--background))',
            border: '1px solid hsl(var(--border))',
            borderRadius: '6px',
          }}
        />
        <Line
          type="monotone"
          dataKey="traces"
          stroke="hsl(var(--primary))"
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}