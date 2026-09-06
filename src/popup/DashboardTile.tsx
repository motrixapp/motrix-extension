import type { LucideIcon } from 'lucide-react'
import type { MouseEventHandler, ReactNode } from 'react'

import { cn } from '@/lib/utils'

interface DashboardTileCommonProps {
  label: string
  value: string | number
  unit?: string
  icon?: LucideIcon
  iconClassName?: string
  className?: string
  decoration?: ReactNode
  testId?: string
}

interface StaticDashboardTileProps extends DashboardTileCommonProps {
  onClick?: undefined
  ariaLabel?: string
  disabled?: never
}

interface InteractiveDashboardTileProps extends DashboardTileCommonProps {
  onClick: MouseEventHandler<HTMLButtonElement>
  ariaLabel: string
  disabled?: boolean
}

export type DashboardTileProps =
  | StaticDashboardTileProps
  | InteractiveDashboardTileProps

function DashboardTileContent({
  label,
  value,
  unit,
  icon: Icon,
  iconClassName,
  decoration,
}: DashboardTileCommonProps): React.ReactElement {
  return (
    <>
      <span className="flex min-w-0 items-start justify-between gap-1">
        <span className="min-w-0 text-[9px]/3 font-medium text-muted-foreground [overflow-wrap:anywhere]">
          {label}
        </span>
        {Icon ? (
          <Icon
            aria-hidden="true"
            data-slot="dashboard-tile-icon"
            className={cn('size-4 shrink-0', iconClassName)}
            strokeWidth={2}
          />
        ) : null}
      </span>
      <span
        data-slot="dashboard-tile-value-row"
        className="flex min-h-[22px] min-w-0 items-baseline gap-0.5 whitespace-nowrap"
      >
        <span
          data-slot="dashboard-tile-value"
          className="text-[20px] leading-none font-semibold tracking-[-0.01em] tabular-nums"
        >
          {value}
        </span>
        {unit ? (
          <span
            data-slot="dashboard-tile-unit"
            className="shrink-0 text-[8px] leading-none font-normal tracking-normal text-foreground"
          >
            {unit}
          </span>
        ) : null}
      </span>
      {decoration}
    </>
  )
}

const TILE_CLASS_NAME =
  'relative row-span-3 grid min-h-20 min-w-0 grid-rows-subgrid gap-y-2 overflow-hidden p-2 pb-4 rounded-[10px] border border-border bg-card text-left shadow-card'

export function DashboardTile(props: DashboardTileProps): React.ReactElement {
  const {
    label,
    value,
    unit,
    icon,
    iconClassName,
    className,
    decoration,
    testId,
    onClick,
    ariaLabel,
  } = props
  const contentProps = {
    label,
    value,
    ...(unit === undefined ? {} : { unit }),
    ...(icon === undefined ? {} : { icon }),
    ...(iconClassName === undefined ? {} : { iconClassName }),
    ...(decoration === undefined ? {} : { decoration }),
  }

  if (onClick) {
    return (
      <button
        type="button"
        data-testid={testId}
        aria-label={ariaLabel}
        disabled={props.disabled}
        onClick={onClick}
        className={cn(
          TILE_CLASS_NAME,
          'outline-none transition-colors hover:bg-muted/30 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50',
          className
        )}
      >
        <DashboardTileContent {...contentProps} />
      </button>
    )
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: A fieldset creates an internal box that prevents metric tiles from sharing subgrid rows.
    <div
      role="group"
      data-testid={testId}
      aria-label={ariaLabel ?? label}
      className={cn(TILE_CLASS_NAME, className)}
    >
      <DashboardTileContent {...contentProps} />
    </div>
  )
}
