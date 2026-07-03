'use client'

import { ReactNode, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard, FileText, Shield, ScrollText, Sparkles,
  CheckCircle, AlertTriangle, Settings, FlaskConical,
  ShieldHalf, Compass, ClipboardList, UserRound, Layers, FileCheck2,
  ScanLine, Menu, X, Wrench, ChevronDown, Brain, Undo2,
} from 'lucide-react'
import { useTraceStream } from '@/hooks/useTraceStream'
import { BlockAlertToast } from '@/components/ui/block-alert-toast'
import { StatusBar } from '@/components/dashboard/status-bar'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import { AccountWidget } from '@/components/dashboard/account-widget'

// Primary nav — what an ops / compliance user uses 90% of the time.
const navigation = [
  { name: 'Overview',    href: '/',           icon: LayoutDashboard },
  { name: 'Activity',    href: '/traces',     icon: FileText        },
  { name: 'Approvals',   href: '/approvals',  icon: CheckCircle     },
  { name: 'Rollbacks',   href: '/rollbacks',  icon: Undo2           },
  { name: 'Violations',  href: '/violations', icon: AlertTriangle   },
  { name: 'Agents',      href: '/agents',     icon: UserRound       },
  { name: 'Policies',    href: '/policies',   icon: Shield          },
  { name: 'Coverage',    href: '/coverage',   icon: Layers          },
  { name: 'Memory',      href: '/memory',     icon: Brain           },
  { name: 'Audit Log',   href: '/audit-log',  icon: ClipboardList   },
  { name: 'Compliance',  href: '/compliance', icon: FileCheck2      },
  { name: 'Settings',    href: '/settings',   icon: Settings        },
]

// Developer / setup tools — folded by default. Ops users rarely open these.
const developerNav = [
  { name: 'Welcome / Install', href: '/welcome',     icon: Sparkles    },
  { name: 'Policy DSL',        href: '/dsl',         icon: ScrollText  },
  { name: 'Code Shield',       href: '/code-shield', icon: ShieldHalf  },
  { name: 'Pre-Deploy Scan',   href: '/scan',        icon: ScanLine    },
  { name: 'Alignment',         href: '/alignment',   icon: Compass     },
  { name: 'Playground',        href: '/playground',  icon: FlaskConical},
]

const DEV_PATHS = new Set(developerNav.map(i => i.href))

// All values resolve from CSS variables in globals.css (:root). Edit the
// palette there to retheme the entire Cockpit — nothing else to change.
const BG        = 'hsl(var(--sidebar))'
const MAIN_BG   = 'hsl(var(--background))'
const BORDER    = 'hsl(var(--border))'
const TEXT      = 'hsl(var(--foreground))'
const MUTED     = 'hsl(var(--muted-foreground))'
const ACTIVE_BG = 'hsl(var(--sidebar-active))'

function AegisLogo() {
  // Pure monochrome wordmark — no tinted shield, no decorative slash.
  // Name only, set in display weight + tight tracking.
  return (
    <svg width="92" height="22" viewBox="0 0 92 22" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="AEGIS">
      <text
        x="0"
        y="17"
        fontFamily="var(--font-plus-jakarta), system-ui, sans-serif"
        fontWeight="800"
        fontSize="18"
        letterSpacing="2"
        fill="hsl(var(--foreground))"
      >
        AEGIS
      </text>
    </svg>
  )
}

type NavItem = { name: string; href: string; icon: typeof LayoutDashboard }

function NavLink({ item, pathname, onLinkClick, depth = 0 }: {
  item: NavItem; pathname: string; onLinkClick?: () => void; depth?: number
}) {
  const isActive = pathname === item.href
  return (
    <Link
      href={item.href}
      onClick={onLinkClick}
      className={cn(
        'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors duration-100',
        isActive ? 'font-medium' : 'font-normal'
      )}
      style={{
        background: isActive ? ACTIVE_BG : 'transparent',
        color:      isActive ? TEXT      : MUTED,
        paddingLeft: depth > 0 ? '1.75rem' : undefined,
      }}
      onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = ACTIVE_BG }}
      onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
    >
      <item.icon
        className="h-4 w-4 flex-shrink-0"
        style={{ color: isActive ? TEXT : MUTED, opacity: isActive ? 1 : 0.7 }}
      />
      {item.name}
    </Link>
  )
}

function DeveloperFold({ pathname, onLinkClick }: { pathname: string; onLinkClick?: () => void }) {
  // Auto-open if the current route is one of the developer items.
  const initiallyOpen = DEV_PATHS.has(pathname)
  const [open, setOpen] = useState(initiallyOpen)
  return (
    <div className="pt-2 mt-2 border-t" style={{ borderColor: BORDER }}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors duration-100"
        style={{ color: MUTED }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = ACTIVE_BG }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
      >
        <Wrench className="h-4 w-4 flex-shrink-0" style={{ opacity: 0.7 }} />
        <span>Developer</span>
        <ChevronDown
          className="h-3.5 w-3.5 ml-auto transition-transform duration-150"
          style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', opacity: 0.6 }}
        />
      </button>
      {open && (
        <div className="space-y-0.5 mt-0.5">
          {developerNav.map(item => (
            <NavLink key={item.name} item={item} pathname={pathname} onLinkClick={onLinkClick} depth={1} />
          ))}
        </div>
      )}
    </div>
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
      <nav className="flex-1 overflow-y-auto px-2 py-1 space-y-0.5">
        {navigation.map(item => (
          <NavLink key={item.name} item={item} pathname={pathname} onLinkClick={onLinkClick} />
        ))}
        <DeveloperFold pathname={pathname} onLinkClick={onLinkClick} />
      </nav>

      {/* Footer */}
      <div className="px-4 py-4 border-t space-y-2" style={{ borderColor: BORDER }}>
        <div className="flex items-center gap-1.5">
          <span
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{
              background: connected ? 'hsl(150 18% 44%)' : 'hsl(0 0% 60%)',
              boxShadow: connected ? '0 0 0 2px hsl(150 18% 44% / 0.25)' : 'none',
            }}
          />
          <span className="text-[11px]" style={{ color: connected ? 'hsl(150 18% 40%)' : 'hsl(var(--muted-foreground))' }}>
            {connected ? 'Live' : 'Connecting\u2026'}
          </span>
          {lastUpdate && (
            <span
              className="text-[10px] ml-auto"
              style={{ color: MUTED, opacity: 0.7 }}
              suppressHydrationWarning
            >
              {lastUpdate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
        </div>
        {notifPermission !== 'granted' && (
          <button
            onClick={requestNotifPermission}
            className="w-full text-left text-[11px] px-2 py-1 rounded border transition-colors hover:opacity-80"
            style={{
              background:  'transparent',
              borderColor: notifPermission === 'denied' ? 'hsl(0 30% 80%)' : BORDER,
              color:       notifPermission === 'denied' ? 'hsl(0 40% 50%)' : MUTED,
            }}
            title={notifPermission === 'denied' ? 'Blocked in browser \u2014 enable in System Settings' : 'Get notified even when this tab is in background'}
          >
            {notifPermission === 'denied' ? 'Notifications blocked' : 'Enable notifications'}
          </button>
        )}
        <ThemeToggle />
        <AccountWidget />
        <p className="text-[11px]" style={{ color: MUTED, opacity: 0.85 }}>v{process.env.APP_VERSION}</p>
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
              background: connected ? 'hsl(150 18% 44%)' : 'hsl(0 0% 60%)',
              boxShadow: connected ? '0 0 0 2px hsl(150 18% 44% / 0.25)' : 'none',
            }}
          />
          <span className="text-[10px]" style={{ color: connected ? 'hsl(150 18% 40%)' : 'hsl(var(--muted-foreground))' }}>
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
        {/* Live status bar — protected | traces | blocked | pending */}
        <div className="pt-14 md:pt-0">
          <StatusBar />
        </div>
        <main className="flex-1 overflow-y-auto">
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
