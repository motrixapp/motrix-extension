import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { extensionBrowser } from '@/shared/browser'
import { getLocaleOverride, type SupportedLocale } from '@/shared/localeStore'
import enUS from '@/shared/locales/en-US.json'
import zhCN from '@/shared/locales/zh-CN.json'

const resources = {
  'en-US': { translation: enUS },
  'zh-CN': { translation: zhCN },
}

export function resolveDefaultLocale(): SupportedLocale {
  const ui = extensionBrowser.i18n.getUILanguage().toLowerCase()
  return ui.startsWith('zh') ? 'zh-CN' : 'en-US'
}

i18n.use(initReactI18next).init({
  resources,
  lng: resolveDefaultLocale(),
  fallbackLng: 'en-US',
  interpolation: { escapeValue: false },
})

/** Apply the stored override (or browser default). Call once per runtime on load. */
export async function initI18n(): Promise<void> {
  const override = await getLocaleOverride()
  const target = override ?? resolveDefaultLocale()
  if (i18n.language !== target) await i18n.changeLanguage(target)
}

export { i18n }
