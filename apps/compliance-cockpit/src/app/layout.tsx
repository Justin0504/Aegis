import type { Metadata } from 'next'
import { GeistMono } from 'geist/font/mono'
import { GeistSans } from 'geist/font/sans'
import './globals.css'
import { Providers } from '@/components/providers'
import { FirstLaunchGate } from '@/components/first-launch-gate'

// One UI face (Geist) for everything but code; the serif display face
// and the wordmark font are gone — identity comes from spacing and weight.
export const metadata: Metadata = {
  title: 'AEGIS — AI Agent Intelligence & Security',
  description: 'Real-time monitoring and auditing for AI agents',
  icons: { icon: '/aegis-logo.png', apple: '/aegis-logo.png' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/*
         * No-flash theme bootstrap — moved from `dangerouslySetInnerHTML`
         * to a static asset at /theme-bootstrap.js so React can never
         * template user input into the script body. The file is served
         * with the standard Next.js public/ MIME + same-origin headers,
         * runs before paint, and sets .dark / .light on <html>.
         */}
        <script src="/theme-bootstrap.js" />
      </head>
      <body style={{ fontFamily: 'var(--font-geist-sans), -apple-system, BlinkMacSystemFont, system-ui, sans-serif' }}>
        <Providers>
          <FirstLaunchGate />
          {children}
        </Providers>
      </body>
    </html>
  )
}
