import type * as React from 'react'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { send } from '@/background/MessageBus'
import { Separator } from '@/components/ui/separator'
import { SettingsTabForm } from '@/options/components/SettingsTabForm'
import { SettingPanel } from '@/options/SettingPanel'
import { AppearanceSection } from '@/options/sections/AppearanceSection'
import { NotificationsSection } from '@/options/sections/NotificationsSection'
import {
  type GeneralFormValues,
  generalFormSchema,
} from '@/options/tabs/schemas'
import { zodFormResolver } from '@/options/zodFormResolver'
import { i18n, resolveDefaultLocale } from '@/shared/i18n'
import { getLocaleOverride, setLocaleOverride } from '@/shared/localeStore'
import { NOTIFICATIONS_DEFAULT } from '@/shared/notifications'
import { getThemeOverride, setThemeOverride } from '@/shared/themeStore'

export function GeneralTab(): React.ReactElement {
  const { t } = useTranslation()
  const [loadFailed, setLoadFailed] = useState(false)
  const form = useForm<GeneralFormValues>({
    resolver: zodFormResolver(generalFormSchema),
    defaultValues: {
      theme: 'system',
      language: 'system',
      notifyMaster: NOTIFICATIONS_DEFAULT.master,
      notifyConfirm: NOTIFICATIONS_DEFAULT.confirm,
      notifyError: NOTIFICATIONS_DEFAULT.error,
      notifyReminder: NOTIFICATIONS_DEFAULT.reminder,
    },
  })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [theme, locale, notif] = await Promise.all([
          getThemeOverride(),
          getLocaleOverride(),
          send('bg.getNotificationsConfig', undefined),
        ])
        if (cancelled) return
        const n = notif ?? NOTIFICATIONS_DEFAULT
        form.reset({
          theme: theme ?? 'system',
          language: locale ?? 'system',
          notifyMaster: n.master,
          notifyConfirm: n.confirm,
          notifyError: n.error,
          notifyReminder: n.reminder,
        })
        setLoadFailed(false)
      } catch {
        if (!cancelled) setLoadFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [form])

  const onSubmit = async (values: GeneralFormValues): Promise<void> => {
    await send('bg.setNotificationsConfig', {
      master: values.notifyMaster,
      confirm: values.notifyConfirm,
      error: values.notifyError,
      reminder: values.notifyReminder,
    })
    await setThemeOverride(values.theme === 'system' ? null : values.theme)
    await setLocaleOverride(
      values.language === 'system' ? null : values.language
    )
    await i18n.changeLanguage(
      values.language === 'system' ? resolveDefaultLocale() : values.language
    )
  }

  return (
    <SettingPanel>
      {loadFailed && (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          {t('options.common.loadError')}
        </p>
      )}
      {!loadFailed && (
        <SettingsTabForm form={form} onSubmit={onSubmit}>
          <AppearanceSection form={form} />

          <Separator className="my-5" />

          <NotificationsSection form={form} />
        </SettingsTabForm>
      )}
    </SettingPanel>
  )
}
