import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import {
  Field,
  FieldContent,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { FormField } from '@/components/ui/form'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingsTabForm } from '@/options/components/SettingsTabForm'
import { SettingPanel } from '@/options/SettingPanel'
import {
  type AppearanceFormValues,
  appearanceFormSchema,
} from '@/options/tabs/schemas'
import { zodFormResolver } from '@/options/zodFormResolver'
import { i18n, resolveDefaultLocale } from '@/shared/i18n'
import { getLocaleOverride, setLocaleOverride } from '@/shared/localeStore'
import { getThemeOverride, setThemeOverride } from '@/shared/themeStore'

export function AppearanceTab(): React.ReactElement {
  const { t } = useTranslation()
  const themeItems = {
    system: t('options.appearance.theme.system'),
    light: t('options.appearance.theme.light'),
    dark: t('options.appearance.theme.dark'),
  } satisfies Record<AppearanceFormValues['theme'], string>
  const languageItems = {
    system: t('options.language.system'),
    'en-US': 'English',
    'zh-CN': '中文',
  } satisfies Record<AppearanceFormValues['language'], string>
  const form = useForm<AppearanceFormValues>({
    resolver: zodFormResolver(appearanceFormSchema),
    defaultValues: { theme: 'system', language: 'system' },
  })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [theme, locale] = await Promise.all([
        getThemeOverride(),
        getLocaleOverride(),
      ])
      if (cancelled) return
      form.reset({ theme: theme ?? 'system', language: locale ?? 'system' })
    })()
    return () => {
      cancelled = true
    }
  }, [form])

  const onSubmit = async (values: AppearanceFormValues): Promise<void> => {
    await setThemeOverride(values.theme === 'system' ? null : values.theme)
    await setLocaleOverride(
      values.language === 'system' ? null : values.language
    )
    await i18n.changeLanguage(
      values.language === 'system' ? resolveDefaultLocale() : values.language
    )
  }

  return (
    <SettingPanel title={t('options.tabs.appearance')}>
      <SettingsTabForm form={form} onSubmit={onSubmit}>
        <FieldGroup>
          <FormField
            control={form.control}
            name="theme"
            render={({ field }) => (
              <Field orientation="responsive">
                <FieldContent>
                  <FieldLabel htmlFor="appearance-theme">
                    {t('options.appearance.theme.label')}
                  </FieldLabel>
                </FieldContent>
                <Select
                  items={themeItems}
                  value={field.value}
                  onValueChange={(value) => {
                    if (value !== null) field.onChange(value)
                  }}
                >
                  <SelectTrigger id="appearance-theme" className="min-w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="system">
                        {themeItems.system}
                      </SelectItem>
                      <SelectItem value="light">{themeItems.light}</SelectItem>
                      <SelectItem value="dark">{themeItems.dark}</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            )}
          />
          <FormField
            control={form.control}
            name="language"
            render={({ field }) => (
              <Field orientation="responsive">
                <FieldContent>
                  <FieldLabel htmlFor="appearance-language">
                    {t('options.language.label')}
                  </FieldLabel>
                </FieldContent>
                <Select
                  items={languageItems}
                  value={field.value}
                  onValueChange={(value) => {
                    if (value !== null) field.onChange(value)
                  }}
                >
                  <SelectTrigger id="appearance-language" className="min-w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="system">
                        {languageItems.system}
                      </SelectItem>
                      <SelectItem value="en-US">
                        {languageItems['en-US']}
                      </SelectItem>
                      <SelectItem value="zh-CN">
                        {languageItems['zh-CN']}
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            )}
          />
        </FieldGroup>
      </SettingsTabForm>
    </SettingPanel>
  )
}
