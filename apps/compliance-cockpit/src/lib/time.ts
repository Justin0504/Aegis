/**
 * One way to say when something happened.
 *
 * Gateway timestamps are UTC, sometimes without the trailing Z. Every
 * view used to format them its own way ("10/16/2026, 7:54:41 PM" next to
 * "Oct 16, 2026 at 7:54 PM" next to "less than a minute ago"), which reads
 * as three products. These are the only two formats:
 *
 *   fmtWhen   — for lists and cards: "just now", "4 min ago", "7:54 PM"
 *               (today), "Oct 16, 7:54 PM" (this year), "Oct 16, 2025".
 *   fmtClock  — for a timeline inside one run: "7:54:41 PM".
 */

export function parseTs(ts: string | number | Date | null | undefined): Date | null {
  if (ts == null || ts === '') return null
  if (ts instanceof Date) return isNaN(ts.getTime()) ? null : ts
  if (typeof ts === 'number') return new Date(ts < 1e12 ? ts * 1000 : ts)
  const s = String(ts).trim()
  // "2026-10-16 19:54:41" or "...T19:54:41" with no zone → UTC
  const naive = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)
  const d = new Date(naive ? s.replace(' ', 'T') + 'Z' : s)
  return isNaN(d.getTime()) ? null : d
}

export function fmtWhen(ts: string | number | Date | null | undefined, now: Date = new Date()): string {
  const d = parseTs(ts)
  if (!d) return ''
  const diff = now.getTime() - d.getTime()
  if (diff >= 0 && diff < 45_000) return 'just now'
  if (diff >= 0 && diff < 60 * 60_000) return `${Math.max(1, Math.round(diff / 60_000))} min ago`
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const sameYear = d.getFullYear() === now.getFullYear()
  if (sameYear) {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' +
      d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

export function fmtClock(ts: string | number | Date | null | undefined): string {
  const d = parseTs(ts)
  return d ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : ''
}

/** Full timestamp for tooltips and exports: "Oct 16, 2026, 7:54:41 PM". */
export function fmtFull(ts: string | number | Date | null | undefined): string {
  const d = parseTs(ts)
  return d ? d.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }) : ''
}
