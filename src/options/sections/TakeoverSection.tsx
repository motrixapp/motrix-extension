import type * as React from 'react'
import { useEffect, useState } from 'react'
import type { UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { TakeoverConsentDialog } from '@/components/takeover-consent-dialog'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { FormField } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { SettingSection } from '@/options/components/SettingSection'
import type { TakeoverFormValues } from '@/options/tabs/schemas'
import { useTakeoverAvailability } from '@/options/useTakeoverAvailability'
import { CONSENT_VERSION } from '@/shared/takeover'

export function TakeoverSection({
  form,
  consentAck,
  setConsentAck,
}: {
  form: UseFormReturn<TakeoverFormValues>
  consentAck: number
  setConsentAck: (version: number) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const availability = useTakeoverAvailability()
  const [showConsent, setShowConsent] = useState(false)
  useEffect(() => {
    if (availability !== 'local') setShowConsent(false)
  }, [availability])
  return (
    <>
      <SettingSection title={t('options.takeover.title')}>
        <FieldGroup>
          <FormField
            control={form.control}
            name="enabled"
            render={({ field }) => (
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="download-enabled">
                    {t('options.takeover.enableLabel')}
                  </FieldLabel>
                  {availability !== 'local' && (
                    <FieldDescription id="download-takeover-unavailable">
                      {t(
                        availability === 'remote'
                          ? 'options.takeover.remoteUnavailable'
                          : 'options.takeover.availabilityUnknown'
                      )}
                    </FieldDescription>
                  )}
                </FieldContent>
                <Switch
                  id="download-enabled"
                  checked={availability === 'local' && field.value}
                  disabled={availability !== 'local'}
                  aria-describedby={
                    availability !== 'local'
                      ? 'download-takeover-unavailable'
                      : undefined
                  }
                  aria-label={t('options.takeover.enableAria')}
                  onCheckedChange={(checked) => {
                    if (availability !== 'local') return
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
                  <FieldLabel htmlFor="download-threshold">
                    {t('options.takeover.minSizeLabel')}
                  </FieldLabel>
                </FieldContent>
                <Input
                  id="download-threshold"
                  type="number"
                  className="bg-background @md/field-group:w-40"
                  placeholder={t('options.takeover.minSizePlaceholder')}
                  aria-invalid={fieldState.invalid}
                  {...field}
                />
                {fieldState.invalid && (
                  <FieldError
                    errors={[{ message: t(fieldState.error?.message ?? '') }]}
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
                <FieldLabel htmlFor="download-denylist">
                  {t('options.takeover.denylistLabel')}
                </FieldLabel>
                <Textarea
                  id="download-denylist"
                  className="min-h-20"
                  {...field}
                />
              </Field>
            )}
          />
        </FieldGroup>
      </SettingSection>

      <TakeoverConsentDialog
        open={showConsent && availability === 'local'}
        onConfirm={() => {
          if (availability !== 'local') return
          setConsentAck(CONSENT_VERSION)
          form.setValue('enabled', true, { shouldDirty: true })
          setShowConsent(false)
        }}
        onCancel={() => setShowConsent(false)}
      />
    </>
  )
}
