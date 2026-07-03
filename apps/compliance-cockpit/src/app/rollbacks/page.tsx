import { DashboardLayout } from '@/components/dashboard/layout'
import { RollbackApprovalsView } from '@/components/rollbacks/rollback-approvals-view'

export const dynamic = 'force-dynamic'

export default function RollbackApprovalsPage() {
  return (
    <DashboardLayout>
      <RollbackApprovalsView />
    </DashboardLayout>
  )
}
