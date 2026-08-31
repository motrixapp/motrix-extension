import type * as React from 'react'
import type { UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import {
  Field,
  FieldContent,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { FormField } from '@/components/ui/form'
import { Switch } from '@/components/ui/switch'
import { SettingSection } from '@/options/components/SettingSection'
import type { GeneralFormValues } from '@/options/tabs/schemas'

type DetailName = 'notifyConfirm' | 'notifyError' | 'notifyReminder'

export function NotificationsSection({
  form,
}: {
  form: UseFormReturn<GeneralFormValues>
}): React.ReactElement {
  const { t } = useTranslation()
  const master = form.watch('notifyMaster')

  const detailRow = (
    name: DetailName,
    labelKey: string,
    descKey: string
  ): React.ReactElement => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor={name}>{t(labelKey)}</FieldLabel>
            <p className="text-xs text-muted-foreground">{t(descKey)}</p>
          </FieldContent>
          <Switch
            id={name}
            checked={field.value}
            aria-label={t(labelKey)}
            onCheckedChange={field.onChange}
          />
        </Field>
      )}
    />
  )

  return (
    <SettingSection title={t('options.notifications.title')}>
      <FieldGroup>
        <FormField
          control={form.control}
          name="notifyMaster"
          render={({ field }) => (
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="notify-master">
                  {t('options.notifications.masterLabel')}
                </FieldLabel>
              </FieldContent>
              <Switch
                id="notify-master"
                checked={field.value}
                aria-label={t('options.notifications.masterAria')}
                onCheckedChange={field.onChange}
              />
            </Field>
          )}
        />
        {master && (
          <>
            {detailRow(
              'notifyConfirm',
              'options.notifications.confirmLabel',
              'options.notifications.confirmDesc'
            )}
            {detailRow(
              'notifyError',
              'options.notifications.errorLabel',
              'options.notifications.errorDesc'
            )}
            {detailRow(
              'notifyReminder',
              'options.notifications.reminderLabel',
              'options.notifications.reminderDesc'
            )}
          </>
        )}
      </FieldGroup>
    </SettingSection>
  )
}
