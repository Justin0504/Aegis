'use client'

import { useQuery } from '@tanstack/react-query'
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from 'recharts'

const COLORS = {
  APPROVED: '#10b981',
  REJECTED: '#ef4444',
  PENDING: '#f59e0b',
  AUTO_APPROVED: '#22c55e',
}

export function ApprovalStats() {
  const { data } = useQuery({
    queryKey: ['approval-stats'],
    queryFn: async () => {
      // Mock data for now
      return [
        { name: 'Approved', value: 234 },
        { name: 'Auto-Approved', value: 456 },
        { name: 'Rejected', value: 45 },
        { name: 'Pending', value: 12 },
      ]
    },
  })

  return (
    <div className="space-y-4">
      <ResponsiveContainer width="100%" height={300}>
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            labelLine={false}
            outerRadius={80}
            fill="#8884d8"
            dataKey="value"
          >
            {data?.map((entry: any, index: number) => (
              <Cell
                key={`cell-${index}`}
                fill={
                  COLORS[entry.name.toUpperCase().replace('-', '_') as keyof typeof COLORS]
                }
              />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              backgroundColor: 'hsl(var(--background))',
              border: '1px solid hsl(var(--border))',
              borderRadius: '6px',
            }}
          />
          <Legend />
        </PieChart>
      </ResponsiveContainer>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Average Response Time</span>
          <span className="text-sm text-muted-foreground">2.5 minutes</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Approval Rate</span>
          <span className="text-sm text-muted-foreground">92.3%</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Critical Pending</span>
          <span className="text-sm font-medium text-destructive">3</span>
        </div>
      </div>
    </div>
  )
}