import type { ConnectionGate } from '@/background/ConnectionGate'
import type { ConnectionManager } from '@/background/ConnectionManager'
import { normalizeTarget } from '@/background/capture/normalizeTarget'
import { probeSize } from '@/background/capture/probeSize'
import { makeOps } from '@/background/handoff/makeOps'
import { runHandoff } from '@/background/handoff/runHandoff'
import {
  isEligibleDownload,
  pickDownloadUrl,
} from '@/background/interception/eligibility'
import { createHold } from '@/background/interception/holdController'
import { describeUrlForLog, log } from '@/background/log'
import type { PairNudge } from '@/background/pairNudge'
import { decideTakeover } from '@/background/policy/decideTakeover'
import type { Notify } from '@/shared/notifications'
import type { TakeoverConfig } from '@/shared/takeover'

export interface ChromiumInterceptionDeps {
  getConfig: () => Promise<TakeoverConfig>
  manager: ConnectionManager
  /** `PairingEndpointService.isActivePaired` — see `OpsDeps.isPaired`. */
  isPaired: () => Promise<boolean>
  gate: ConnectionGate
  nudge: PairNudge
  notify: Notify
  selfExtensionId: string
}

/**
 * Chromium suspends a determination for at most 15s once the listener
 * returns true (ExtensionDownloadsEventRouterData::determine_filename_timeout_).
 * Our guard fires first so a hung handoff can never race the browser's
 * timeout into a post-suggest cancel. Budget: probe ≤3s + connect ≤8s.
 */
export const HOLD_DEADLINE_MS = 12_000

interface DeterminingItem {
  id: number
  url: string
  finalUrl?: string
  byExtensionId?: string
  totalBytes?: number
  referrer?: string
  filename?: string
  mime?: string
}

interface DeterminingFilenameEvent {
  addListener: (
    cb: (item: DeterminingItem, suggest: () => void) => boolean | undefined
  ) => void
}

function configHasThreshold(cfg: TakeoverConfig): boolean {
  return cfg.rules.some((r) => typeof r.match.minSizeMB === 'number')
}

export function registerChromiumInterception(
  deps: ChromiumInterceptionDeps
): void {
  // Feature-detect: onDeterminingFilename is Chromium-only. Register on the
  // NATIVE chrome namespace — the async protocol needs the listener's raw
  // `return true` to reach Chrome's bindings, so the webextension-polyfill
  // must not sit in between (spec §2 finding 5).
  const event = (
    globalThis as unknown as {
      chrome?: {
        downloads?: { onDeterminingFilename?: DeterminingFilenameEvent }
      }
    }
  ).chrome?.downloads?.onDeterminingFilename
  if (!event) return

  event.addListener((item, suggest) => {
    // Sync declines return undefined WITHOUT suggesting: Chrome then
    // auto-suggests, and our own re-issued downloads are never held.
    if (!isEligibleDownload(item, deps.selfExtensionId)) return undefined
    void handleHeld(item, pickDownloadUrl(item), suggest, deps)
    return true // suspend determination until we release or commit
  })
}

async function handleHeld(
  item: DeterminingItem,
  url: string,
  suggest: () => void,
  deps: ChromiumInterceptionDeps
): Promise<void> {
  const hold = createHold(
    {
      suggest,
      cancel: async () => {
        await browser.downloads.cancel(item.id)
      },
      erase: async () => {
        await browser.downloads.erase({ id: item.id })
      },
    },
    HOLD_DEADLINE_MS
  )

  try {
    const cfg = await deps.getConfig()
    if (!cfg.enabled) return

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

    const decision = decideTakeover(cfg, target)
    log.debug(
      '[takeover] onDeterminingFilename(held) url=',
      describeUrlForLog(url),
      'mime=',
      item.mime,
      'totalBytes=',
      item.totalBytes,
      'sizeBytes=',
      sizeBytes,
      'decision=',
      decision,
      'state=',
      deps.manager.getState()
    )
    if (decision !== 'motrix') return // finally releases the native download

    const ops = makeOps({
      manager: deps.manager,
      isPaired: deps.isPaired,
      gate: deps.gate,
      nudge: deps.nudge,
      cancelNative: () => hold.cancelNative(),
      fallbackToBrowser: async () => {
        await browser.downloads.download({ url })
      },
      // MVP: no blocking confirm UI in the SW, so sensitive domains auto-decline (leaves the native download intact). Real per-download confirm UI is deferred to Plan 2/3.
      confirmSensitive: async () => false,
      notify: deps.notify,
    })
    await runHandoff(target, ops)
  } catch (e) {
    log.debug('[takeover] held handoff aborted', e)
  } finally {
    hold.dispose()
    hold.release() // no-op if committed or already released
  }
}
