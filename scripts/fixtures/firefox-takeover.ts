import { registerFirefoxInterception } from '@/background/interception/firefox'
import { log } from '@/background/log'
import { extensionBrowser as browser } from '@/shared/browser'
import { TAKEOVER_DEFAULT } from '@/shared/takeover'

// Exercise the production adapter with Firefox's real downloads/cookies APIs.
// Only the external Motrix backend is replaced by an in-memory receiver.
const observations: Record<string, unknown>[] = []
let config = { ...TAKEOVER_DEFAULT, enabled: true }
let submits = 0
let confirmations = 0
let nativeId: number | undefined
log.setLevel('debug')
const debug = console.debug.bind(console)
console.debug = (...args: unknown[]) => {
  if (args[1] === '[takeover] probe outcome=')
    observations.push({ event: 'probe', outcome: args[2], head: args[4] })
  debug(...args)
}
browser.downloads.onCreated.addListener((item) => {
  nativeId = item.id
  observations.push({
    event: 'created',
    totalBytes: item.totalBytes,
    mime: item.mime,
  })
})
browser.downloads.onChanged.addListener((delta) => {
  observations.push({ event: 'changed', keys: Object.keys(delta) })
})
registerFirefoxInterception({
  getConfig: async () => config,
  captureGuard: async () => ({ origin: 'auto', assertCurrent() {} }),
  selfExtensionId: browser.runtime.id,
  manager: {
    getState: () => 'connected',
    getRpcStatus: () => ({ health: 'healthy' }),
    submitDownload: async () => {
      submits += 1
      return { taskId: 'fixture-task' }
    },
  },
  confirm: async (target) => {
    confirmations += 1
    observations.push({ event: 'confirmed', sizeBytes: target.sizeBytes })
  },
  notify() {},
} as Parameters<typeof registerFirefoxInterception>[0])

Object.assign(window, {
  async checkFetchReceiver(baseUrl: string) {
    const injected = { fetch: globalThis.fetch }
    let unboundError = ''
    try {
      await injected.fetch(`${baseUrl}/receiver-probe`)
    } catch (error) {
      unboundError = String(error)
    }
    const bound = await injected.fetch.call(
      globalThis,
      `${baseUrl}/receiver-probe`
    )
    return { unboundError, boundStatus: bound.status }
  },
  async runCase(input: { baseUrl: string; name: string }) {
    observations.length = 0
    submits = 0
    confirmations = 0
    nativeId = undefined
    config = {
      ...TAKEOVER_DEFAULT,
      enabled: true,
      downloadMode: input.name === 'confirm' ? 'confirm' : 'direct',
      unknownSizeAction: input.name === 'unknown-motrix' ? 'motrix' : 'chrome',
      rules:
        input.name === 'small'
          ? [{ id: 'small', match: { minSizeMB: 10 }, action: 'chrome' }]
          : [],
    }
    const tab = await browser.tabs.create({
      url: `${input.baseUrl}/start/${input.name}`,
    })
    const deadline = Date.now() + 4200
    while (Date.now() < deadline && submits === 0 && confirmations === 0)
      await new Promise((resolve) => setTimeout(resolve, 50))
    const items =
      nativeId === undefined
        ? []
        : await browser.downloads.search({ id: nativeId })
    const result = {
      name: input.name,
      submits,
      confirmations,
      observations: [...observations],
      native: items.map(({ state, totalBytes, paused }) => ({
        state,
        totalBytes,
        paused,
      })),
    }
    if (items[0]?.state === 'in_progress')
      await browser.downloads.cancel(items[0].id)
    if (tab.id !== undefined) await browser.tabs.remove(tab.id)
    // Let cancellation events settle before clearing observations for the next case.
    await new Promise((resolve) => setTimeout(resolve, 100))
    return result
  },
})
