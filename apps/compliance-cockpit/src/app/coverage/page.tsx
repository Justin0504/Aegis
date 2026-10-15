import { DashboardLayout } from '@/components/dashboard/layout'
import { CoverageView } from '@/components/coverage/coverage-view'
import { Security360 } from '@/components/coverage/security-360'
import { TierGate } from '@/components/pro-features/tier-gate'

export default function CoveragePage() {
  return (
    <DashboardLayout>
      <div className="space-y-8">
        <header>
          <h1 className="text-3xl font-bold tracking-tight">Security 360</h1>
          <p className="mt-1 text-[15px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
            Every way an agent can be turned against you, and whether this deployment covers it right now.
          </p>
        </header>
        <Security360 />
        <TierGate
          requires="team"
          feature="The policy coverage report"
          description="Threat-ontology map of which attack tactics your active policies actually catch — auditors love this. Team+ tier."
        >
          <CoverageView />
        </TierGate>
      </div>
    </DashboardLayout>
  )
}
