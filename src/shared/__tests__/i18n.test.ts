import { beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n, initI18n, resolveDefaultLocale } from '@/shared/i18n'

declare const browser: {
  i18n: { getUILanguage: () => string }
  storage: {
    local: {
      get: (k: string) => Promise<Record<string, unknown>>
      set: (i: Record<string, unknown>) => Promise<void>
      remove: (k: string) => Promise<void>
    }
  }
}

beforeEach(() => {
  let bag: Record<string, unknown> = {}
  browser.storage.local.get = vi.fn(async (k: string) =>
    k in bag ? { [k]: bag[k] } : {}
  )
  browser.storage.local.set = vi.fn(async (i: Record<string, unknown>) => {
    bag = { ...bag, ...i }
  })
  browser.storage.local.remove = vi.fn(async (k: string) => {
    delete bag[k]
  })
  browser.i18n = { getUILanguage: vi.fn(() => 'en-US') }
})

describe('resolveDefaultLocale', () => {
  it('maps zh* to zh-CN', () => {
    for (const lng of ['zh', 'zh-CN', 'zh-TW', 'zh-Hans']) {
      browser.i18n.getUILanguage = () => lng
      expect(resolveDefaultLocale()).toBe('zh-CN')
    }
  })
  it('maps everything else to en-US', () => {
    for (const lng of ['en', 'en-US', 'fr', 'de-DE']) {
      browser.i18n.getUILanguage = () => lng
      expect(resolveDefaultLocale()).toBe('en-US')
    }
  })
})

describe('initI18n', () => {
  it('uses the browser default when no override stored', async () => {
    browser.i18n.getUILanguage = () => 'zh-CN'
    await initI18n()
    expect(i18n.language).toBe('zh-CN')
    expect(i18n.t('contextMenu.downloadWithMotrix')).toBe('用 Motrix 下载')
  })
  it('honors a stored override over the browser language', async () => {
    browser.i18n.getUILanguage = () => 'zh-CN'
    await browser.storage.local.set({ 'motrix.locale': 'en-US' })
    await initI18n()
    expect(i18n.language).toBe('en-US')
    expect(i18n.t('contextMenu.downloadWithMotrix')).toBe(
      'Download with Motrix'
    )
  })
})
