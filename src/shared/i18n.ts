import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { extensionBrowser } from '@/shared/browser'
import { getLocaleOverride, type SupportedLocale } from '@/shared/localeStore'
import de from '@/shared/locales/de.json'
import enUS from '@/shared/locales/en-US.json'
import es from '@/shared/locales/es.json'
import fr from '@/shared/locales/fr.json'
import hi from '@/shared/locales/hi.json'
import id from '@/shared/locales/id.json'
import it from '@/shared/locales/it.json'
import ja from '@/shared/locales/ja.json'
import ko from '@/shared/locales/ko.json'
import ptBR from '@/shared/locales/pt-BR.json'
import ru from '@/shared/locales/ru.json'
import th from '@/shared/locales/th.json'
import tr from '@/shared/locales/tr.json'
import vi from '@/shared/locales/vi.json'
import zhCN from '@/shared/locales/zh-CN.json'
import zhTW from '@/shared/locales/zh-TW.json'
import { resolveLocale } from '@/shared/supportedLocales'

const resources = {
  'en-US': { translation: enUS },
  'zh-CN': { translation: zhCN },
  de: { translation: de },
  es: { translation: es },
  fr: { translation: fr },
  hi: { translation: hi },
  id: { translation: id },
  it: { translation: it },
  ja: { translation: ja },
  ko: { translation: ko },
  'pt-BR': { translation: ptBR },
  ru: { translation: ru },
  th: { translation: th },
  tr: { translation: tr },
  vi: { translation: vi },
  'zh-TW': { translation: zhTW },
}

export function resolveDefaultLocale(): SupportedLocale {
  return resolveLocale(extensionBrowser.i18n.getUILanguage())
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
