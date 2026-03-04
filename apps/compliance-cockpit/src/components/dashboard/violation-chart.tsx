'use client'

import { useQuery } from '@tanstack/react-query'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'

export function ViolationChart() {
  const { data } = useQuery({
    queryKey: ['violation-stats'],
    queryFn: async () => {
      // Mock data for now
      return [
        { policy: 'SQL Injection', count: 12, risk: 'HIGH' },
        { policy: 'File Access', count: 23, risk: 'MEDIUM' },
        { policy: 'Network Access', count: 8, risk: 'MEDIUM' },
        { policy: 'Command Injection', count: 5, risk: 'CRITICAL' },
        { policy: 'Data Exposure', count: 15, risk: 'HIGH' },
      ]
    },
  })

  return (
    <ResponsiveContainer width="100%" height={350}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis
          dataKey="policy"
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
        <Legend />
        <Bar
          dataKey="count"
          fill="hsl(var(--destructive))"
          radius={[4, 4, 0, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  )
}