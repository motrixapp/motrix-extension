import { extensionBrowser } from '@/shared/browser'

const LOCALE_KEY = 'motrix.locale'

export type SupportedLocale = 'en-US' | 'zh-CN'

export async function getLocaleOverride(): Promise<SupportedLocale | null> {
  const got = await extensionBrowser.storage.local.get(LOCALE_KEY)
  const v = got[LOCALE_KEY]
  return v === 'en-US' || v === 'zh-CN' ? v : null
}

export async function setLocaleOverride(
  v: SupportedLocale | null
): Promise<void> {
  if (v === null) {
    await extensionBrowser.storage.local.remove(LOCALE_KEY)
  } else {
    await extensionBrowser.storage.local.set({ [LOCALE_KEY]: v })
  }
}

export { LOCALE_KEY }
