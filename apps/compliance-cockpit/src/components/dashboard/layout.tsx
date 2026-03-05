'use client'

import { ReactNode } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard,
  FileText,
  Shield,
  CheckCircle,
  AlertTriangle,
  Settings,
} from 'lucide-react'

const navigation = [
  { name: 'Overview',   href: '/',           icon: LayoutDashboard },
  { name: 'Traces',     href: '/traces',     icon: FileText },
  { name: 'Policies',   href: '/policies',   icon: Shield },
  { name: 'Approvals',  href: '/approvals',  icon: CheckCircle },
  { name: 'Violations', href: '/violations', icon: AlertTriangle },
  { name: 'Settings',   href: '/settings',   icon: Settings },
]

export function DashboardLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname()

  return (
    <div className="flex h-screen" style={{ background: 'hsl(0 0% 7%)' }}>
      {/* Sidebar */}
      <aside
        className="hidden md:flex md:flex-col w-56 flex-shrink-0 border-r"
        style={{ background: 'hsl(0 0% 9%)', borderColor: 'hsl(0 0% 14%)' }}
      >
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-4 py-5 border-b" style={{ borderColor: 'hsl(0 0% 14%)' }}>
          <Image
            src="/aegis-logo.png"
            alt="AEGIS"
            width={28}
            height={28}
            className="flex-shrink-0"
            style={{ filter: 'drop-shadow(0 0 4px rgba(201,168,76,0.4))' }}
          />
          <span
            className="text-sm font-bold tracking-[0.18em] uppercase"
            style={{ color: 'hsl(43 56% 60%)', letterSpacing: '0.18em' }}
          >
            AEGIS
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-4 space-y-0.5">
          {navigation.map((item) => {
            const isActive = pathname === item.href
            return (
              <Link
                key={item.name}
                href={item.href}
                className={cn(
                  'group flex items-center gap-2.5 px-3 py-2 rounded text-sm transition-all duration-150',
                  isActive
                    ? 'text-[hsl(43,56%,60%)]'
                    : 'text-[hsl(0,0%,50%)] hover:text-[hsl(0,0%,80%)]'
                )}
                style={
                  isActive
                    ? { background: 'hsl(43 56% 52% / 0.1)' }
                    : undefined
                }
                onMouseEnter={(e) => {
                  if (!isActive) {
                    (e.currentTarget as HTMLElement).style.background = 'hsl(0 0% 14%)'
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    (e.currentTarget as HTMLElement).style.background = ''
                  }
                }}
              >
                <item.icon
                  className="flex-shrink-0 h-4 w-4"
                  style={{ color: isActive ? 'hsl(43 56% 60%)' : undefined }}
                />
                <span className="font-medium">{item.name}</span>
                {isActive && (
                  <span
                    className="ml-auto w-1 h-1 rounded-full"
                    style={{ background: 'hsl(43 56% 60%)' }}
                  />
                )}
              </Link>
            )
          })}
        </nav>

        {/* Footer */}
        <div className="px-4 py-4 border-t" style={{ borderColor: 'hsl(0 0% 14%)' }}>
          <p className="text-[10px] font-medium tracking-widest uppercase" style={{ color: 'hsl(0 0% 28%)' }}>
            v1.1.5
          </p>
        </div>
      </aside>

      {/* Main */}
      <div className="flex flex-col flex-1 overflow-hidden">
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-7xl mx-auto px-6 py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}
