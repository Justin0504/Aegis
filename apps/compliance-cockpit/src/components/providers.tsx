'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { Toaster } from 'sonner'
import { FirstRunGuard } from '@/components/onboarding/first-run-guard'
import { CommandPalette } from '@/components/command-palette'

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            retry: 1,
            staleTime: 5 * 1000,
          },
        },
      })
  )

  return (
    <QueryClientProvider client={queryClient}>
      <FirstRunGuard />
      <CommandPalette />
      {children}
      <Toaster
        position="bottom-right"
        richColors
        duration={5000}
        toastOptions={{
          style: {
            fontFamily: 'var(--font-geist-sans), system-ui, sans-serif',
            fontSize: '13px',
          },
        }}
      />
    </QueryClientProvider>
  )
}