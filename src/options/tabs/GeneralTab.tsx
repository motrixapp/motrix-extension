import type * as React from 'react'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { send } from '@/background/MessageBus'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldContent,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { FormField } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { SettingSection } from '@/options/components/SettingSection'
import { SettingsTabForm } from '@/options/components/SettingsTabForm'
import { SettingPanel } from '@/options/SettingPanel'
import { NotificationsSection } from '@/options/sections/NotificationsSection'
import {
  type GeneralFormValues,
  generalFormSchema,
} from '@/options/tabs/schemas'
import { configToForm, formToConfig } from '@/options/takeoverForm'
import { zodFormResolver } from '@/options/zodFormResolver'
import { NOTIFICATIONS_DEFAULT } from '@/shared/notifications'
import { CONSENT_VERSION } from '@/shared/takeover'

export function GeneralTab(): React.ReactElement {
  const { t } = useTranslation()
  const [consentAck, setConsentAck] = useState(0)
  const [showConsent, setShowConsent] = useState(false)
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
          <SettingSection title={t('options.takeover.title')}>
            <FieldGroup>
              <FormField
                control={form.control}
                name="enabled"
                render={({ field }) => (
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor="general-enabled">
                        {t('options.takeover.enableLabel')}
                      </FieldLabel>
                    </FieldContent>
                    <Switch
                      id="general-enabled"
                      checked={field.value}
                      aria-label={t('options.takeover.enableAria')}
                      onCheckedChange={(checked) => {
                        if (checked && consentAck < CONSENT_VERSION) {
                          setShowConsent(true)
                          return
                        }
                        field.onChange(checked)
                      }}
                    />
                  </Field>
                )}
              />
              <FormField
                control={form.control}
                name="thresholdMB"
                render={({ field, fieldState }) => (
                  <Field orientation="responsive">
                    <FieldContent>
                      <FieldLabel htmlFor="general-threshold">
                        {t('options.takeover.minSizeLabel')}
                      </FieldLabel>
                    </FieldContent>
                    <Input
                      id="general-threshold"
                      type="number"
                      className="bg-background @md/field-group:w-40"
                      placeholder={t('options.takeover.minSizePlaceholder')}
                      aria-invalid={fieldState.invalid}
                      {...field}
                    />
                    {fieldState.invalid && (
                      <FieldError
                        errors={[
                          { message: t(fieldState.error?.message ?? '') },
                        ]}
                      />
                    )}
                  </Field>
                )}
              />
              <FormField
                control={form.control}
                name="denylist"
                render={({ field }) => (
                  <Field orientation="vertical">
                    <FieldLabel htmlFor="general-denylist">
                      {t('options.takeover.denylistLabel')}
                    </FieldLabel>
                    <Textarea
                      id="general-denylist"
                      className="min-h-20"
                      {...field}
                    />
                  </Field>
                )}
              />
            </FieldGroup>
          </SettingSection>

          {showConsent && (
            <div
              className="mt-4 rounded-xl border border-amber-400/70 bg-amber-50 p-3.5 text-xs text-amber-950 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-100"
              role="dialog"
              aria-label={t('options.takeover.consentDialogLabel')}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setShowConsent(false)
              }}
            >
              <p className="mb-2.5 leading-relaxed">
                {t('options.takeover.consentBody')}
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    setConsentAck(CONSENT_VERSION)
                    form.setValue('enabled', true, { shouldDirty: true })
                    setShowConsent(false)
                  }}
                >
                  {t('options.takeover.consentConfirm')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => setShowConsent(false)}
                >
                  {t('options.takeover.consentCancel')}
                </Button>
              </div>
            </div>
          )}

          <Separator className="my-5" />

          <NotificationsSection form={form} />
        </SettingsTabForm>
      )}
    </SettingPanel>
  )
}
