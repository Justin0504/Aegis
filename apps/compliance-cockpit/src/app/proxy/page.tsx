import { DashboardLayout } from '@/components/dashboard/layout'
import { ProxyWizard } from '@/components/proxy/proxy-wizard'

export default function ProxyPage() {
  return (
    <DashboardLayout>
      <ProxyWizard />
    </DashboardLayout>
  )
}
