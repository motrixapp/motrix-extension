import type * as React from 'react'

/**
 * Shared chrome for one settings block. Renders a sunken, softly-lit panel
 * (brainwave-inspired) with a consistent title + content rhythm so every
 * section reads as a sibling card rather than a free-floating form.
 *
 * No `className` prop on purpose: twMerge would let a caller's `bg-*`/`shadow-*`
 * silently strip the panel's signature surface + inset shadow. Variants, if ever
 * needed, belong on an inner wrapper, never on this chrome-bearing <section>.
 */
export function SettingPanel({
  title,
  description,
  children,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section className="rounded-2xl border border-border/60 bg-card px-5 py-4 shadow-inset-panel">
      <div className="mb-3.5">
        <h2 className="text-[0.9375rem] font-semibold tracking-tight text-foreground">
          {title}
        </h2>
        {description != null && (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

/**
 * Matches the look of the shadcn <Input> for native <select>/<textarea>
 * controls that don't have a dedicated component, so fields stay consistent.
 */
export const fieldClass =
  'h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50'

/**
 * Shared label-column width so every panel's controls line up on the same
 * x-offset. w-36 fits the longest label ("Minimum size (MB)") on one line.
 */
export const labelColClass = 'w-36 shrink-0 text-muted-foreground'
