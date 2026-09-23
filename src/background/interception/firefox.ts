import { normalizeTarget } from '@/background/capture/normalizeTarget'
import { type ProbeResult, probeTarget } from '@/background/capture/probeSize'
import { isFaithfulReplay } from '@/background/capture/replayFidelity'
import { makeOps } from '@/background/handoff/makeOps'
import { runHandoff } from '@/background/handoff/runHandoff'
import type { ChromiumInterceptionDeps } from '@/background/interception/chromium'
import { isEligibleDownload } from '@/background/interception/eligibility'
import { log } from '@/background/log'
import { decideTakeover } from '@/background/policy/decideTakeover'
import { type Browser, extensionBrowser as browser } from '@/shared/browser'
import type { TakeoverConfig } from '@/shared/takeover'

function configHasThreshold(cfg: TakeoverConfig): boolean {
  return cfg.rules.some((r) => typeof r.match.minSizeMB === 'number')
}

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
  browser.downloads.onCreated.addListener((item) => {
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
  try {
    await handle(item, deps)
  } catch {
    log.debug('[takeover] Firefox handoff unavailable')
  }
}

async function handle(
  item: Browser.downloads.DownloadItem,
  deps: ChromiumInterceptionDeps
): Promise<void> {
  const popupWindow = deps.popup?.captureWindow()
  const cfg = await deps.getConfig()
  if (!cfg.enabled) return
  const guard = await deps.captureGuard()
  if (guard === null) return
  const finalUrl = (item as unknown as { finalUrl?: string }).finalUrl
  const url = finalUrl && finalUrl.length > 0 ? finalUrl : item.url

  let sizeBytes: number | null =
    typeof item.totalBytes === 'number' && item.totalBytes > 0
      ? item.totalBytes
      : null
  // Same single-shot probe as the Chromium path: its length feeds minSizeMB
  // rules, and its Content-Type exposes a download a GET replay cannot
  // reproduce (see replayFidelity).
  let probe: ProbeResult | null = null
  const runProbe = async (): Promise<ProbeResult> => {
    probe ??= await probeTarget(url, { fetch: globalThis.fetch })
    return probe
  }
  if (sizeBytes === null && configHasThreshold(cfg)) {
    sizeBytes = (await runProbe()).sizeBytes
  }

  const target = normalizeTarget({
    url,
    ...(typeof item.referrer === 'string' && item.referrer.length > 0
      ? { referrer: item.referrer }
      : {}),
    ...(typeof item.filename === 'string'
      ? { suggestedFilename: item.filename }
      : {}),
    ...(typeof item.mime === 'string' ? { mime: item.mime } : {}),
    sizeBytes,
    origin: 'auto',
  })

  if (decideTakeover(cfg, target) !== 'motrix') return
  const { contentType } = await runProbe()
  if (
    !isFaithfulReplay({
      itemMime: item.mime ?? '',
      suggestedFilename: target.suggestedFilename,
      probedContentType: contentType,
    })
  ) {
    // Firefox has not cancelled the native download yet; leaving it alone
    // lets the browser finish the file it actually negotiated.
    log.debug(
      '[takeover] declined: GET replay would not be faithful; contentType=',
      contentType
    )
    return
  }

  const ops = makeOps({
    manager: deps.manager,
    guard,
    isPaired: deps.isPaired,
    gate: deps.gate,
    nudge: deps.nudge,
    cancelNative: () => cancelFirefoxDownload(item.id),
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
