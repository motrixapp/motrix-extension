import { afterEach, expect, it, vi } from 'vitest'
import { startDownloadProtection } from '@/background/policy/downloadProtection'
import { extensionBrowser as browser } from '@/shared/browser'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('uses only saved exclusions, including edits made during cold start', async () => {
  const change = vi.fn()
  let resolve!: (value: Record<string, unknown>) => void
  const config = (domain: string) => ({
    enabled: true,
    consentAckVersion: 1,
    defaultAction: 'motrix',
    rules: [{ id: 'personal', action: 'chrome', match: { domains: [domain] } }],
  })
  const key = 'motrix.takeoverConfig'
  Object.assign(browser, {
    storage: {
      ...browser.storage,
      onChanged: { addListener: change },
      local: {
        get: () =>
          new Promise((r) => {
            resolve = r
          }),
      },
    },
    alarms: { clear: vi.fn(async () => true) },
  })
  const protects = startDownloadProtection()
  const changed = change.mock.calls[0]?.[0]
  changed({ [key]: { newValue: config('drive.example') } }, 'local')
  resolve({ [key]: config('old.example') })
  await vi.waitFor(() =>
    expect(protects('resource', 'https://old.example')).toBe(false)
  )
  expect(protects('source', 'https://files.drive.example./share')).toBe(true)
  expect(protects('resource', 'https://notdrive.example/download')).toBe(false)
  changed({ [key]: { newValue: config('cdn.example') } }, 'local')
  expect(protects('resource', 'https://drive.example/file')).toBe(false)
  expect(protects('resource', 'https://cdn.example/file')).toBe(true)
  changed({ [key]: {} }, 'local')
  expect(protects('resource', 'https://cdn.example/file')).toBe(false)
  expect(protects('source', 'https://www.123684.com/s/fixture')).toBe(false)
})
