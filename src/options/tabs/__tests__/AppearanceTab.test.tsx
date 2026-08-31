import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/shared/i18n'
import { AppearanceTab } from '@/options/tabs/AppearanceTab'
import { i18n } from '@/shared/i18n'
import { getLocaleOverride } from '@/shared/localeStore'
import { getThemeOverride } from '@/shared/themeStore'

declare const browser: {
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
})

afterEach(async () => {
  await i18n.changeLanguage('en-US')
})

describe('AppearanceTab', () => {
  it('Apply persists theme + language and applies language live', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<AppearanceTab />)

    await user.click(await screen.findByRole('combobox', { name: /theme/i }))
    await user.click(await screen.findByRole('option', { name: /dark/i }))
    expect(
      screen.getByRole('combobox', { name: /theme/i }).textContent
    ).toContain('Dark')

    await user.click(screen.getByRole('combobox', { name: /language/i }))
    await user.click(await screen.findByRole('option', { name: '中文' }))
    expect(
      screen.getByRole('combobox', { name: /language/i }).textContent
    ).toContain('中文')

    await user.click(screen.getByRole('button', { name: /apply/i }))

    await waitFor(async () => {
      expect(await getThemeOverride()).toBe('dark')
      expect(await getLocaleOverride()).toBe('zh-CN')
      expect(i18n.language).toBe('zh-CN')
    })
  })
})
