import { Suspense } from 'react'
import { DashboardLayout } from '@/components/dashboard/layout'
import { PlaygroundView } from '@/components/playground/playground-view'

export default function PlaygroundPage() {
  return (
    <DashboardLayout>
      <Suspense>
        <PlaygroundView />
      </Suspense>
    </DashboardLayout>
  )
}
