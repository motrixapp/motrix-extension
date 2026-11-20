import {
  type DownloadSubmitParams,
  DownloadSubmitResultSchema,
  InitializeResultSchema,
  type MdxpConnection,
  Methods,
} from '@motrix/mdxp/browser'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { createConfirmedDownloadActions } from '@/background/confirmedDownload'
import { DownloadConfirmationService } from '@/background/DownloadConfirmationService'
import {
  DownloadOutcomeUnknownError,
  DownloadPreparationError,
} from '@/background/download-errors'
import type { ChromiumInterceptionDeps } from '@/background/interception/chromium'
import { registerChromiumInterception } from '@/background/interception/chromium'
import { registerFirefoxInterception } from '@/background/interception/firefox'
import { registerNativeConfirmation } from '@/background/interception/nativeConfirmation'
import { observeReplaySources } from '@/background/interception/replaySource'
import { registerWebRequestEarlyTakeover } from '@/background/interception/webRequestEarly'
import { log } from '@/background/log'
import { startDownloadProtection } from '@/background/policy/downloadProtection'
import { TAKEOVER_CONFIG_KEY } from '@/background/TakeoverConfigStore'
import { WebSocketClient } from '@/background/WebSocketClient'
import { DownloadConfirmationForm } from '@/popup/DownloadConfirmationDialog'
import { extensionBrowser as browser, nativeBrowser } from '@/shared/browser'
import { i18n } from '@/shared/i18n'
import { DOWNLOAD_ERROR } from '@/shared/integration'
import { TAKEOVER_DEFAULT } from '@/shared/takeover'

// Exercise the production adapter with Firefox's real downloads/cookies APIs.
// The backend is a loopback MDXP peer; MBP1 and desktop startup are out of scope.
let client: WebSocketClient
let connection: MdxpConnection
async function submit(params: DownloadSubmitParams) {
  let received = false
  try {
    const result = await connection.sendRequest(Methods.DownloadSubmit, {
      ...params,
      idempotencyKey: params.idempotencyKey ?? crypto.randomUUID(),
    })
    submits += 1
    received = true
    return DownloadSubmitResultSchema.parse(result)
  } catch (error) {
    if ((error as { code?: number }).code === -32602)
      throw new DownloadPreparationError(DOWNLOAD_ERROR.rejected)
    // A lost response cannot establish whether the peer created a task.
    if (!received) submits += 1
    throw new DownloadOutcomeUnknownError()
  }
}
const observations: Record<string, unknown>[] = []
let config = { ...TAKEOVER_DEFAULT, enabled: true }
let submits = 0
let confirmations = 0
let nativeId: number | undefined
let nativeIds: number[] = []
let caseName = ''
let confirmationSettled = false
log.setLevel('debug')
const debug = console.debug.bind(console)
console.debug = (...args: unknown[]) => {
  if (args[1] === '[takeover] probe outcome=')
    observations.push({ event: 'probe', outcome: args[2], head: args[4] })
  debug(...args)
}
browser.downloads.onCreated.addListener((item) => {
  if (!item.url.endsWith(`/download/${caseName}`)) return
  nativeId = item.id
  nativeIds.push(item.id)
  observations.push({
    event: 'created',
    totalBytes: item.totalBytes,
    mime: item.mime,
  })
})
browser.downloads.onChanged.addListener((delta) => {
  if (!nativeIds.includes(delta.id)) return
  observations.push({ event: 'changed', keys: Object.keys(delta) })
  if (caseName.startsWith('early-confirm-'))
    void browser.downloads.search({ id: delta.id }).then(([d]) => {
      if (d)
        observations.push({
          event: 'native-status',
          id: d.id,
          start: d.startTime,
          state: d.state,
          paused: d.paused,
          error: d.error,
          canResume: d.canResume,
        })
    })
})
const replaySource = observeReplaySources(startDownloadProtection())
const deps = {
  replaySource,
  popup: {
    captureWindow: async () =>
      (await browser.windows.getLastFocused()).id ?? null,
    present: async () => {},
  },

  getConfig: async () => config,
  isPaired: async () => true,
  gate: { shouldAutoConnect: async () => true },
  nudge: { maybeNudge: async () => {} },
  captureGuard: async () => ({
    origin: 'auto',
    endpointId: 'fixture',
    assertCurrent() {},
  }),
  selfExtensionId: browser.runtime.id,
  manager: {
    getState: () => 'connected',
    getRpcStatus: () => ({ health: 'healthy' }),
    submitDownload: submit,
  },
  notify() {},
} as unknown as ChromiumInterceptionDeps
if (nativeBrowser.downloads.onDeterminingFilename)
  registerChromiumInterception(deps)
else {
  registerFirefoxInterception(deps)
  registerWebRequestEarlyTakeover(deps)
}
const service = new DownloadConfirmationService({
  supported: () => true,
  userAgent: () => navigator.userAgent,
  publish() {},
  open: async (windowId) => {
    confirmations++
    if (caseName === 'early-confirm-unavailable')
      throw new Error('popup unavailable')
    await new Promise((r) => setTimeout(r, 350))
    const draft = service.get(windowId)
    if (!draft) throw new Error('missing draft')
    if (draft.target.pausedDownloadId === undefined)
      throw new Error('Missing native ID')
    const [item] = await browser.downloads.search({
      id: draft.target.pausedDownloadId,
    })
    observations.push({
      event: 'confirmation-hold',
      nativeCount: nativeIds.length,
      paused: item?.paused,
      id: item?.id,
    })
    observations.push({
      event: 'confirmation-filename',
      filename: draft.options.filename,
    })
    if (caseName === 'early-confirm-accept') {
      // Longer than the Chromium filename deadline and the fixture's entire transfer.
      await new Promise((r) => setTimeout(r, 12500))
      const [held] = await browser.downloads.search({
        id: draft.target.pausedDownloadId,
      })
      observations.push({
        event: 'quiet-hold',
        stable:
          held?.paused === true && held.bytesReceived === item?.bytesReceived,
      })
    }
    const action = caseName.endsWith('-browser')
      ? 'browser'
      : caseName.endsWith('-cancel')
        ? 'cancel'
        : 'submit'
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    try {
      // The runner tab is in the background during the native download. Mount
      // before driving the button so throttled timers cannot miss the commit.
      flushSync(() => {
        root.render(
          createElement(DownloadConfirmationForm, {
            draft,
            onDismiss: () => service.close(windowId),
            onDecide: (decision) =>
              service.decide(windowId, draft.id, decision),
          })
        )
      })
      const label = i18n.t(
        action === 'browser'
          ? 'popup.confirmDownload.keepBrowser'
          : action === 'cancel'
            ? 'popup.quickAdd.cancel'
            : 'popup.quickAdd.add'
      )
      let clicked = false
      const deadline = Date.now() + 2000
      while (!clicked && Date.now() < deadline) {
        const button = Array.from(document.querySelectorAll('button')).find(
          (b) => b.textContent?.trim() === label
        )
        if (button && !button.disabled) {
          button.click()
          clicked = true
        } else await new Promise((r) => setTimeout(r, 20))
      }
      observations.push({
        event: 'form-click',
        action,
        clicked,
        ...(!clicked
          ? {
              label,
              buttons: [...document.querySelectorAll('button')].map((b) => [
                b.textContent,
                b.disabled,
              ]),
              text: document.body.innerText.slice(0, 500),
            }
          : {}),
      })
    } catch (error) {
      observations.push({ event: 'form-error', message: String(error) })
      throw error
    } finally {
      root.unmount()
      host.remove()
    }
  },
})
const actions: Parameters<typeof registerNativeConfirmation>[0]['actions'] = (
  target,
  guard,
  beforeSend
) =>
  createConfirmedDownloadActions(
    {
      ...deps,
      confirmation: service,
      submissions: {
        run: async (request, prepare) => {
          const params = await prepare({ assertCurrent() {} } as Parameters<
            typeof prepare
          >[0])
          return submit({ ...params, idempotencyKey: request.idempotencyKey })
        },
      },
    },
    target,
    guard,
    beforeSend
  )
registerNativeConfirmation({
  ...deps,
  replaySource,
  confirmation: {
    dismissPausedDownloads: (id) => service.dismissPausedDownloads(id),
    request: async (...args) => {
      const result = await service.request(...args)
      observations.push({
        event: 'confirmation-settled',
        action: result.action,
      })
      confirmationSettled = true
      return result
    },
  },
  operations: async () => [],
  report: (outcome) => observations.push({ event: 'report', outcome }),
  actions,
})

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
    client?.close()
    client = new WebSocketClient()
    connection = await client.connect(
      `${input.baseUrl.replace('http:', 'ws:')}/mdxp?case=${encodeURIComponent(input.name)}`,
      'motrix-mdxp-test'
    )
    connection.listen()
    InitializeResultSchema.parse(
      await connection.sendRequest(Methods.MotrixInitialize, {
        protocolVersion: '1.0',
        client: {
          kind: 'extension',
          name: 'takeover-fixture',
          version: '1.0',
          extensionId: browser.runtime.id,
          browser: nativeBrowser.downloads.onDeterminingFilename
            ? 'chromium'
            : 'firefox',
          browserVersion: navigator.userAgent,
          locale: 'en',
        },
        capabilities: { submitDownload: true },
        adapters: [],
      })
    )
    observations.length = 0
    submits = 0
    confirmations = 0
    nativeId = undefined
    nativeIds = []
    caseName = input.name
    confirmationSettled = false
    await browser.storage.local.set({
      'motrix.earlyTakeover': {
        enabled: input.name.startsWith('early-') && input.name !== 'early-kill',
      },
    })
    if (input.name === 'early-default')
      await browser.storage.local.remove('motrix.earlyTakeover')
    config = {
      ...TAKEOVER_DEFAULT,
      enabled: input.name !== 'early-off',
      downloadMode:
        ['confirm', 'early-protected'].includes(input.name) ||
        input.name.startsWith('early-confirm-')
          ? 'confirm'
          : 'direct',
      unknownSizeAction: input.name === 'unknown-motrix' ? 'motrix' : 'chrome',
      rules: ['small', 'early-small'].includes(input.name)
        ? [{ id: 'small', match: { minSizeMB: 10 }, action: 'chrome' }]
        : [
              'early-excluded',
              'early-protected',
              'early-protected-direct',
              'confirm',
            ].includes(input.name)
          ? [
              {
                id: 'excluded',
                match: { domains: ['127.0.0.1'] },
                action: 'chrome',
              },
            ]
          : [],
    }
    await browser.storage.local.set({ [TAKEOVER_CONFIG_KEY]: config })
    const tab = await browser.tabs.create({
      url: `${input.baseUrl}/start/${input.name}${nativeBrowser.downloads.onDeterminingFilename ? '?click=1' : ''}`,
    })
    const deadline =
      Date.now() + (input.name.startsWith('early-') ? 1800 : 4200)
    while (Date.now() < deadline && submits === 0 && confirmations === 0)
      await new Promise((resolve) => setTimeout(resolve, 50))
    if (input.name.startsWith('early-'))
      await new Promise((resolve) => setTimeout(resolve, 500))
    if (input.name.startsWith('early-confirm-')) {
      // Persisting the decision and creating a native download are asynchronous.
      // Wait for the actual outcome instead of attributing late events to the next case.
      const confirmationDeadline =
        Date.now() + (input.name === 'early-confirm-accept' ? 17000 : 5000)
      while (
        Date.now() < confirmationDeadline &&
        (!confirmationSettled ||
          (input.name === 'early-confirm-browser' && nativeIds.length === 0))
      )
        await new Promise((resolve) => setTimeout(resolve, 50))
      if (!confirmationSettled)
        observations.push({ event: 'confirmation-timeout' })
    }
    if (
      [
        'confirm',
        'early-protected',
        'early-protected-direct',
        'early-confirm-browser',
        'early-confirm-rejected',
        'early-confirm-unavailable',
      ].includes(input.name)
    ) {
      const until = Date.now() + 6000
      while (
        Date.now() < until &&
        nativeId !== undefined &&
        (await browser.downloads.search({ id: nativeId }))[0]?.state ===
          'in_progress'
      )
        await new Promise((r) => setTimeout(r, 50))
    }
    const items =
      nativeId === undefined
        ? []
        : await browser.downloads.search({ id: nativeId })
    const result = {
      name: input.name,
      submits,
      confirmations,
      observations: [...observations],
      nativeCount: nativeIds.length,
      native: items.map(({ id, state, totalBytes, paused, filename }) => ({
        id,
        filename,
        state,
        totalBytes,
        paused,
      })),
    }
    for (const id of nativeIds) {
      await browser.downloads.cancel(id).catch(() => {})
      await browser.downloads.erase({ id })
    }
    if (tab.id !== undefined) await browser.tabs.remove(tab.id)
    // Let cancellation events settle before clearing observations for the next case.
    await new Promise((resolve) => setTimeout(resolve, 100))
    client.close()
    return result
  },
})
