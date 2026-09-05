import { ListTodo, Radio, Settings } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

export type PopupTab = 'tasks' | 'sniffer' | 'settings'

export function CompactPopupHeader({
  backend,
  takeoverChecked,
  takeoverDisabled,
  takeoverSupported = true,
  onTakeoverChange,
  onOpenSettings,
}: {
  backend: ReactNode
  takeoverChecked: boolean
  takeoverDisabled?: boolean
  takeoverSupported?: boolean
  onTakeoverChange: (checked: boolean) => void
  onOpenSettings: () => void
}): React.ReactElement {
  const { t } = useTranslation()

  return (
    <header className="flex h-8 items-center justify-between">
      {backend}
      <div className="flex items-center gap-4">
        <div
          className="flex h-8 items-center gap-2 text-sm font-normal"
          title={
            takeoverSupported
              ? undefined
              : t('options.takeover.remoteUnavailable')
          }
        >
          {!takeoverSupported && (
            <span id="popup-takeover-unavailable" className="sr-only">
              {t('options.takeover.remoteUnavailable')}
            </span>
          )}
          <span>{t('popup.takeover.label')}</span>
          <Switch
            id="popup-takeover-switch"
            data-testid="takeover-switch"
            checked={takeoverChecked}
            disabled={takeoverDisabled}
            onCheckedChange={onTakeoverChange}
            aria-label={t('popup.takeover.aria')}
            aria-describedby={
              takeoverSupported ? undefined : 'popup-takeover-unavailable'
            }
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className="size-8 text-muted-foreground"
          aria-label={t('popup.settings')}
          title={t('popup.settings')}
          onClick={onOpenSettings}
        >
          <Settings className="size-[18px]" aria-hidden="true" />
        </Button>
      </div>
    </header>
  )
}

export function CompactSectionToolbar({
  title,
  controls,
  action,
  className,
}: {
  title: string
  controls?: ReactNode
  action?: ReactNode
  className?: string
}): React.ReactElement {
  return (
    <div
      data-testid="compact-section-toolbar"
      className={cn('flex h-8 items-center', className)}
    >
      <h1 className="w-40 min-w-0 truncate text-lg/6 font-medium">{title}</h1>
      {controls}
      {action !== undefined && action !== null ? (
        <div className="ml-4 flex size-8 shrink-0 items-center justify-center">
          {action}
        </div>
      ) : null}
    </div>
  )
}

export function CompactContentCard({
  className,
  children,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      {...props}
      className={cn(
        'mt-3 h-[340px] overflow-hidden rounded-[12px] border border-border bg-card shadow-card',
        className
      )}
    >
      {children}
    </div>
  )
}

export function PopupBottomNavigation(): React.ReactElement {
  const { t } = useTranslation()

  return (
    <TabsList
      data-testid="bottom-tabs"
      className="mx-auto mt-2 grid h-9 w-[264px] grid-cols-3 gap-[3px] rounded-[12px] bg-tab-background p-[3px] group-data-horizontal/tabs:h-9"
    >
      <TabsTrigger
        value="tasks"
        aria-label={t('popup.tabs.tasks')}
        className="h-[30px] w-full flex-none gap-1 rounded-[8px] px-1 text-xs font-normal shadow-none group-data-[variant=default]/tabs-list:data-active:shadow-xs"
      >
        <ListTodo className="size-3.5" aria-hidden="true" />
        {t('popup.tabs.tasks')}
      </TabsTrigger>
      <TabsTrigger
        value="sniffer"
        aria-label={t('popup.tabs.sniffer')}
        className="h-[30px] w-full flex-none gap-1 rounded-[8px] px-1 text-xs font-normal shadow-none group-data-[variant=default]/tabs-list:data-active:shadow-xs"
      >
        <Radio className="size-3.5" aria-hidden="true" />
        {t('popup.tabs.sniffer')}
      </TabsTrigger>
      <TabsTrigger
        value="settings"
        aria-label={t('popup.tabs.settings')}
        className="h-[30px] w-full flex-none gap-1 rounded-[8px] px-1 text-xs font-normal shadow-none group-data-[variant=default]/tabs-list:data-active:shadow-xs"
      >
        <Settings className="size-3.5" aria-hidden="true" />
        {t('popup.tabs.settings')}
      </TabsTrigger>
    </TabsList>
  )
}
