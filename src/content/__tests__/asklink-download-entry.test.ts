import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import manifestConfig from '#manifest-config'
import {
  TAKEOVER_CONFIG_KEY,
  TAKEOVER_DEFAULT,
  type TakeoverConfig,
} from '@/shared/takeover'

const storage = vi.hoisted(() => ({
  get: vi.fn(),
  addListener: vi.fn(),
}))

vi.mock('@/shared/browser', () => ({
  extensionBrowser: {
    storage: { local: { get: storage.get }, onChanged: storage },
  },
}))

const installer =
  'https://dl.asklink.com/download/windows/Full/AskLink_Full_v4.3.9.3_20261120_1935.exe'
const enabled = { ...TAKEOVER_DEFAULT, enabled: true }

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubGlobal('location', new URL('https://www.asklink.com/zh-CN'))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function setup(config = enabled) {
  storage.get.mockResolvedValue({ [TAKEOVER_CONFIG_KEY]: config })
  const addListener = vi
    .spyOn(window, 'addEventListener')
    .mockImplementation(() => {})
  await import('@/content/asklink-download-entry')
  const listener = addListener.mock.calls.find(([name]) => name === 'click')
  expect(listener?.[2]).toBe(true)
  const onClick = listener?.[1] as EventListener
  const change = (next: TakeoverConfig) =>
    storage.addListener.mock.calls[0]?.[0](
      { [TAKEOVER_CONFIG_KEY]: { newValue: next } },
      'local'
    )
  return {
    change,
    click(url = installer, overrides: Partial<MouseEvent> = {}) {
      const anchor = document.createElement('a')
      anchor.href = url
      const event = {
        isTrusted: true,
        cancelable: true,
        button: 0,
        composedPath: () => [anchor],
        stopImmediatePropagation: vi.fn(),
        preventDefault: vi.fn(),
        ...overrides,
      }
      onClick(event as unknown as MouseEvent)
      return event
    },
  }
}

it('keeps the official installer anchor navigation and suppresses the page handler', async () => {
  const { click } = await setup()
  const event = click()
  expect(event.stopImmediatePropagation).toHaveBeenCalledOnce()
  expect(event.preventDefault).not.toHaveBeenCalled()
})

it('follows the takeover switch and domain exclusions without reloading the page', async () => {
  const { change, click } = await setup(TAKEOVER_DEFAULT)
  expect(click().stopImmediatePropagation).not.toHaveBeenCalled()
  change(enabled)
  expect(click().stopImmediatePropagation).toHaveBeenCalledOnce()
  for (const domain of ['www.asklink.com', 'dl.asklink.com']) {
    change({
      ...enabled,
      rules: [
        { id: 'exclude', action: 'chrome', match: { domains: [domain] } },
      ],
    })
    expect(click().stopImmediatePropagation).not.toHaveBeenCalled()
  }
})

it('lets the site handle modified clicks, synthetic clicks and other links', async () => {
  const { click } = await setup()
  for (const overrides of [{ ctrlKey: true }, { isTrusted: false }]) {
    expect(
      click(installer, overrides).stopImmediatePropagation
    ).not.toHaveBeenCalled()
  }
  for (const url of [
    `${installer}?signature=temporary`,
    installer.replace('dl.asklink.com', 'dl.asklink.com.example.org'),
    installer.replace('/Full/', '/Enterprise/'),
    'http://[',
  ]) {
    expect(click(url).stopImmediatePropagation).not.toHaveBeenCalled()
  }
})

it.each(['chromium', 'webstore', 'firefox', 'safari'])(
  'scopes the %s manifest entry to AskLink and the top-level page',
  async (mode) => {
    const manifest = (await manifestConfig({ command: 'build', mode })) as {
      content_scripts?: { js?: string[] }[]
    }
    const entry = manifest.content_scripts?.find((script) =>
      script.js?.includes('src/content/asklink-download-entry.ts')
    )
    if (mode === 'safari') expect(entry).toBeUndefined()
    else {
      expect(entry).toMatchObject({
        matches: ['https://www.asklink.com/*'],
        run_at: 'document_start',
        world: 'ISOLATED',
      })
      expect(entry).not.toHaveProperty('all_frames')
    }
  }
)
