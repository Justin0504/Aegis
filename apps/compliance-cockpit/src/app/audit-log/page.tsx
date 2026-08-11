import { DashboardLayout } from '@/components/dashboard/layout'
import { AuditLogView } from '@/components/audit-log/audit-log-view'
import { TierGate } from '@/components/pro-features/tier-gate'

export const metadata = {
  title: 'Audit Log · AEGIS',
  description: 'Tamper-evident record of every config change, decision, and audit.',
}

export default function AuditLogPage() {
  return (
    <DashboardLayout>
      <TierGate
        requires="team"
        feature="The cryptographic audit log"
        description="Merkle-chained per-row hash, Sigstore witness cosignature, and Ed25519-signed evidence pack export. Required for PCI-DSS Req 10 + SOC 2 CC7.2 evidence. Team+ tier."
      >
        <AuditLogView />
      </TierGate>
    </DashboardLayout>
  )
}
