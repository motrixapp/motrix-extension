import { expect, it, vi } from 'vitest'
import type { ConfirmationActions } from '@/background/DownloadConfirmationService'
import { DownloadOutcomeUnknownError } from '@/background/download-errors'
import { registerNativeConfirmation } from '@/background/interception/nativeConfirmation'
import { observeReplaySources } from '@/background/interception/replaySource'
import { extensionBrowser as browser } from '@/shared/browser'
import { TAKEOVER_DEFAULT } from '@/shared/takeover'

function setup(
  fault: 'unknown' | 'rejected' | 'cleanup' | 'ok',
  saved: Record<string, unknown> = {},
  realReplay = false,
  protectedUrl = false
) {
  const item = {
    id: 42,
    startTime: '2026-01-01',
    url: 'https://files.example/asset.zip',
    state: 'in_progress',
    paused: false,
    totalBytes: 1024,
  }
  const local = {
    get: async () => ({ ...saved }),
    set: async (data: object) => Object.assign(saved, data),
    remove: async (k: string) => {
      delete saved[k]
    },
  }
  const downloads = {
    onCreated: { addListener: vi.fn() },
    onChanged: { addListener: vi.fn() },
    search: async () => [{ ...item }],
    pause: vi.fn(async () => {
      item.paused = true
    }),
    resume: vi.fn(async () => {
      item.paused = false
    }),
    cancel: vi.fn(async () => {
      if (fault === 'cleanup') throw Error('busy')
      Object.assign(item, {
        paused: false,
        state: 'interrupted',
        error: 'USER_CANCELED',
      })
    }),
  }
  Object.assign(browser, {
    downloads,
    tabs: { get: vi.fn(async () => ({ windowId: 1 })) },
    storage: {
      onChanged: { addListener: vi.fn() },
      local,
      session: { ...local, get: async () => ({}) },
    },
  })
  const before = { addListener: vi.fn() }
  const redirect = { addListener: vi.fn() }
  const headers = { addListener: vi.fn() }
  Object.assign(browser, {
    webRequest: {
      onBeforeRequest: before,
      onBeforeRedirect: redirect,
      onHeadersReceived: headers,
    },
  })
  const replay = observeReplaySources(() => protectedUrl)
  if (realReplay) {
    before.addListener.mock.calls[0]![0]({
      requestId: 'real',
      url: item.url,
      method: 'GET',
      type: 'main_frame',
      tabId: 1,
    })
    headers.addListener.mock.calls[0]![0]({
      requestId: 'real',
      url: item.url,
      method: 'GET',
      statusCode: 200,
    })
  }
  const report = vi.fn()
  const submit = vi.fn(async () => {
    if (fault === 'unknown') throw new DownloadOutcomeUnknownError()
    if (fault === 'rejected') throw Error('rejected')
    return { taskId: 'accepted' }
  })
  const request = vi.fn(
    async (_target, _window, actions: ConfirmationActions) => {
      try {
        await actions.submit({} as never, 'operation')
      } catch {}
      return { action: 'cancel' as const }
    }
  )
  registerNativeConfirmation({
    getConfig: async () => ({
      ...TAKEOVER_DEFAULT,
      enabled: true,
      downloadMode: 'confirm',
    }),
    selfExtensionId: 'self',
    captureGuard: async () => ({
      origin: 'auto',
      endpointId: 'pc',
      assertCurrent() {},
    }),
    popup: { captureWindow: async () => 1 } as never,
    replaySource: realReplay
      ? replay
      : () => ({ url: item.url, allowed: () => true }),
    actions: () => ({ submit }),
    confirmation: { request, dismissPausedDownloads: vi.fn() },
    operations: async () => [],
    report,
  })
  return {
    create: () => downloads.onCreated.addListener.mock.calls[0]![0](item),
    item,
    downloads,
    report,
    saved,
    submit,
  }
}
it('passes a tracked ordinary download through the confirmation adapter', async () => {
  const f = setup('ok', {}, true)
  f.create()
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce())
})

it('does not pause or submit a protected download', async () => {
  const f = setup('ok', {}, true, true)
  f.create()
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(f.downloads.pause).not.toHaveBeenCalled()
  expect(f.submit).not.toHaveBeenCalled()
})
it.each(['unknown', 'rejected', 'cleanup'] as const)(
  'preserves ownership after %s',
  async (fault) => {
    const f = setup(fault)
    f.create()
    await vi.waitFor(() =>
      expect(f.report).toHaveBeenCalledWith(
        fault === 'rejected' ? 'resumed' : fault
      )
    )
    expect(f.submit).toHaveBeenCalledTimes(1)
    expect(f.downloads.resume).toHaveBeenCalledTimes(
      fault === 'rejected' ? 1 : 0
    )
    expect(f.downloads.cancel).toHaveBeenCalledTimes(
      fault === 'cleanup' ? 1 : 0
    )
    if (fault === 'rejected') expect(Object.keys(f.saved)).toHaveLength(0)
    else
      expect(Object.values(f.saved)[0]).toMatchObject({
        phase: fault === 'unknown' ? 'submitting' : 'accepted',
        operationId: 'operation',
      })
  }
)
it.each(['editing', 'submitting', 'accepted'])(
  'reconciles a paused %s operation after a restart',
  async (phase) => {
    const f = setup('ok', {
      'motrix.pausedDownload.42': {
        id: 42,
        startTime: '2026-01-01',
        endpointId: 'pc',
        revision: 0,
        phase,
      },
    })
    f.item.paused = true
    if (phase === 'submitting')
      await vi.waitFor(() => expect(f.report).toHaveBeenCalledWith('unknown'))
    else await vi.waitFor(() => expect(Object.keys(f.saved)).toHaveLength(0))
    expect(f.downloads.resume).toHaveBeenCalledTimes(
      phase === 'editing' ? 1 : 0
    )
    expect(f.downloads.cancel).toHaveBeenCalledTimes(
      phase === 'accepted' ? 1 : 0
    )
    expect(f.submit).not.toHaveBeenCalled()
  }
)
