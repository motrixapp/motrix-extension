import { normalizeTarget } from '@/background/capture/normalizeTarget'
import { type ProbeResult, probeTarget } from '@/background/capture/probeSize'
import { isFaithfulReplay } from '@/background/capture/replayFidelity'
import { makeOps } from '@/background/handoff/makeOps'
import { runHandoff } from '@/background/handoff/runHandoff'
import type { ChromiumInterceptionDeps } from '@/background/interception/chromium'
import { isEligibleDownload } from '@/background/interception/eligibility'
import {
  firefoxDownloadSize,
  readActiveFirefoxDownload,
  waitForFirefoxMetadata,
} from '@/background/interception/firefoxMetadata'
import { describeUrlForLog, log } from '@/background/log'
import { decideTakeover } from '@/background/policy/decideTakeover'
import { type Browser, extensionBrowser as browser } from '@/shared/browser'

const pendingDownloads = new Set<number>()

export async function cancelFirefoxDownload(id: number): Promise<void> {
  await browser.downloads.cancel(id)
  try {
    await browser.downloads.erase({ id })
  } catch (error) {
    // The native item is already cancelled at this point. History cleanup is
    // cosmetic and must not abort the Motrix submit, which would otherwise
    // leave the user with a cancelled download and no replacement.
    log.debug('[takeover] Firefox download history cleanup failed', error)
  }
}

export function registerFirefoxInterception(
  deps: ChromiumInterceptionDeps
): void {
  browser.downloads?.onCreated?.addListener((item) => {
    if (
      !isEligibleDownload(
        item as unknown as {
          url: string
          finalUrl?: string
          byExtensionId?: string
        },
        deps.selfExtensionId
      )
    )
      return
    void handleFirefoxDownloadSafely(item, deps)
  })
}

/** Firefox's downloads event ignores returned promises. Keep a rejected
 * startup barrier or handoff contained without logging URL-bearing errors. */
export async function handleFirefoxDownloadSafely(
  item: Browser.downloads.DownloadItem,
  deps: ChromiumInterceptionDeps
): Promise<void> {
  if (pendingDownloads.has(item.id)) return
  pendingDownloads.add(item.id)
  try {
    await handle(item, deps)
  } catch {
    log.debug('[takeover] Firefox handoff unavailable')
  } finally {
    pendingDownloads.delete(item.id)
  }
}

async function handle(
  item: Browser.downloads.DownloadItem,
  deps: ChromiumInterceptionDeps
): Promise<void> {
  const popupWindow = deps.popup?.captureWindow()
  let cfg = await deps.getConfig()
  if (!cfg.enabled) {
    log.debug('[takeover] Firefox automatic takeover disabled')
    return
  }
  if (cfg.downloadMode === 'confirm') return
  const replay = deps.replaySource.waitForResponse
    ? await deps.replaySource.waitForResponse(item)
    : deps.replaySource(item)
  if (!replay) return
  const guard = await deps.captureGuard()
  if (!guard) return
  const url = replay.url

  // Probe at most once within the same 3 s window as native metadata reads.
  // Its failure must not discard the size Firefox learned in the meantime.
  let probe: ProbeResult | null = null
  let probePromise: Promise<ProbeResult> | undefined
  const runProbe = async (needSize: boolean): Promise<ProbeResult> => {
    probePromise ??= probeTarget(url, {
      fetch: globalThis.fetch,
      needSize,
    })
      .then((result) => {
        probe = result
        return result
      })
      .catch(() => {
        const empty: ProbeResult = { sizeBytes: null, contentType: null }
        probe = empty
        return empty
      })
    return probePromise
  }
  const initialKnownSize = firefoxDownloadSize(item) ?? replay.size ?? null
  if (initialKnownSize === null) void runProbe(true)
  const observed = await waitForFirefoxMetadata(
    item.id,
    () => probe?.sizeBytes ?? replay.size ?? null
  )
  if (!observed) return
  if (
    probePromise &&
    (firefoxDownloadSize(observed) ?? replay.size ?? null) === null
  )
    await probePromise
  const latest = await readActiveFirefoxDownload(item.id)
  if (!latest) return
  cfg = await deps.getConfig()
  if (!cfg.enabled || cfg.downloadMode === 'confirm') return

  const makeTarget = (current: Browser.downloads.DownloadItem) => {
    const referrer = replay.referer || current.referrer || replay.source
    const filename = current.filename || replay.filename
    const mime = current.mime || replay.mime
    return normalizeTarget({
      url,
      ...(referrer ? { referrer } : {}),
      ...(replay.omitReferer ? { omitReferer: true } : {}),
      ...(filename ? { suggestedFilename: filename } : {}),
      ...(mime ? { mime } : {}),
      sizeBytes:
        firefoxDownloadSize(current) ?? replay.size ?? probe?.sizeBytes ?? null,
      origin: 'auto',
    })
  }
  let target = makeTarget(latest)
  const logDecision = () =>
    log.debug(
      '[takeover] Firefox decision=',
      decideTakeover(cfg, target),
      'mime=',
      item.mime,
      'totalBytes=',
      item.totalBytes,
      'sizeBytes=',
      target.sizeBytes,
      'sizeSource=',
      firefoxDownloadSize(item) !== null
        ? 'browser'
        : replay.size !== undefined
          ? 'response'
          : probe?.sizeBytes != null
            ? 'probe'
            : 'unknown',
      'url=',
      describeUrlForLog(target.url)
    )
  item = latest
  logDecision()
  if (decideTakeover(cfg, target) !== 'motrix') return

  const { contentType, replayRejected } = await runProbe(
    target.sizeBytes === null
  )
  const current = await readActiveFirefoxDownload(item.id)
  if (!current) return
  item = current
  cfg = await deps.getConfig()
  target = makeTarget(current)
  logDecision()
  if (
    cfg.downloadMode === 'confirm' ||
    !replay.allowed() ||
    decideTakeover(cfg, target) !== 'motrix' ||
    !isEligibleDownload(current, deps.selfExtensionId)
  )
    return
  if (
    replayRejected ||
    !isFaithfulReplay({
      itemMime: item.mime || replay.mime || '',
      suggestedFilename: target.suggestedFilename,
      probedContentType: contentType,
    })
  ) {
    // Firefox has not cancelled the native download yet; leaving it alone
    // lets the browser finish the file it actually negotiated.
    log.debug(
      '[takeover] declined: GET replay would not be faithful; contentType=',
      contentType,
      'replayRejected=',
      replayRejected
    )
    return
  }

  const ops = makeOps({
    manager: deps.manager,
    guard,
    isPaired: deps.isPaired,
    gate: deps.gate,
    nudge: deps.nudge,
    cancelNative: async () => {
      // Connecting/cookie capture may outlive the browser transfer. Never
      // cancel or resubmit a file that finished or was paused by the user.
      const active = await readActiveFirefoxDownload(item.id)
      const config = await deps.getConfig()
      guard.assertCurrent()
      if (
        !active ||
        !replay.allowed() ||
        config.downloadMode === 'confirm' ||
        decideTakeover(config, makeTarget(active)) !== 'motrix'
      )
        throw new Error('Firefox native download no longer eligible')
      await cancelFirefoxDownload(item.id)
    },
    fallbackToBrowser: async () => {
      await browser.downloads.download({ url })
    },
    // MVP: no blocking confirm UI in the SW, so sensitive domains auto-decline (leaves the native download intact). Real per-download confirm UI is deferred to Plan 2/3.
    confirmSensitive: async () => false,
    notify: deps.notify,
  })
  const result = await runHandoff(target, ops)
  if (result?.kind === 'accepted' && deps.popup && guard.endpointId) {
    const windowId = await popupWindow
    if (windowId != null)
      void deps.popup.present({
        ...result,
        endpointId: guard.endpointId,
        endpointRevision: guard.endpointRevision ?? 0,
        windowId,
        enabledAtCapture: cfg.openTaskPanelAfterSubmit,
        assertCurrent: guard.assertCurrent,
      })
  }
}
