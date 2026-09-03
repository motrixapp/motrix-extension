import { afterEach, describe, expect, it, vi } from 'vitest'

const globals = globalThis as unknown as {
  browser?: typeof chrome
}
const originalBrowser = globals.browser

afterEach(() => {
  globals.browser = originalBrowser
  vi.resetModules()
})

describe('Chromium startup', () => {
  it('initializes shared modules when Chromium only provides chrome.*', async () => {
    Reflect.deleteProperty(globals, 'browser')
    vi.resetModules()

    const { resolveDefaultLocale } = await import('@/shared/i18n')

    expect(globals.browser).toBeDefined()
    expect(resolveDefaultLocale()).toBe('en-US')
  })
})
