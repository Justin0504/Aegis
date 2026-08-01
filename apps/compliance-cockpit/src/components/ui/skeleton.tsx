/**
 * Skeleton — content-aware placeholders that reserve layout space
 * while data loads.
 *
 * Design intent: no shimmer, no gradient sweep, no animation drama.
 * A subtle `animate-pulse` on a muted background reads as "system
 * is working, real content is on its way" without pulling the eye
 * away from stable page chrome. Matches the site's minimalist feel.
 *
 * Prefer skeletons over "Loading..." text everywhere the layout can
 * be predicted (a table with 5 rows, a card with a stat + a
 * sparkline). Spinners are only correct for actions the user just
 * triggered — anything on mount should use a skeleton.
 */

import React from 'react'

interface SkeletonProps {
  className?: string
  /** Inline styles — accepts `width`, `height`, `borderRadius`, etc. */
  style?: React.CSSProperties
}

export function Skeleton({ className, style }: SkeletonProps) {
  return (
    <div
      className={`animate-pulse ${className ?? ''}`}
      style={{
        background: 'hsl(var(--secondary))',
        borderRadius: 6,
        ...style,
      }}
      aria-hidden="true"
    />
  )
}

/**
 * Row-shaped skeleton — used for lists (traces, sessions, alerts).
 * Renders `count` rows of the same height with subtle stagger to
 * avoid a wall-of-identical-blocks look.
 */
export function SkeletonRows({ count = 5, rowHeight = 44, className }: { count?: number; rowHeight?: number; className?: string }) {
  return (
    <div className={`space-y-1.5 ${className ?? ''}`}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton
          key={i}
          style={{
            height: rowHeight,
            opacity: 1 - i * 0.08,   // top-heaviest, fades as it descends
          }}
        />
      ))}
    </div>
  )
}

/**
 * Text-line skeleton — width in ch (character-widths) so it reads as
 * "something the length of a sentence" rather than a block. Useful
 * for placeholder headings + copy paragraphs.
 */
export function SkeletonText({ width = 40, height = 12, className }: { width?: number; height?: number; className?: string }) {
  return (
    <Skeleton
      className={className}
      style={{
        width: `${width}ch`,
        height,
        maxWidth: '100%',
      }}
    />
  )
}
