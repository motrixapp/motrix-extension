import { afterEach, expect, it, vi } from 'vitest'
import { DownloadConfirmationService } from '@/background/DownloadConfirmationService'
import { registerReleaseClicks } from '@/background/interception/releaseClick'
import { extensionBrowser as browser } from '@/shared/browser'
import { RELEASE_CLICK_PORT } from '@/shared/releaseClick'
import { TAKEOVER_DEFAULT } from '@/shared/takeover'

const url = 'https://dl.motrix.app/releases/Motrix-2.4.3.dmg'
function setup() {
  const listen = vi.fn(),
    send = vi.fn(),
    disconnected = vi.fn(),
    download = vi.fn(async () => 1),
    submit = vi.fn(async () => ({ taskId: 'task' }))
  const port = {
    name: RELEASE_CLICK_PORT,
    sender: {
      id: browser.runtime.id,
      url: 'https://motrix.app/zh/download/',
      frameId: 0,
      tab: { id: 12, windowId: 1 },
    },
    onMessage: { addListener: send },
    onDisconnect: { addListener: disconnected },
    disconnect: vi.fn(),
    postMessage: vi.fn(),
  }
  Object.assign(browser.runtime, { onConnect: { addListener: listen } })
  Object.assign(browser, { downloads: { download } })
  const cfg = {
    ...TAKEOVER_DEFAULT,
    enabled: true,
    downloadMode: 'confirm' as const,
    releaseClick: true,
  }
  const confirmation = new DownloadConfirmationService({
    supported: () => true,
    open: async () => {},
    publish() {},
    userAgent: () => '',
  })
  const protectedUrl = vi.fn(() => false)
  registerReleaseClicks({
    getConfig: async () => cfg,
    captureGuard: async () => ({
      origin: 'auto',
      endpointId: 'local',
      assertCurrent() {},
    }),
    available: () => true,
    protected: protectedUrl,
    confirmation,
    actions: () => ({ submit }),
    report: vi.fn(),
  })
  listen.mock.calls[0]?.[0](port)
  return {
    cfg,
    confirmation,
    port,
    download,
    submit,
    protectedUrl,
    message: (m: unknown) => send.mock.calls[0]?.[0](m),
    disconnect: () => disconnected.mock.calls[0]?.[0](),
  }
}
afterEach(() => vi.useRealTimers())
it.each(['off', 'excluded', 'wrong file', 'too small'])(
  'keeps the native click for %s',
  async (reason) => {
    const f = setup()
    if (reason === 'off') f.cfg.releaseClick = false
    if (reason === 'excluded') f.protectedUrl.mockReturnValue(true)
    if (reason === 'too small')
      f.cfg.rules = [{ id: 'small', match: { minSizeMB: 1 }, action: 'chrome' }]
    await f.message({
      url: reason === 'wrong file' ? `${url}?signature=abc` : url,
      size: 100,
    })
    expect(f.port.disconnect).toHaveBeenCalledOnce()
    expect(f.port.postMessage).not.toHaveBeenCalled()
    expect(f.download).not.toHaveBeenCalled()
  }
)
it('requires the page acknowledgement before submission and releases a detached view without sending', async () => {
  const f = setup()
  await f.message({ url, size: 100 })
  expect(f.port.postMessage).toHaveBeenCalledWith('ready')
  const ongoing = f.message('choose')
  await vi.waitFor(() => expect(f.confirmation.get(1)).toBeTruthy())
  const draft = f.confirmation.get(1)!
  f.confirmation.decide(1, draft.id, {
    action: 'submit',
    options: draft.options,
  })
  await vi.waitFor(() =>
    expect(f.port.postMessage).toHaveBeenCalledWith('take')
  )
  expect(f.submit).not.toHaveBeenCalled()
  f.disconnect()
  await ongoing
  expect(f.submit).not.toHaveBeenCalled()
  expect(f.download).not.toHaveBeenCalled()
})
it('runs at most one browser fallback when an unsubmitted form closes', async () => {
  const f = setup()
  await f.message({ url, size: 100 })
  const ongoing = f.message('choose')
  await vi.waitFor(() => expect(f.confirmation.get(1)).toBeTruthy())
  f.confirmation.close(1)
  await vi.waitFor(() =>
    expect(f.port.postMessage).toHaveBeenCalledWith('take')
  )
  expect(f.download).not.toHaveBeenCalled()
  await f.message('ack')
  await ongoing
  expect(f.download).toHaveBeenCalledExactlyOnceWith({ url })
})
