import type * as React from 'react'
import { useEffect, useState } from 'react'
import type { UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
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
import type { GeneralFormValues } from '@/options/tabs/schemas'
import { useTakeoverAvailability } from '@/options/useTakeoverAvailability'
import { CONSENT_VERSION } from '@/shared/takeover'

export function TakeoverSection({
  form,
  consentAck,
  setConsentAck,
}: {
  form: UseFormReturn<GeneralFormValues>
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
                  <FieldLabel htmlFor="general-enabled">
                    {t('options.takeover.enableLabel')}
                  </FieldLabel>
                  {availability !== 'local' && (
                    <FieldDescription id="general-takeover-unavailable">
                      {t(
                        availability === 'remote'
                          ? 'options.takeover.remoteUnavailable'
                          : 'options.takeover.availabilityUnknown'
                      )}
                    </FieldDescription>
                  )}
                </FieldContent>
                <Switch
                  id="general-enabled"
                  checked={availability === 'local' && field.value}
                  disabled={availability !== 'local'}
                  aria-describedby={
                    availability !== 'local'
                      ? 'general-takeover-unavailable'
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

      {showConsent && availability === 'local' && (
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
                if (availability !== 'local') return
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
    </>
  )
}
