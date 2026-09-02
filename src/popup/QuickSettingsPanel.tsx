import { ChevronRight, Settings } from 'lucide-react'
import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import {
  CompactContentCard,
  CompactSectionToolbar,
} from '@/popup/CompactPopupLayout'
import type { QuickSettingsController } from '@/popup/useQuickSettings'

export const QUICK_SETTINGS_I18N_KEYS = {
  title: 'popup.tabs.settings',
  takeoverDescription: 'popup.quickSettings.takeoverDescription',
  notificationsDescription: 'popup.quickSettings.notificationsDescription',
  fullSettings: 'popup.quickSettings.fullSettings',
  fullSettingsDescription: 'popup.quickSettings.fullSettingsDescription',
  loadError: 'popup.quickSettings.loadError',
  saveError: 'popup.quickSettings.saveError',
  retry: 'popup.quickSettings.retry',
} as const

export interface QuickSettingRowProps {
  id: string
  title: string
  description: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}

/** A compact, label-driven switch row shared by every popup quick setting. */
export function QuickSettingRow({
  id,
  title,
  description,
  checked,
  disabled = false,
  onCheckedChange,
}: QuickSettingRowProps): React.ReactElement {
  return (
    <div
      data-slot="quick-setting-row"
      data-disabled={disabled ? 'true' : undefined}
      className="flex h-[55px] shrink-0 items-center justify-between gap-3 px-3 transition-colors hover:bg-muted/30 data-[disabled=true]:opacity-55"
    >
      <span className="min-w-0">
        <label
          id={`${id}-label`}
          htmlFor={id}
          className={cn(
            'block truncate text-xs/4 font-medium',
            disabled ? 'cursor-not-allowed' : 'cursor-pointer'
          )}
        >
          {title}
        </label>
        <span
          id={`${id}-description`}
          className="block truncate text-[10px]/4 text-muted-foreground"
        >
          {description}
        </span>
      </span>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
      />
    </div>
  )
}

export interface QuickSettingsPanelProps {
  controller: QuickSettingsController
  onOpenFullSettings: () => void
  className?: string
}

export const QuickSettingsPanel = memo(function QuickSettingsPanel({
  controller,
  onOpenFullSettings,
  className,
}: QuickSettingsPanelProps): React.ReactElement {
  const { t } = useTranslation()
  const { takeover, notifications } = controller
  const unavailable = takeover === null || notifications === null
  const controlsDisabled = controller.loading || controller.saving

  return (
    <section className={cn('mt-4', className)}>
      <CompactSectionToolbar title={t(QUICK_SETTINGS_I18N_KEYS.title)} />

      <CompactContentCard data-testid="quick-settings-card">
        {unavailable ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            {controller.loading ? (
              <>
                <Spinner
                  className="size-5 text-muted-foreground"
                  aria-label={t('popup.loading')}
                />
                <p className="text-xs text-muted-foreground">
                  {t('popup.loading')}
                </p>
              </>
            ) : (
              <>
                <p role="alert" className="text-xs text-muted-foreground">
                  {t(QUICK_SETTINGS_I18N_KEYS.loadError)}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void controller.reload()}
                >
                  {t(QUICK_SETTINGS_I18N_KEYS.retry)}
                </Button>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="divide-y divide-border">
              <QuickSettingRow
                id="quick-takeover-switch"
                title={t('options.takeover.enableLabel')}
                description={t(QUICK_SETTINGS_I18N_KEYS.takeoverDescription)}
                checked={takeover.enabled}
                disabled={controlsDisabled}
                onCheckedChange={(checked) =>
                  void controller.requestTakeoverEnabled(checked)
                }
              />
              <QuickSettingRow
                id="quick-notifications-master-switch"
                title={t('options.notifications.masterLabel')}
                description={t(
                  QUICK_SETTINGS_I18N_KEYS.notificationsDescription
                )}
                checked={notifications.master}
                disabled={controlsDisabled}
                onCheckedChange={(checked) =>
                  void controller.setNotification('master', checked)
                }
              />
              <QuickSettingRow
                id="quick-notifications-confirm-switch"
                title={t('options.notifications.confirmLabel')}
                description={t('options.notifications.confirmDesc')}
                checked={notifications.confirm}
                disabled={controlsDisabled || !notifications.master}
                onCheckedChange={(checked) =>
                  void controller.setNotification('confirm', checked)
                }
              />
              <QuickSettingRow
                id="quick-notifications-error-switch"
                title={t('options.notifications.errorLabel')}
                description={t('options.notifications.errorDesc')}
                checked={notifications.error}
                disabled={controlsDisabled || !notifications.master}
                onCheckedChange={(checked) =>
                  void controller.setNotification('error', checked)
                }
              />
              <QuickSettingRow
                id="quick-notifications-reminder-switch"
                title={t('options.notifications.reminderLabel')}
                description={t('options.notifications.reminderDesc')}
                checked={notifications.reminder}
                disabled={controlsDisabled || !notifications.master}
                onCheckedChange={(checked) =>
                  void controller.setNotification('reminder', checked)
                }
              />
            </div>
            <Button
              data-testid="full-settings-row"
              type="button"
              variant="ghost"
              className="h-[63px] w-full justify-start rounded-none border-x-0 border-t border-b-0 border-border px-3 text-left hover:bg-muted/40"
              onClick={onOpenFullSettings}
            >
              <Settings
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-xs/4 font-medium">
                  {t(QUICK_SETTINGS_I18N_KEYS.fullSettings)}
                </span>
                <span className="block truncate text-[10px]/4 font-normal text-muted-foreground">
                  {t(QUICK_SETTINGS_I18N_KEYS.fullSettingsDescription)}
                </span>
              </span>
              <ChevronRight
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
            </Button>
          </>
        )}
      </CompactContentCard>

      {controller.error?.operation === 'save' && (
        <p
          role="alert"
          className="mt-1 truncate px-1 text-[10px]/4 text-destructive"
        >
          {t(QUICK_SETTINGS_I18N_KEYS.saveError)}
        </p>
      )}

      <AlertDialog
        open={controller.consentRequired}
        onOpenChange={(open) => {
          if (!open) controller.cancelTakeoverConsent()
        }}
      >
        <AlertDialogContent size="sm" className="max-w-[360px]">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('options.takeover.consentDialogLabel')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('options.takeover.consentBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              type="button"
              className="min-w-0"
              disabled={controller.saving}
            >
              {t('options.takeover.consentCancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              type="button"
              className="min-w-0"
              disabled={controller.saving}
              onClick={() => void controller.confirmTakeoverConsent()}
            >
              {t('options.takeover.consentConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
})
