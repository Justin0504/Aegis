import { DashboardLayout } from '@/components/dashboard/layout'
import { ViolationsView } from '@/components/violations/violations-view'

export default function ViolationsPage() {
  return (
    <DashboardLayout>
      <ViolationsView />
    </DashboardLayout>
  )
}
