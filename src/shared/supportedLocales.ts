/** Canonical BCP 47 tags shared by storage, settings, and i18next. */
export const SUPPORTED_LOCALES = [
  'en-US',
  'de',
  'es',
  'fr',
  'hi',
  'id',
  'it',
  'ja',
  'ko',
  'pt-BR',
  'ru',
  'th',
  'tr',
  'vi',
  'zh-CN',
  'zh-TW',
] as const

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

export const LOCALE_NAMES: Record<SupportedLocale, string> = {
  'en-US': 'English',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
  hi: 'हिन्दी',
  id: 'Bahasa Indonesia',
  it: 'Italiano',
  ja: '日本語',
  ko: '한국어',
  'pt-BR': 'Português (Brasil)',
  ru: 'Русский',
  th: 'ไทย',
  tr: 'Türkçe',
  vi: 'Tiếng Việt',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
}

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return SUPPORTED_LOCALES.some((locale) => locale === value)
}

export function resolveLocale(language: string): SupportedLocale {
  const parts = language.toLowerCase().replaceAll('_', '-').split('-')
  const base = parts[0]
  if (base === 'zh') {
    // An explicit script takes precedence over the region.
    if (parts.includes('hans')) return 'zh-CN'
    if (parts.includes('hant')) return 'zh-TW'
    return parts.some((part) => ['tw', 'hk', 'mo'].includes(part))
      ? 'zh-TW'
      : 'zh-CN'
  }
  if (base === 'pt') return 'pt-BR'
  if (isSupportedLocale(base)) return base
  return 'en-US'
}
