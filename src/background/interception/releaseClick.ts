import { normalizeTarget } from '@/background/capture/normalizeTarget'
import { downloadHttpInBrowser } from '@/background/contextMenu/register'
import type {
  ConfirmationActions,
  DownloadConfirmationService,
} from '@/background/DownloadConfirmationService'
import {
  beforeDeadline,
  DownloadOutcomeUnknownError,
  DownloadPreparationError,
} from '@/background/download-errors'
import {
  HandoffEndpointChangedError,
  type HandoffGuard,
} from '@/background/handoff/guard'
import { decideTakeover } from '@/background/policy/decideTakeover'
import { type Browser, extensionBrowser as browser } from '@/shared/browser'
import { DOWNLOAD_ERROR } from '@/shared/integration'
import {
  publicRelease,
  RELEASE_CLICK_PORT,
  releasePage,
} from '@/shared/releaseClick'
import type { TakeoverConfig, TakeoverTarget } from '@/shared/takeover'

interface ClickDeps {
  getConfig(): Promise<TakeoverConfig>
  captureGuard(): Promise<HandoffGuard | null>
  available(): boolean
  protected(role: 'source' | 'resource', url: string): boolean
  confirmation: Pick<DownloadConfirmationService, 'request' | 'get' | 'close'>
  actions(
    target: TakeoverTarget,
    guard: HandoffGuard,
    beforeSend: () => Promise<void>
  ): ConfirmationActions
  report(outcome: 'rejected' | 'unknown' | 'browser'): void
}

export function registerReleaseClicks(
  deps: ClickDeps,
  trustedPage = releasePage,
  trustedFile = publicRelease
) {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== RELEASE_CLICK_PORT) return
    const sender = port.sender
    if (
      sender?.id !== browser.runtime.id ||
      sender.frameId !== 0 ||
      sender.tab?.id === undefined ||
      sender.tab.incognito ||
      !sender.url ||
      !trustedPage(sender.url)
    ) {
      port.disconnect()
      return
    }
    registerIntent(
      port,
      sender.tab.windowId,
      new URL(sender.url).origin + new URL(sender.url).pathname,
      deps,
      trustedFile
    )
  })
}

function registerIntent(
  port: Browser.runtime.Port,
  windowId: number,
  page: string,
  deps: ClickDeps,
  trustedFile: (url: string) => boolean
) {
  let target: TakeoverTarget | undefined
  let guard: HandoffGuard | null = null
  let armed = false
  let choosing = false
  let connected = true
  let delegated = false
  let ack: ((accepted: boolean) => void) | undefined
  const id = crypto.randomUUID()
  const timeout = setTimeout(close, 30_000)
  function detached() {
    if (!connected) return
    connected = false
    clearTimeout(timeout)
    ack?.(false)
    if (deps.confirmation.get(windowId)?.target.releaseClickId === id)
      deps.confirmation.close(windowId)
  }
  function close() {
    if (!connected) return
    detached()
    port.disconnect()
  }
  port.onDisconnect.addListener(detached)
  // While the form is open the page still owns the original gesture. If the
  // worker dies, the page can restore it. No side effects precede this ACK.
  async function take() {
    if (delegated) return
    if (!connected) throw new Error('download page closed')
    const answer = new Promise<boolean>((resolve) => {
      ack = resolve
    })
    port.postMessage('take')
    if (!(await beforeDeadline(answer, Date.now() + 2000)))
      throw new Error('page did not transfer download')
    delegated = true
    ack = undefined
  }
  const check = async (t: TakeoverTarget, g: HandoffGuard) => {
    const cfg = await deps.getConfig()
    g.assertCurrent()
    if (
      !connected ||
      !deps.available() ||
      !cfg.releaseClick ||
      cfg.downloadMode !== 'confirm' ||
      deps.protected('source', page) ||
      deps.protected('resource', t.url) ||
      decideTakeover(cfg, t) !== 'motrix'
    )
      throw new DownloadPreparationError(DOWNLOAD_ERROR.contextChanged)
  }
  const choose = async (
    t: TakeoverTarget,
    g: HandoffGuard,
    browserOnly: boolean
  ) => {
    let attempted = false
    let flight: Promise<unknown> | undefined
    function track<T>(task: Promise<T>) {
      flight = task
      return task
    }
    const inBrowser = async () => {
      await take()
      if (attempted) return
      attempted = true
      try {
        await downloadHttpInBrowser(t.url)
      } catch {
        deps.report('browser')
        throw new DownloadOutcomeUnknownError()
      }
    }
    try {
      await check(t, g)
      if (browserOnly) {
        await inBrowser()
        return
      }
      const base = deps.actions(t, g, () => check(t, g))
      const submit: ConfirmationActions['submit'] = async (
        options,
        operationId
      ) => {
        await take()
        try {
          await check(t, g)
          return await base.submit(options, operationId)
        } catch (error) {
          if (
            !(
              error instanceof DownloadPreparationError ||
              error instanceof HandoffEndpointChangedError
            )
          ) {
            deps.report('unknown')
            throw new DownloadOutcomeUnknownError()
          }
          deps.report('rejected')
          await inBrowser()
          throw error
        }
      }
      await deps.confirmation.request(t, windowId, {
        browser: () => track(inBrowser()),
        cancel: () => track(take()),
        submit: (options, id) => track(submit(options, id)),
      })
      // Dismissal, expiry, a busy window or a missing popup returns the
      // gesture to the browser. Explicit cancellation has already taken it.
      if (flight) await flight.catch(() => {})
      if (connected && !delegated) await inBrowser()
    } finally {
      close()
    }
  }
  port.onMessage.addListener(async (message: unknown) => {
    try {
      if (message === 'ack') {
        ack?.(true)
        return
      }
      if (message === 'choose' || message === 'browser') {
        if (!armed || choosing || !target || !guard) return
        choosing = true
        clearTimeout(timeout)
        await choose(target, guard, message === 'browser')
        return
      }
      if (
        target ||
        !message ||
        typeof message !== 'object' ||
        !('url' in message) ||
        typeof message.url !== 'string' ||
        !trustedFile(message.url) ||
        !('size' in message) ||
        typeof message.size !== 'number' ||
        !Number.isSafeInteger(message.size) ||
        message.size <= 0
      ) {
        close()
        return
      }
      target = {
        ...normalizeTarget({
          url: message.url,
          referrer: page,
          sizeBytes: message.size,
          origin: 'auto',
        }),
        releaseClickId: id,
      }
      guard = await deps.captureGuard()
      if (!guard) throw new Error('unavailable')
      await check(target, guard)
      armed = true
      port.postMessage('ready')
    } catch {
      close()
    }
  })
}
