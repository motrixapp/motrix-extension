import { normalizeTarget } from '@/background/capture/normalizeTarget'
import type { ConfirmationResult } from '@/background/DownloadConfirmationService'
import type { HandoffGuard } from '@/background/handoff/guard'
import { makeOps } from '@/background/handoff/makeOps'
import { runHandoff } from '@/background/handoff/runHandoff'
import type { ChromiumInterceptionDeps } from '@/background/interception/chromium'
import { describeUrlForLog, log } from '@/background/log'
import { extensionBrowser as browser } from '@/shared/browser'
import type { TakeoverTarget } from '@/shared/takeover'

/** Opens the upstream confirmation form and resolves with the user's
 * decision. Provided by service-worker.ts, which owns the confirmation
 * service and its submission actions. */
export interface WebRequestEarlyConfirmDeps {
  confirmRequest: (
    target: TakeoverTarget,
    windowId: number | undefined,
    guard: HandoffGuard
  ) => Promise<ConfirmationResult>
}

/**
 * PoC: IDM-style request-level early takeover for the Firefox build.
 *
 * Firefox's downloads API only surfaces a download AFTER the download manager
 * has started it (onCreated, totalBytes = -1), which forces the post-hoc probe
 * race fixed in #39/#40. This module instead watches webRequest response
 * headers and cancels a download-shaped response BEFORE the download manager
 * takes it, then hands the URL to Motrix with the size/content-type read
 * straight from the headers - no probe, no race, no .part churn.
 *
 * Deliberately conservative candidate filter (PoC scope):
 *   - GET + 2xx only
 *   - Content-Disposition: attachment, OR a small binary content-type
 *     allowlist on main_frame/object requests
 *   - never "media" request types (streaming playback must not be cancelled)
 * A URL handled in the last 60s is skipped once, so Motrix's browser-download
 * fallback cannot loop back into this listener.
 *
 * Feature parity with the onCreated path:
 *   - downloadMode === 'confirm' ("下载前询问") bypasses this module entirely
 *     so the upstream confirmation flow keeps working on the native download
 *   - after an accepted handoff the task panel is presented when
 *     openTaskPanelAfterSubmit is set, using the download's own window
 *
 * Kill switch: storage.local key `motrix.earlyTakeover` = { enabled: false }.
 */

const EARLY_KILL_SWITCH_KEY = 'motrix.earlyTakeover'
const TAKEOVER_CONFIG_KEY = 'motrix.takeoverConfig'
const HANDLED_URL_TTL_MS = 60_000

/** Structural subset of webRequest details/headers - avoids coupling this
 * PoC to polyfill type names that differ between browser type packages. */
interface ResponseHeader {
  name: string
  value?: string
}

interface EarlyRequestDetails {
  url: string
  method: string
  statusCode: number
  type: string
  tabId: number
  responseHeaders?: ResponseHeader[]
}

interface TakeoverConfigLike {
  enabled?: boolean
  downloadMode?: string
  openTaskPanelAfterSubmit?: boolean
}

const flags = {
  earlyEnabled: true,
  takeoverEnabled: true,
  downloadMode: 'direct',
  openTaskPanelAfterSubmit: false,
}

const handledUrls = new Map<string, number>()

const BINARY_DOCUMENT_TYPES = new Set([
  'application/octet-stream',
  'application/x-gzip',
  'application/gzip',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/pdf',
  'application/x-msdownload',
  'application/vnd.android.package-archive',
  'application/iso-image',
  'application/x-iso9660-image',
])

function applyTakeoverConfig(raw: TakeoverConfigLike | undefined): void {
  flags.takeoverEnabled = raw?.enabled ?? true
  flags.downloadMode = raw?.downloadMode === 'confirm' ? 'confirm' : 'direct'
  flags.openTaskPanelAfterSubmit = raw?.openTaskPanelAfterSubmit ?? false
}

function headerValue(
  headers: ResponseHeader[] | undefined,
  name: string
): string | null {
  if (!headers) return null
  const lower = name.toLowerCase()
  for (const h of headers) {
    if (h.name.toLowerCase() === lower) return h.value ?? null
  }
  return null
}

function isEarlyTakeoverCandidate(details: EarlyRequestDetails): boolean {
  if (details.method !== 'GET') return false
  if (details.statusCode < 200 || details.statusCode >= 300) return false
  const seenAt = handledUrls.get(details.url)
  if (seenAt !== undefined && Date.now() - seenAt < HANDLED_URL_TTL_MS) {
    return false
  }
  const disposition = headerValue(
    details.responseHeaders,
    'content-disposition'
  )
  if (disposition && /attachment/i.test(disposition)) return true
  if (details.type !== 'main_frame' && details.type !== 'object') return false
  const contentType = headerValue(details.responseHeaders, 'content-type')
  if (!contentType) return false
  const essence = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  return BINARY_DOCUMENT_TYPES.has(essence)
}

async function submitEarly(
  details: EarlyRequestDetails,
  deps: ChromiumInterceptionDeps,
  confirmDeps: WebRequestEarlyConfirmDeps
): Promise<void> {
  handledUrls.set(details.url, Date.now())
  for (const [url, at] of handledUrls) {
    if (Date.now() - at >= HANDLED_URL_TTL_MS) handledUrls.delete(url)
  }
  const fallbackToBrowser = async (): Promise<void> => {
    await browser.downloads.download({ url: details.url })
  }
  // Same contract as the onCreated path: the panel only opens over the
  // window that started the download, gated by openTaskPanelAfterSubmit.
  const popupWindow =
    details.tabId >= 0
      ? browser.tabs
          .get(details.tabId)
          .then((tab) => tab.windowId)
          .catch(() => null)
      : undefined
  try {
    const tab =
      details.tabId >= 0
        ? await browser.tabs.get(details.tabId).catch(() => null)
        : null
    const pageUrl = tab?.url
    const contentType = headerValue(details.responseHeaders, 'content-type')
    const contentLength = Number(
      headerValue(details.responseHeaders, 'content-length') ?? NaN
    )
    const sizeBytes =
      Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null
    const target = normalizeTarget({
      url: details.url,
      ...(pageUrl ? { referrer: pageUrl } : {}),
      ...(contentType ? { mime: contentType } : {}),
      sizeBytes,
      origin: 'context-menu',
    })
    // Confirm mode ("下载前询问"): the request is already cancelled, so the
    // form decides the fate of the file - accepted pushes to Motrix, browser
    // re-downloads it, and a dismissal falls back to the browser here. Unlike
    // the onCreated confirm flow nothing streams into the browser while the
    // form is open.
    if (flags.downloadMode === 'confirm') {
      const confirmGuard = await deps.captureGuard()
      if (!confirmGuard) {
        await fallbackToBrowser()
        return
      }
      const decision = await confirmDeps.confirmRequest(
        target,
        (await popupWindow) ?? undefined,
        confirmGuard
      )
      log.info(
        '[early-takeover] confirm decision:',
        decision.action,
        describeUrlForLog(details.url)
      )
      if (
        decision.action === 'unavailable' ||
        decision.action === 'unsupported'
      ) {
        // The form itself failed - keep the file reachable via the browser.
        await fallbackToBrowser()
      }
      // decision.action === 'cancel' is a deliberate user choice: no Motrix
      // task, no browser download. The request was already cancelled.
      return
    }
    const guard = await deps.captureGuard()
    if (!guard) {
      log.warn(
        '[early-takeover] no guard for endpoint; falling back to browser download',
        describeUrlForLog(details.url)
      )
      await fallbackToBrowser()
      return
    }
    const ops = makeOps({
      manager: deps.manager,
      guard,
      isPaired: deps.isPaired,
      gate: deps.gate,
      nudge: deps.nudge,
      // The request was already cancelled at the webRequest layer; there is no
      // native download item to cancel, and re-issuing one would loop.
      cancelNative: async () => {},
      fallbackToBrowser,
      confirmSensitive: async () => false,
      notify: deps.notify,
    })
    const result = await runHandoff(target, ops)
    log.info(
      '[early-takeover] handoff result:',
      result?.kind ?? 'none',
      'url=',
      describeUrlForLog(details.url)
    )
    if (result?.kind === 'accepted') {
      if (deps.popup && flags.openTaskPanelAfterSubmit && guard.endpointId) {
        const windowId = await popupWindow
        if (windowId != null)
          void deps.popup.present({
            ...result,
            endpointId: guard.endpointId,
            endpointRevision: guard.endpointRevision ?? 0,
            windowId,
            enabledAtCapture: flags.openTaskPanelAfterSubmit,
            assertCurrent: guard.assertCurrent,
          })
      }
      return
    }
    await fallbackToBrowser()
  } catch (error) {
    log.error('[early-takeover] handoff failed; browser fallback:', error)
    try {
      await fallbackToBrowser()
    } catch {
      log.error('[early-takeover] browser fallback also failed')
    }
  }
}

export function registerWebRequestEarlyTakeover(
  deps: ChromiumInterceptionDeps,
  confirmDeps: WebRequestEarlyConfirmDeps
): void {
  void (async () => {
    try {
      const stored = (await browser.storage.local.get([
        EARLY_KILL_SWITCH_KEY,
        TAKEOVER_CONFIG_KEY,
      ])) as Record<string, TakeoverConfigLike | undefined>
      flags.earlyEnabled = stored[EARLY_KILL_SWITCH_KEY]?.enabled ?? true
      applyTakeoverConfig(stored[TAKEOVER_CONFIG_KEY])
    } catch {
      // defaults already enabled
    }
  })()
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    if (changes[EARLY_KILL_SWITCH_KEY]) {
      flags.earlyEnabled =
        (changes[EARLY_KILL_SWITCH_KEY].newValue as TakeoverConfigLike)
          ?.enabled ?? true
    }
    if (changes[TAKEOVER_CONFIG_KEY]) {
      applyTakeoverConfig(
        changes[TAKEOVER_CONFIG_KEY].newValue as TakeoverConfigLike
      )
    }
  })
  browser.webRequest?.onHeadersReceived?.addListener(
    (details) => {
      const d = details as unknown as EarlyRequestDetails
      if (!flags.earlyEnabled || !flags.takeoverEnabled) return {}
      if (!isEarlyTakeoverCandidate(d)) return {}
      log.info(
        '[early-takeover] intercepting request-level:',
        describeUrlForLog(d.url),
        'type=',
        d.type
      )
      void submitEarly(d, deps, confirmDeps)
      return { cancel: true }
    },
    { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame', 'object'] },
    ['blocking', 'responseHeaders']
  )
  log.info('[early-takeover] request-level early takeover registered (PoC)')
}
