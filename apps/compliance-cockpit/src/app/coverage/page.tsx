import { DashboardLayout } from '@/components/dashboard/layout'
import { CoverageView } from '@/components/coverage/coverage-view'
import { TierGate } from '@/components/pro-features/tier-gate'

export default function CoveragePage() {
  return (
    <DashboardLayout>
      <TierGate
        requires="team"
        feature="The policy coverage report"
        description="Threat-ontology map of which attack tactics your active policies actually catch — auditors love this. Team+ tier."
      >
        <CoverageView />
      </TierGate>
    </DashboardLayout>
  )
}
