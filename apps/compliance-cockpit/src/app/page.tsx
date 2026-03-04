import { DashboardLayout } from '@/components/dashboard/layout'
import { DashboardOverview } from '@/components/dashboard/overview'

export default function HomePage() {
  return (
    <DashboardLayout>
      <DashboardOverview />
    </DashboardLayout>
  )
}