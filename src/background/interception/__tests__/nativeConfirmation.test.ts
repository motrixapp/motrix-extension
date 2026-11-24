import { expect, it, vi } from 'vitest'
import type { ConfirmationActions } from '@/background/DownloadConfirmationService'
import { DownloadOutcomeUnknownError } from '@/background/download-errors'
import { registerNativeConfirmation } from '@/background/interception/nativeConfirmation'
import { extensionBrowser as browser } from '@/shared/browser'
import { TAKEOVER_DEFAULT } from '@/shared/takeover'

function setup(
  fault: 'unknown' | 'rejected' | 'cleanup' | 'ok',
  saved: Record<string, unknown> = {}
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
    storage: {
      onChanged: { addListener: vi.fn() },
      local,
      session: { ...local, get: async () => ({}) },
    },
  })
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
    replaySource: () => ({ url: item.url, allowed: () => true }),
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

it('pre-pauses eligible Chromium downloads immediately and resumes if confirmation aborts', async () => {
  const f = setup('ok', {
    'motrix.takeoverConfig': {
      ...TAKEOVER_DEFAULT,
      enabled: true,
      downloadMode: 'confirm',
    },
  })
  // Allow the initial storage read in registerNativeConfirmation to populate cache.
  await Promise.resolve()
  await Promise.resolve()
  f.create()
  expect(f.downloads.pause).toHaveBeenCalledWith(42)
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalledTimes(1))
  // Already pre-paused, so holdForDecision does not issue a duplicate pause.
  expect(f.downloads.pause).toHaveBeenCalledTimes(1)
  expect(f.downloads.cancel).toHaveBeenCalledTimes(1)
})

it('resumes a pre-paused download if getConfig rejects and skips pre-pause on fallback sources', async () => {
  const saved: Record<string, unknown> = {
    'motrix.takeoverConfig': {
      ...TAKEOVER_DEFAULT,
      enabled: true,
      downloadMode: 'confirm',
    },
  }
  const item = {
    id: 77,
    startTime: '2026-01-01',
    url: 'https://files.example/asset.zip',
    state: 'in_progress',
    paused: false,
    totalBytes: 1024,
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
    cancel: vi.fn(async () => {}),
  }
  const local = {
    get: async () => ({ ...saved }),
    set: async (data: object) => Object.assign(saved, data),
    remove: async (k: string) => {
      delete saved[k]
    },
  }
  Object.assign(browser, {
    downloads,
    storage: {
      onChanged: { addListener: vi.fn() },
      local,
      session: { ...local, get: async () => ({}) },
    },
  })
  let isFallback = false
  const report = vi.fn()
  registerNativeConfirmation({
    getConfig: async () => {
      throw new Error('config read failed')
    },
    selfExtensionId: 'self',
    captureGuard: async () => null,
    popup: { captureWindow: async () => 1 } as never,
    replaySource: () => ({
      url: item.url,
      fallback: isFallback,
      allowed: () => true,
    }),
    actions: () => ({ submit: vi.fn() }),
    confirmation: { request: vi.fn(), dismissPausedDownloads: vi.fn() },
    operations: async () => [],
    report,
  })
  await Promise.resolve()
  await Promise.resolve()
  const onCreated = downloads.onCreated.addListener.mock.calls[0]?.[0]
  onCreated(item)
  await vi.waitFor(() => expect(downloads.resume).toHaveBeenCalledWith(77))
  expect(downloads.pause).toHaveBeenCalledTimes(1)

  downloads.pause.mockClear()
  downloads.resume.mockClear()
  isFallback = true
  onCreated({ ...item, id: 78 })
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2))
  expect(downloads.pause).not.toHaveBeenCalled()

  // Already-paused downloads must never be pre-paused or resumed on abort.
  downloads.pause.mockClear()
  downloads.resume.mockClear()
  isFallback = false
  onCreated({ ...item, id: 79, paused: true })
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(3))
  expect(downloads.pause).not.toHaveBeenCalled()
  expect(downloads.resume).not.toHaveBeenCalled()
})

it('resumes a pre-paused download when startup recovery rejects or holdForDecision fails before entering try', async () => {
  const saved: Record<string, unknown> = {
    'motrix.takeoverConfig': {
      ...TAKEOVER_DEFAULT,
      enabled: true,
      downloadMode: 'confirm',
    },
  }
  const item = {
    id: 88,
    startTime: '2026-01-01',
    url: 'https://files.example/asset.zip',
    state: 'in_progress',
    paused: false,
    totalBytes: 1024,
  }
  const downloads = {
    onCreated: { addListener: vi.fn() },
    onChanged: { addListener: vi.fn() },
    search: vi.fn(async () => [{ ...item }]),
    pause: vi.fn(async () => {
      item.paused = true
    }),
    resume: vi.fn(async () => {
      item.paused = false
    }),
    cancel: vi.fn(async () => {}),
  }
  let failGet = false
  const local = {
    get: vi.fn(async (key: unknown) => {
      if (key === null && failGet) throw new Error('storage down')
      return { ...saved }
    }),
    set: async (data: object) => Object.assign(saved, data),
    remove: async (k: string) => {
      delete saved[k]
    },
  }
  Object.assign(browser, {
    downloads,
    storage: {
      onChanged: { addListener: vi.fn() },
      local,
      session: { ...local, get: async () => ({}) },
    },
  })
  failGet = true
  const report = vi.fn()
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
    replaySource: () => ({ url: item.url, allowed: () => true }),
    actions: () => ({ submit: vi.fn() }),
    confirmation: { request: vi.fn(), dismissPausedDownloads: vi.fn() },
    operations: async () => [],
    report,
  })
  await Promise.resolve()
  await Promise.resolve()
  const onCreated = downloads.onCreated.addListener.mock.calls[0]?.[0]
  onCreated(item)
  await vi.waitFor(() => expect(downloads.resume).toHaveBeenCalledWith(88))
  expect(downloads.pause).toHaveBeenCalledWith(88)
})

it('continues confirmation when prePause becomes visible on the second live check', async () => {
  const f = setup('ok', {
    'motrix.takeoverConfig': {
      ...TAKEOVER_DEFAULT,
      enabled: true,
      downloadMode: 'confirm',
    },
  })
  let searchCalls = 0
  f.downloads.search = async () => {
    searchCalls += 1
    // First search returns stale unpaused snapshot; second sees our prePause.
    return [{ ...f.item, paused: searchCalls > 1 }]
  }
  await Promise.resolve()
  await Promise.resolve()
  f.create()
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalledTimes(1))
  expect(f.downloads.pause).toHaveBeenCalledTimes(1)
  expect(f.downloads.cancel).toHaveBeenCalledTimes(1)
})

it('falls back to the captured window when a target=_blank download tab already closed and dismisses on USER_CANCELED', async () => {
  const item = {
    id: 95,
    startTime: '2026-01-01',
    url: 'https://pan.example/file.zip',
    state: 'in_progress',
    paused: false,
    totalBytes: 2048,
  }
  const saved: Record<string, unknown> = {}
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
      Object.assign(item, {
        paused: false,
        state: 'interrupted',
        error: 'USER_CANCELED',
      })
    }),
  }
  Object.assign(browser, {
    downloads,
    tabs: {
      get: vi.fn(async () => {
        throw new Error('No tab with id: 99')
      }),
    },
    storage: {
      onChanged: { addListener: vi.fn() },
      local,
      session: { ...local, get: async () => ({}) },
    },
  })
  const dismissPausedDownloads = vi.fn()
  const request = vi.fn(
    async (_target, windowId: number, actions: ConfirmationActions) => {
      expect(windowId).toBe(7)
      await actions.submit({} as never, 'op-95')
      return { action: 'accepted' as const, taskId: 'task-95' }
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
    popup: { captureWindow: async () => 7 } as never,
    replaySource: () => ({ tabId: 99, url: item.url, allowed: () => true }),
    actions: () => ({ submit: vi.fn(async () => ({ taskId: 'task-95' })) }),
    confirmation: { request, dismissPausedDownloads },
    operations: async () => [],
    report: vi.fn(),
  })
  downloads.onCreated.addListener.mock.calls[0]?.[0](item)
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))

  downloads.onChanged.addListener.mock.calls[0]?.[0]({
    id: 95,
    error: { current: 'USER_CANCELED' },
  })
  expect(dismissPausedDownloads).toHaveBeenCalledWith(95)
})
