import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { normalizeTarget } from '@/background/capture/normalizeTarget'
import { createDownloadConfirmation } from '@/background/downloadConfirmation'
import type { ChromiumInterceptionDeps } from '@/background/interception/chromium'
import { confirmInterceptedDownload } from '@/background/interception/confirmDownload'
import { type Browser, extensionBrowser as browser } from '@/shared/browser'
import { CONFIRMATION_PORT } from '@/shared/downloadConfirmation'
import { TAKEOVER_DEFAULT } from '@/shared/takeover'

vi.mock('@/shared/platformCapabilities', () => ({
  supportsAutoOpenPopup: () => true,
}))
const target = normalizeTarget({
  url: 'https://example.com/once.zip',
  origin: 'context-menu',
})
const actions = {
  submit: vi.fn(async () => ({ taskId: 'task-1' })),
  browser: vi.fn(async () => {}),
}
let connect!: (port: Browser.runtime.Port) => void
let removed!: (windowId: number) => void
beforeEach(() => {
  Object.assign(browser, {
    windows: {
      get: vi.fn(async (id) => ({ id, focused: true, type: 'normal' })),
      onRemoved: {
        addListener: vi.fn((callback) => {
          removed = callback
        }),
      },
    },
    action: { openPopup: vi.fn(async () => {}) },
  })
  Object.assign(browser.runtime, {
    onConnect: {
      addListener: vi.fn((callback) => {
        connect = callback
      }),
    },
  })
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})
function view(windowId = 4, senderUrl = browser.runtime.getURL('popup.html')) {
  let message!: (value: unknown) => void
  let disconnect!: () => void
  const port = {
    name: CONFIRMATION_PORT,
    sender: { id: browser.runtime.id, url: senderUrl },
    onMessage: {
      addListener: (callback: typeof message) => {
        message = callback
      },
    },
    onDisconnect: {
      addListener: (callback: typeof disconnect) => {
        disconnect = callback
      },
    },
    postMessage: vi.fn(),
  }
  connect(port as never)
  message?.({ windowId })
  return { message, disconnect, port }
}
it.each([
  { stage: 'window lookup', nativeDownloadCancelled: false },
  { stage: 'window lookup', nativeDownloadCancelled: true },
  { stage: 'popup opening', nativeDownloadCancelled: false },
  { stage: 'popup opening', nativeDownloadCancelled: true },
])(
  'preserves a delivered draft after $stage times out (native cancelled: $nativeDownloadCancelled)',
  async ({ stage, nativeDownloadCancelled }) => {
    vi.useFakeTimers()
    if (stage === 'window lookup')
      vi.mocked(browser.windows.get).mockReturnValue(new Promise(() => {}))
    else
      vi.mocked(browser.action.openPopup).mockReturnValue(new Promise(() => {}))
    const service = createDownloadConfirmation()
    const settled = vi.fn()
    const pending = service
      .request(
        { ...target, origin: 'auto', nativeDownloadCancelled },
        4,
        actions
      )
      .then(settled)
    await vi.advanceTimersByTimeAsync(1)
    const popup = view()
    await vi.advanceTimersByTimeAsync(1)
    const draft = service.get(4)!
    expect(popup.port.postMessage).toHaveBeenLastCalledWith({ draft })
    const options = { ...draft.options, filename: 'user-edited.zip' }
    popup.message({ id: draft.id, decision: { action: 'edit', options } })
    await vi.advanceTimersByTimeAsync(5001)
    expect(service.get(4)).toMatchObject({ id: draft.id, options })
    expect(popup.port.postMessage).not.toHaveBeenCalledWith({ draft: null })
    expect(settled).not.toHaveBeenCalled()
    expect(actions.submit).not.toHaveBeenCalled()
    expect(actions.browser).not.toHaveBeenCalled()
    popup.message({ id: draft.id, decision: { action: 'browser' } })
    await pending
    expect(settled).toHaveBeenCalledExactlyOnceWith({ action: 'browser' })
    expect(actions.browser).toHaveBeenCalledOnce()
    expect(service.get(4)).toBeNull()
  }
)
it('does not reopen a presented draft after the view closes during window lookup', async () => {
  vi.useFakeTimers()
  let finishLookup!: (window: Browser.windows.Window) => void
  vi.mocked(browser.windows.get).mockReturnValue(
    new Promise((resolve) => {
      finishLookup = resolve
    })
  )
  const service = createDownloadConfirmation()
  const pending = service.request({ ...target, origin: 'auto' }, 4, actions)
  await vi.advanceTimersByTimeAsync(1)
  const popup = view()
  await vi.advanceTimersByTimeAsync(1)
  const draft = service.get(4)!
  popup.disconnect()
  finishLookup({
    id: 4,
    focused: true,
    type: 'normal',
  } as Browser.windows.Window)
  await vi.advanceTimersByTimeAsync(1)
  expect(browser.action.openPopup).not.toHaveBeenCalled()
  expect(service.get(4)?.id).toBe(draft.id)
  service.close(4)
  await expect(pending).resolves.toEqual({ action: 'cancel' })
})
it('preserves delivery evidence across disconnect before a late popup opening failure', async () => {
  vi.useFakeTimers()
  vi.mocked(browser.action.openPopup).mockReturnValue(new Promise(() => {}))
  const service = createDownloadConfirmation()
  const pending = service.request({ ...target, origin: 'auto' }, 4, actions)
  await vi.advanceTimersByTimeAsync(1)
  const popup = view()
  await vi.advanceTimersByTimeAsync(1)
  const draft = service.get(4)!
  expect(popup.port.postMessage).toHaveBeenLastCalledWith({ draft })
  popup.disconnect()
  await vi.advanceTimersByTimeAsync(5001)
  expect(service.get(4)?.id).toBe(draft.id)
  const resumed = view()
  await vi.advanceTimersByTimeAsync(1)
  expect(resumed.port.postMessage).toHaveBeenLastCalledWith({ draft })
  resumed.message({ id: draft.id, decision: { action: 'cancel' } })
  await expect(pending).resolves.toEqual({ action: 'cancel' })
})
it.each(['publish', 'handshake'])(
  'does not retain an automatic draft when %s delivery throws',
  async (stage) => {
    vi.useFakeTimers()
    const service = createDownloadConfirmation()
    const breakDelivery = (popup: ReturnType<typeof view>) => {
      popup.port.postMessage.mockImplementation(() => {
        throw new Error('disconnected')
      })
    }
    if (stage === 'publish') {
      const popup = view()
      await vi.advanceTimersByTimeAsync(0)
      breakDelivery(popup)
    }
    const pending = service.request({ ...target, origin: 'auto' }, 4, actions)
    if (stage === 'handshake') {
      await vi.advanceTimersByTimeAsync(1)
      breakDelivery(view())
    }
    await vi.advanceTimersByTimeAsync(5001)
    await expect(pending).resolves.toEqual({ action: 'unavailable' })
    expect(service.get(4)).toBeNull()
    const manual = view()
    await vi.advanceTimersByTimeAsync(0)
    expect(manual.port.postMessage).toHaveBeenLastCalledWith({ draft: null })
  }
)
it.each(['unfocused', 'open-rejected', 'handshake-timeout'])(
  'does not show an automatic download in a manually opened popup after %s',
  async (reason) => {
    vi.useFakeTimers()
    if (reason === 'unfocused')
      vi.mocked(browser.windows.get).mockResolvedValue({
        id: 4,
        focused: false,
        type: 'normal',
      } as never)
    if (reason === 'open-rejected')
      vi.mocked(browser.action.openPopup).mockRejectedValue(
        new Error('unavailable')
      )
    const service = createDownloadConfirmation()
    const pending = service.request({ ...target, origin: 'auto' }, 4, actions)
    await vi.advanceTimersByTimeAsync(5001)
    await expect(pending).resolves.toEqual({ action: 'unavailable' })
    const manual = view()
    await vi.waitFor(() =>
      expect(manual.port.postMessage).toHaveBeenLastCalledWith({ draft: null })
    )
    expect(actions.submit).not.toHaveBeenCalled()
    expect(actions.browser).not.toHaveBeenCalled()
  }
)
it.each([
  { totalBytes: -1, rules: [] },
  { totalBytes: 0, rules: [] },
  { totalBytes: undefined, rules: [] },
  {
    totalBytes: 1024,
    rules: [
      { id: 'small', match: { minSizeMB: 10 }, action: 'chrome' as const },
    ],
  },
  {
    totalBytes: 1024,
    rules: [
      {
        id: 'excluded',
        match: { domains: ['example.com'] },
        action: 'chrome' as const,
      },
    ],
  },
])(
  'does not leave a draft for downloads assigned to the browser: %j',
  async ({ totalBytes, rules }) => {
    const service = createDownloadConfirmation()
    const confirm = vi.fn(async (target, windowId) => {
      await service.request(target, windowId, actions)
    })
    await confirmInterceptedDownload(
      { url: target.url, totalBytes },
      { ...TAKEOVER_DEFAULT, enabled: true, downloadMode: 'confirm', rules },
      Promise.resolve(4),
      {
        confirm,
        captureGuard: async () => ({ origin: 'auto', assertCurrent: vi.fn() }),
      } as unknown as ChromiumInterceptionDeps
    )
    const manual = view()
    await vi.waitFor(() =>
      expect(manual.port.postMessage).toHaveBeenLastCalledWith({ draft: null })
    )
    expect(confirm).not.toHaveBeenCalled()
    expect(browser.action.openPopup).not.toHaveBeenCalled()
    expect(actions.submit).not.toHaveBeenCalled()
    expect(actions.browser).not.toHaveBeenCalled()
  }
)
it('rejects an unfocused source window instead of selecting the new focused window', async () => {
  vi.mocked(browser.windows.get).mockResolvedValue({
    id: 4,
    focused: false,
    type: 'normal',
  } as never)
  const service = createDownloadConfirmation()
  await expect(service.request(target, 4, actions)).resolves.toEqual({
    action: 'unavailable',
  })
  expect(browser.windows.get).toHaveBeenCalledWith(4)
  expect(browser.action.openPopup).not.toHaveBeenCalled()
})
it('does not open a cancelled draft after the window lookup finishes', async () => {
  let resolve!: (value: unknown) => void
  vi.mocked(browser.windows.get).mockReturnValue(
    new Promise((done) => {
      resolve = done
    }) as never
  )
  const service = createDownloadConfirmation()
  const pending = service.request(target, 4, actions)
  service.cancelAll()
  resolve({ id: 4, focused: true, type: 'normal' })
  await expect(pending).resolves.toEqual({ action: 'cancel' })
  await Promise.resolve()
  expect(browser.action.openPopup).not.toHaveBeenCalled()
})
it.each(['auto', 'context-menu'] as const)(
  'preserves edited %s drafts across popup disconnect and restores them into a new view',
  async (origin) => {
    const service = createDownloadConfirmation()
    const v = view()
    const pending = service.request({ ...target, origin }, 4, actions)
    await vi.waitFor(() =>
      expect(v.port.postMessage).toHaveBeenCalledWith({
        draft: expect.objectContaining({ target: { ...target, origin } }),
      })
    )
    expect(browser.action.openPopup).not.toHaveBeenCalled()
    expect(browser.windows.get).not.toHaveBeenCalled()
    const draft = service.get(4)!
    const options = {
      ...draft.options,
      filename: 'resume.zip',
      extraHeaders: 'X-Unfinished:',
    }
    v.message({ id: draft.id, decision: { action: 'edit', options } })
    v.disconnect()
    expect(service.get(4)?.options).toEqual(options)
    const resumed = view()
    await vi.waitFor(() =>
      expect(resumed.port.postMessage).toHaveBeenCalledWith({
        draft: expect.objectContaining({ id: draft.id, options }),
      })
    )
    expect(actions.submit).not.toHaveBeenCalled()
    resumed.message({ id: draft.id, decision: { action: 'cancel' } })
    await expect(pending).resolves.toEqual({ action: 'cancel' })
  }
)
it('bounds waiting for a popup that closed before its handshake', async () => {
  vi.useFakeTimers()
  const service = createDownloadConfirmation()
  const pending = service.request(target, 4, actions)
  await vi.advanceTimersByTimeAsync(5001)
  await expect(pending).resolves.toEqual({ action: 'unavailable' })
  expect(service.get(4)).not.toBeNull()
  service.close(4)
})
it('only accepts its popup and does not allow a registered port to change windows', async () => {
  const service = createDownloadConfirmation()
  const invalid = view(4, 'https://example.com/')
  expect(invalid.port.postMessage).not.toHaveBeenCalled()
  const v = view(4)
  v.message({ windowId: 5 })
  const pending = service.request(target, 4, actions)
  v.message({ id: service.get(4)!.id, decision: { action: 'cancel' } })
  await expect(pending).resolves.toEqual({ action: 'cancel' })
})
it('releases a pending draft when its window closes', async () => {
  const service = createDownloadConfirmation()
  const pending = service.request(target, 4, actions)
  removed(4)
  await expect(pending).resolves.toEqual({ action: 'cancel' })
})
