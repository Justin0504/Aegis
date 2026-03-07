'use client'

import { ReactNode, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard, FileText, Shield,
  CheckCircle, AlertTriangle, Settings, FlaskConical,
  Menu, X,
} from 'lucide-react'
import { useTraceStream } from '@/hooks/useTraceStream'
import { BlockAlertToast } from '@/components/ui/block-alert-toast'

const navigation = [
  { name: 'Overview',    href: '/',            icon: LayoutDashboard },
  { name: 'Traces',      href: '/traces',      icon: FileText        },
  { name: 'Policies',    href: '/policies',    icon: Shield          },
  { name: 'Approvals',   href: '/approvals',   icon: CheckCircle     },
  { name: 'Violations',  href: '/violations',  icon: AlertTriangle   },
  { name: 'Playground',  href: '/playground',  icon: FlaskConical    },
  { name: 'Settings',    href: '/settings',    icon: Settings        },
]

// Warm palette matching Claude's UI
const BG       = 'hsl(36 18% 93%)'   // sidebar bg — warm off-white
const MAIN_BG  = 'hsl(36 20% 95%)'  // main area
const BORDER   = 'hsl(36 12% 87%)'
const TEXT      = 'hsl(30 10% 20%)'
const MUTED     = 'hsl(30 8% 50%)'
const ACTIVE_BG = 'hsl(36 14% 87%)'

function AegisLogo() {
  return (
    <svg width="100" height="32" viewBox="0 0 100 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 4 L20 4 L22 8 L22 20 Q22 26 16 28 Q10 26 10 20 L10 8 Z" fill="hsl(38 20% 42%)" opacity="0.12" />
      <text x="2" y="23" fontFamily="var(--font-plus-jakarta), system-ui, sans-serif" fontWeight="900" fontStyle="italic" fontSize="26" letterSpacing="3" fill="hsl(30 10% 18%)">AEGIS</text>
      <line x1="46" y1="6" x2="56" y2="26" stroke="hsl(38 22% 46%)" strokeWidth="2.5" strokeLinecap="round" opacity="0.7" />
      <line x1="2" y1="28" x2="88" y2="28" stroke="hsl(38 20% 42%)" strokeWidth="1" opacity="0.25" />
      <line x1="2" y1="28" x2="32" y2="28" stroke="hsl(38 20% 42%)" strokeWidth="1.5" opacity="0.5" />
    </svg>
  )
}

function SidebarContent({ pathname, connected, lastUpdate, notifPermission, requestNotifPermission, onLinkClick }: {
  pathname: string
  connected: boolean
  lastUpdate: Date | null
  notifPermission: NotificationPermission | 'default'
  requestNotifPermission: () => void
  onLinkClick?: () => void
}) {
  return (
    <>
      {/* Logo */}
      <div className="flex items-center px-4 py-5">
        <AegisLogo />
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-1 space-y-0.5">
        {navigation.map((item) => {
          const isActive = pathname === item.href
          return (
            <Link
              key={item.name}
              href={item.href}
              onClick={onLinkClick}
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
        <div className="flex items-center gap-1.5">
          <span
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{
              background: connected ? 'hsl(150 18% 44%)' : 'hsl(30 8% 60%)',
              boxShadow: connected ? '0 0 0 2px hsl(150 18% 44% / 0.25)' : 'none',
            }}
          />
          <span className="text-[11px]" style={{ color: connected ? 'hsl(150 18% 40%)' : 'hsl(30 8% 55%)' }}>
            {connected ? 'Live' : 'Connecting\u2026'}
          </span>
          {lastUpdate && (
            <span className="text-[10px] ml-auto" style={{ color: 'hsl(30 8% 62%)' }}>
              {lastUpdate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
        </div>
        {notifPermission !== 'granted' && (
          <button
            onClick={requestNotifPermission}
            className="w-full text-left text-[11px] px-2 py-1 rounded transition-opacity hover:opacity-70"
            style={{
              background:  notifPermission === 'denied' ? 'hsl(0 10% 95%)' : 'hsl(36 14% 90%)',
              color:       notifPermission === 'denied' ? 'hsl(0 14% 50%)' : 'hsl(30 10% 35%)',
            }}
            title={notifPermission === 'denied' ? 'Blocked in browser \u2014 enable in System Settings' : 'Get notified even when this tab is in background'}
          >
            {notifPermission === 'denied' ? 'Notifications blocked' : 'Enable notifications'}
          </button>
        )}
        <p className="text-[11px]" style={{ color: 'hsl(30 8% 60%)' }}>v{process.env.APP_VERSION}</p>
      </div>
    </>
  )
}

export function DashboardLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)
  const { connected, lastUpdate, alerts, dismissAlert, notifPermission, requestNotifPermission } = useTraceStream()

  const sidebarProps = { pathname, connected, lastUpdate, notifPermission, requestNotifPermission }

  return (
    <div className="flex h-screen" style={{ background: MAIN_BG }}>
      {/* Desktop sidebar */}
      <aside
        className="hidden md:flex md:flex-col w-56 flex-shrink-0 border-r"
        style={{ background: BG, borderColor: BORDER }}
      >
        <SidebarContent {...sidebarProps} />
      </aside>

      {/* Mobile header */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-40 flex items-center px-4 h-14 border-b"
        style={{ background: BG, borderColor: BORDER }}
      >
        <button
          onClick={() => setMobileOpen(true)}
          className="p-1.5 rounded-lg"
          style={{ color: TEXT }}
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="ml-3">
          <AegisLogo />
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{
              background: connected ? 'hsl(150 18% 44%)' : 'hsl(30 8% 60%)',
              boxShadow: connected ? '0 0 0 2px hsl(150 18% 44% / 0.25)' : 'none',
            }}
          />
          <span className="text-[10px]" style={{ color: connected ? 'hsl(150 18% 40%)' : 'hsl(30 8% 55%)' }}>
            {connected ? 'Live' : '…'}
          </span>
        </div>
      </div>

      {/* Mobile sidebar overlay */}
      {mobileOpen && (
        <>
          <div
            className="md:hidden fixed inset-0 z-50 bg-black/30"
            onClick={() => setMobileOpen(false)}
          />
          <aside
            className="md:hidden fixed inset-y-0 left-0 z-50 flex flex-col w-64 border-r shadow-xl"
            style={{ background: BG, borderColor: BORDER }}
          >
            <div className="flex items-center justify-end px-4 pt-4">
              <button
                onClick={() => setMobileOpen(false)}
                className="p-1.5 rounded-lg"
                style={{ color: MUTED }}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <SidebarContent {...sidebarProps} onLinkClick={() => setMobileOpen(false)} />
          </aside>
        </>
      )}

      {/* Main content */}
      <div className="flex flex-col flex-1 overflow-hidden">
        <main className="flex-1 overflow-y-auto pt-14 md:pt-0">
          <div className="max-w-7xl mx-auto px-4 py-6 md:px-8 md:py-8">
            {children}
          </div>
        </main>
      </div>

      {/* Block alert toasts */}
      <BlockAlertToast alerts={alerts} dismissAlert={dismissAlert} />
    </div>
  )
}
