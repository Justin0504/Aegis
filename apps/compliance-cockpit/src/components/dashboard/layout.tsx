'use client'

import { ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard, FileText, Shield,
  CheckCircle, AlertTriangle, Settings,
} from 'lucide-react'
import { useTraceStream } from '@/hooks/useTraceStream'

const navigation = [
  { name: 'Overview',   href: '/',           icon: LayoutDashboard },
  { name: 'Traces',     href: '/traces',     icon: FileText        },
  { name: 'Policies',   href: '/policies',   icon: Shield          },
  { name: 'Approvals',  href: '/approvals',  icon: CheckCircle     },
  { name: 'Violations', href: '/violations', icon: AlertTriangle   },
  { name: 'Settings',   href: '/settings',   icon: Settings        },
]

// Warm palette matching Claude's UI
const BG       = 'hsl(36 18% 93%)'   // sidebar bg — warm off-white
const MAIN_BG  = 'hsl(36 20% 95%)'  // main area
const BORDER   = 'hsl(36 12% 87%)'
const TEXT      = 'hsl(30 10% 20%)'
const MUTED     = 'hsl(30 8% 50%)'
const ACTIVE_BG = 'hsl(36 14% 87%)'
const GOLD      = 'hsl(38 20% 42%)'

export function DashboardLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const { connected, lastUpdate } = useTraceStream()

  return (
    <div className="flex h-screen" style={{ background: MAIN_BG }}>
      {/* Sidebar */}
      <aside
        className="hidden md:flex md:flex-col w-56 flex-shrink-0 border-r"
        style={{ background: BG, borderColor: BORDER }}
      >
        {/* Logo */}
        <div className="flex items-center px-4 py-5">
          <span
            className="font-bold uppercase"
            style={{
              fontSize: '20px',
              letterSpacing: '0.06em',
              background: 'linear-gradient(120deg, #000 0%, #888 35%, #fff 55%, #555 75%, #000 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}
          >
            AEGIS
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-1 space-y-0.5">
          {navigation.map((item) => {
            const isActive = pathname === item.href
            return (
              <Link
                key={item.name}
                href={item.href}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors duration-100',
                  isActive ? 'font-medium' : 'font-normal'
                )}
                style={{
                  background: isActive ? ACTIVE_BG : 'transparent',
                  color: isActive ? TEXT : MUTED,
                }}
                onMouseEnter={e => {
                  if (!isActive)(e.currentTarget as HTMLElement).style.background = ACTIVE_BG
                }}
                onMouseLeave={e => {
                  if (!isActive)(e.currentTarget as HTMLElement).style.background = 'transparent'
                }}
              >
                <item.icon
                  className="h-4 w-4 flex-shrink-0"
                  style={{ color: isActive ? TEXT : MUTED, opacity: isActive ? 1 : 0.7 }}
                />
                {item.name}
              </Link>
            )
          })}
        </nav>

        {/* Footer */}
        <div className="px-4 py-4 border-t space-y-2" style={{ borderColor: BORDER }}>
          {/* Live indicator */}
          <div className="flex items-center gap-1.5">
            <span
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{
                background: connected ? 'hsl(150 18% 44%)' : 'hsl(30 8% 60%)',
                boxShadow: connected ? '0 0 0 2px hsl(150 18% 44% / 0.25)' : 'none',
              }}
            />
            <span className="text-[11px]" style={{ color: connected ? 'hsl(150 18% 40%)' : 'hsl(30 8% 55%)' }}>
              {connected ? 'Live' : 'Connecting…'}
            </span>
            {lastUpdate && (
              <span className="text-[10px] ml-auto" style={{ color: 'hsl(30 8% 62%)' }}>
                {lastUpdate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            )}
          </div>
          <p className="text-[11px]" style={{ color: 'hsl(30 8% 60%)' }}>v1.1.8</p>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex flex-col flex-1 overflow-hidden">
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-7xl mx-auto px-8 py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}
