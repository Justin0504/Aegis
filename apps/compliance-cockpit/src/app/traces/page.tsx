import { DashboardLayout } from '@/components/dashboard/layout'
import { TracesView } from '@/components/traces/traces-view'

export default function TracesPage() {
  return (
    <DashboardLayout>
      <TracesView />
    </DashboardLayout>
  )
}