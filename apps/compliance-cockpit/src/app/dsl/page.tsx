import { DashboardLayout } from '@/components/dashboard/layout'
import { DslEditorView } from '@/components/dsl/dsl-editor-view'
import { TierGate } from '@/components/pro-features/tier-gate'

export default function DslPage() {
  return (
    <DashboardLayout>
      <TierGate
        requires="pro"
        feature="The Policy DSL editor"
        description="Author custom deterministic + LLM-judge policies with autocomplete, dry-run, and AI-assisted rule generation. Free tier ships pre-built community packs; Pro unlocks the editor."
      >
        <DslEditorView />
      </TierGate>
    </DashboardLayout>
  )
}
