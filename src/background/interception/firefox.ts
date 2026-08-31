import { normalizeTarget } from '@/background/capture/normalizeTarget'
import { probeSize } from '@/background/capture/probeSize'
import { makeOps } from '@/background/handoff/makeOps'
import { runHandoff } from '@/background/handoff/runHandoff'
import type { ChromiumInterceptionDeps } from '@/background/interception/chromium'
import { isEligibleDownload } from '@/background/interception/eligibility'
import { log } from '@/background/log'
import { decideTakeover } from '@/background/policy/decideTakeover'
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
  item: browser.downloads.DownloadItem,
  deps: ChromiumInterceptionDeps
): Promise<void> {
  try {
    await handle(item, deps)
  } catch {
    log.debug('[takeover] Firefox handoff unavailable')
  }
}

async function handle(
  item: browser.downloads.DownloadItem,
  deps: ChromiumInterceptionDeps
): Promise<void> {
  const cfg = await deps.getConfig()
  if (!cfg.enabled) return
  const finalUrl = (item as unknown as { finalUrl?: string }).finalUrl
  const url = finalUrl && finalUrl.length > 0 ? finalUrl : item.url

  let sizeBytes: number | null =
    typeof item.totalBytes === 'number' && item.totalBytes > 0
      ? item.totalBytes
      : null
  if (sizeBytes === null && configHasThreshold(cfg)) {
    sizeBytes = await probeSize(url, { fetch: globalThis.fetch })
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

  const ops = makeOps({
    manager: deps.manager,
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
  await runHandoff(target, ops)
}
