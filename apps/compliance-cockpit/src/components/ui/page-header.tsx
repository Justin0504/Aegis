/**
 * The one page header.
 *
 * Every view used to set its own title size, weight, margin and width, so
 * moving between pages felt like moving between products. The title is
 * the sidebar's word for the page; the subtitle says what the page is
 * for in one sentence; actions sit on the right, primary one last.
 */
import type { ReactNode } from 'react'

export function PageHeader({ title, subtitle, actions, children }: {
  title: string
  subtitle?: ReactNode
  actions?: ReactNode
  /** Optional row under the title: tabs, filters, a search box. */
  children?: ReactNode
}) {
  return (
    <header className="mb-6">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.02em]" style={{ color: 'hsl(var(--foreground))' }}>
            {title}
          </h1>
          {subtitle && (
            <p className="mt-1.5 text-[14.5px] leading-snug max-w-[68ch]" style={{ color: 'hsl(var(--muted-foreground))' }}>
              {subtitle}
            </p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2 flex-shrink-0 pt-1">{actions}</div>}
      </div>
      {children && <div className="mt-5">{children}</div>}
    </header>
  )
}
