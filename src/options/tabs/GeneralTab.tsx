import type * as React from 'react'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { send } from '@/background/MessageBus'
import { Separator } from '@/components/ui/separator'
import { SettingsTabForm } from '@/options/components/SettingsTabForm'
import { SettingPanel } from '@/options/SettingPanel'
import { NotificationsSection } from '@/options/sections/NotificationsSection'
import { TakeoverSection } from '@/options/sections/TakeoverSection'
import {
  type GeneralFormValues,
  generalFormSchema,
} from '@/options/tabs/schemas'
import { configToForm, formToConfig } from '@/options/takeoverForm'
import { zodFormResolver } from '@/options/zodFormResolver'
import { NOTIFICATIONS_DEFAULT } from '@/shared/notifications'

export function GeneralTab(): React.ReactElement {
  const { t } = useTranslation()
  const [consentAck, setConsentAck] = useState(0)
  const [loadFailed, setLoadFailed] = useState(false)
  const form = useForm<GeneralFormValues>({
    resolver: zodFormResolver(generalFormSchema),
    defaultValues: {
      enabled: false,
      thresholdMB: '',
      denylist: '',
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
        const [takeover, notif] = await Promise.all([
          send('bg.getTakeoverConfig', undefined),
          send('bg.getNotificationsConfig', undefined),
        ])
        if (cancelled) return
        const n = notif ?? NOTIFICATIONS_DEFAULT
        form.reset({
          ...configToForm(takeover),
          notifyMaster: n.master,
          notifyConfirm: n.confirm,
          notifyError: n.error,
          notifyReminder: n.reminder,
        })
        setConsentAck(takeover.consentAckVersion)
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
    await send(
      'bg.setTakeoverConfig',
      formToConfig(
        {
          enabled: values.enabled,
          thresholdMB: values.thresholdMB,
          denylist: values.denylist,
        },
        consentAck
      )
    )
    await send('bg.setNotificationsConfig', {
      master: values.notifyMaster,
      confirm: values.notifyConfirm,
      error: values.notifyError,
      reminder: values.notifyReminder,
    })
  }

  return (
    <SettingPanel title={t('options.tabs.general')}>
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
          <TakeoverSection
            form={form}
            consentAck={consentAck}
            setConsentAck={setConsentAck}
          />

          <Separator className="my-5" />

          <NotificationsSection form={form} />
        </SettingsTabForm>
      )}
    </SettingPanel>
  )
}
