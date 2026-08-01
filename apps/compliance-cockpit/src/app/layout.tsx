import type { Metadata } from 'next'
import { GeistMono } from 'geist/font/mono'
import { Inter, Instrument_Serif, Plus_Jakarta_Sans } from 'next/font/google'
import './globals.css'
import { Providers } from '@/components/providers'
import { FirstLaunchGate } from '@/components/first-launch-gate'

// Body / UI — Söhne substitute
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  weight: ['300', '400', '500', '600', '700'],
  display: 'swap',
})

// Display / large headings — Tiempos substitute
const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  variable: '--font-serif',
  weight: ['400'],
  style: ['normal', 'italic'],
  display: 'swap',
})

// Retained only for the AEGIS wordmark in the sidebar (uses weight 800/900)
const plusJakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-plus-jakarta',
  weight: ['700', '800'],
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'AEGIS — AI Agent Intelligence & Security',
  description: 'Real-time monitoring and auditing for AI agents',
  icons: { icon: '/aegis-logo.png', apple: '/aegis-logo.png' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${instrumentSerif.variable} ${GeistMono.variable} ${plusJakarta.variable}`}
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
      <body style={{ fontFamily: 'var(--font-inter), -apple-system, BlinkMacSystemFont, system-ui, sans-serif' }}>
        <Providers>
          <FirstLaunchGate />
          {children}
        </Providers>
      </body>
    </html>
  )
}
