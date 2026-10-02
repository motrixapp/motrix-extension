import { normalizeTarget } from '@/background/capture/normalizeTarget'
import type { ConfirmationResult } from '@/background/DownloadConfirmationService'
import type { HandoffGuard } from '@/background/handoff/guard'
import { makeOps } from '@/background/handoff/makeOps'
import { runHandoff } from '@/background/handoff/runHandoff'
import type { ChromiumInterceptionDeps } from '@/background/interception/chromium'
import { describeUrlForLog, log } from '@/background/log'
import { decideTakeover } from '@/background/policy/decideTakeover'
import { type Browser, extensionBrowser as browser } from '@/shared/browser'
import type { TakeoverConfig, TakeoverTarget } from '@/shared/takeover'

/**
 * PoC: IDM-style request-level early takeover for the Firefox build.
 *
 * Firefox's downloads API only surfaces a download AFTER the download manager
 * has started it (onCreated, totalBytes = -1), which forces the post-hoc probe
 * race fixed in #39/#40. This module instead watches webRequest response
 * headers and, when the full takeover policy approves, HOLDS the request (the
 * blocking listener returns a promise - Firefox pauses the response at the
 * headers) while it verifies the Motrix connection and submits; the browser
 * download is cancelled only after Motrix has accepted the task.
 *
 * Every failure path RELEASES the held response instead of re-issuing a
 * browser download, so the original request simply continues: correct
 * filename from its own Content-Disposition, no duplicate transfer, no
 * .part churn (review #45, P1-3).
 *
 * Policy-complete (review #45, P1-1): decideTakeover runs on a target built
 * from the response headers BEFORE anything is cancelled, so site exclusions,
 * minSizeMB rules, defaultAction and unknownSizeAction all apply.
 *
 * Defaults (review #45, P1-2): the cached config defaults to
 * TAKEOVER_DEFAULT (enabled = false) and interception stays off until the
 * initial storage read completes (initialized gate). The module-level kill
 * switch `motrix.earlyTakeover.enabled` defaults to true; the takeoverConfig
 * master switch remains the real gate.
 *
 * Inline PDFs are never held without an explicit Content-Disposition:
 * attachment signal (review #45, P2), media request types are filtered out,
 * POST / non-2xx are ignored, and a 60s per-URL dedupe keeps the flow
 * one-shot per download.
 */

const EARLY_KILL_SWITCH_KEY = 'motrix.earlyTakeover'
/** Only needs to cover the extension's own re-issued fallback download
 * (which arrives within ~1s of the cancel) - a short TTL keeps legitimate
 * re-clicks of the same link takeover-eligible. */
const HANDLED_URL_TTL_MS = 5_000
const CONNECT_DEADLINE_MS = 8_000

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
  originUrl?: string
  documentUrl?: string
  responseHeaders?: ResponseHeader[]
}

/** Provided by service-worker.ts: the auto capture guard and the
 * confirmation service live there, outside this module's deps. */
export interface WebRequestEarlyDeps {
  captureAuto: () => Promise<HandoffGuard | null>
  confirmRequest: (
    target: TakeoverTarget,
    windowId: number | undefined,
    guard: HandoffGuard
  ) => Promise<ConfirmationResult>
}

const BINARY_DOCUMENT_TYPES = new Set([
  'application/octet-stream',
  'application/x-gzip',
  'application/gzip',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/x-msdownload',
  'application/vnd.android.package-archive',
  'application/iso-image',
  'application/x-iso9660-image',
])

let earlyEnabled = true
let initialized = false
const handledUrls = new Map<string, number>()

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

/** Returns the response Content-Type when the request is an early-takeover
 * candidate, or null when this module must leave it to the browser. */
function isEarlyTakeoverCandidate(details: EarlyRequestDetails): string | null {
  if (details.method !== 'GET') return null
  if (details.statusCode < 200 || details.statusCode >= 300) return null
  const seenAt = handledUrls.get(details.url)
  if (seenAt !== undefined && Date.now() - seenAt < HANDLED_URL_TTL_MS) {
    return null
  }
  const disposition = headerValue(
    details.responseHeaders,
    'content-disposition'
  )
  if (disposition !== null && /attachment/i.test(disposition)) {
    return headerValue(details.responseHeaders, 'content-type')
  }
  if (details.type !== 'main_frame' && details.type !== 'object') return null
  const contentType = headerValue(details.responseHeaders, 'content-type')
  if (!contentType) return null
  const essence = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  // Inline PDFs keep the built-in viewer: without an explicit attachment
  // signal a PDF response is never held or taken over (review #45, P2).
  if (essence === 'application/pdf') return null
  if (!BINARY_DOCUMENT_TYPES.has(essence)) return null
  return contentType
}

/** Extracts the real filename from a Content-Disposition header (RFC 5987
 * filename* takes precedence over the quoted plain form). Download links
 * like download.jsp?id=... name the file only through this header. */
function filenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i.exec(disposition)
  if (star) {
    const raw = star[1]?.trim().replace(/^"|"$/g, '')
    if (raw) {
      try {
        return decodeURIComponent(raw)
      } catch {
        return raw
      }
    }
    return null
  }
  const plain = /filename\s*=\s*("?)([^";]+)\1/i.exec(disposition)
  return plain ? (plain[2]?.trim() ?? null) : null
}

function buildTargetSync(
  details: EarlyRequestDetails,
  contentType: string | null
): TakeoverTarget {
  const contentLength = Number(
    headerValue(details.responseHeaders, 'content-length') ?? NaN
  )
  const sizeBytes =
    Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null
  const pageUrl = details.originUrl ?? details.documentUrl
  const suggested = filenameFromDisposition(
    headerValue(details.responseHeaders, 'content-disposition')
  )
  return normalizeTarget({
    url: details.url,
    ...(pageUrl ? { referrer: pageUrl } : {}),
    ...(contentType ? { mime: contentType } : {}),
    ...(suggested ? { suggestedFilename: suggested } : {}),
    sizeBytes,
    origin: 'auto',
  })
}

async function tabWindowId(tabId: number): Promise<number | null> {
  if (tabId < 0) return null
  try {
    const tab = await browser.tabs.get(tabId)
    return tab.windowId ?? null
  } catch {
    return null
  }
}

function presentPanel(
  deps: ChromiumInterceptionDeps,
  cfg: TakeoverConfig,
  result: { taskId: string; operationId: string },
  guard: HandoffGuard,
  windowId: number | null
): void {
  if (!deps.popup || !cfg.openTaskPanelAfterSubmit || !guard.endpointId) return
  if (windowId == null) return
  void deps.popup.present({
    ...result,
    endpointId: guard.endpointId,
    endpointRevision: guard.endpointRevision ?? 0,
    windowId,
    enabledAtCapture: cfg.openTaskPanelAfterSubmit,
    assertCurrent: guard.assertCurrent,
  })
}

async function waitUntilConnected(
  deps: ChromiumInterceptionDeps,
  deadlineAt: number
): Promise<boolean> {
  for (;;) {
    if (deps.manager.getState() === 'connected') return true
    if (Date.now() >= deadlineAt) return false
    await new Promise((r) => setTimeout(r, 150))
  }
}

export function registerWebRequestEarlyTakeover(
  deps: ChromiumInterceptionDeps,
  early: WebRequestEarlyDeps
): void {
  void (async () => {
    try {
      const stored = (await browser.storage.local.get([
        EARLY_KILL_SWITCH_KEY,
      ])) as Record<string, { enabled?: boolean } | undefined>
      earlyEnabled = stored[EARLY_KILL_SWITCH_KEY]?.enabled ?? true
    } catch {
      earlyEnabled = true
    }
    initialized = true
    log.info(
      '[early-takeover] request-level early takeover registered (kill switch:',
      earlyEnabled,
      ')'
    )
  })()
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    if (changes[EARLY_KILL_SWITCH_KEY]) {
      earlyEnabled =
        (changes[EARLY_KILL_SWITCH_KEY].newValue as { enabled?: boolean })
          ?.enabled ?? true
    }
  })
  browser.webRequest?.onHeadersReceived?.addListener(
    (details) => {
      const d = details as unknown as EarlyRequestDetails
      // Firefox resolves promises returned by blocking listeners (needed to
      // hold the response while connecting); the schema types predate that,
      // hence the cast.
      return onHeadersReceived(
        d,
        deps,
        early
      ) as unknown as Browser.webRequest.BlockingResponse
    },
    { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame', 'object'] },
    ['blocking', 'responseHeaders']
  )
}

async function onHeadersReceived(
  details: EarlyRequestDetails,
  deps: ChromiumInterceptionDeps,
  early: WebRequestEarlyDeps
): Promise<Browser.webRequest.BlockingResponse> {
  if (!initialized || !earlyEnabled) return {}
  const contentType = isEarlyTakeoverCandidate(details)
  if (contentType === null) return {}
  const cfg = await deps.getConfig()
  if (!cfg.enabled) return {}

  const target = buildTargetSync(details, contentType)
  // Full takeover policy BEFORE holding/cancelling (review #45, P1-1): site
  // exclusions, minSizeMB rules, defaultAction and unknownSizeAction all
  // apply. A non-approving decision resolves to {} and the browser simply
  // keeps the download.
  const decision = decideTakeover(cfg, target)
  log.debug(
    '[early-takeover] decision=',
    decision,
    'sizeBytes=',
    target.sizeBytes,
    'url=',
    describeUrlForLog(details.url)
  )
  if (decision !== 'motrix') return {}

  handledUrls.set(details.url, Date.now())
  for (const [url, at] of handledUrls) {
    if (Date.now() - at >= HANDLED_URL_TTL_MS) handledUrls.delete(url)
  }
  log.info(
    '[early-takeover] holding request-level:',
    describeUrlForLog(details.url),
    'type=',
    details.type
  )

  if (cfg.downloadMode === 'confirm') {
    // Confirm mode ("下载前询问"): the response is held while the upstream
    // confirmation form opens over the initiating window - nothing streams
    // into the browser while it is up. The decision then settles the held
    // response: accepted cancels it (Motrix owns the transfer) and a
    // deliberate dismissal cancels it too (no task, no file), while the
    // browser choice - and a form that failed to open - RELEASES it, so the
    // native download simply continues with its own headers and filename.
    // (Upstream's browser action is a no-op for origin 'auto' because there
    // the intercepted download already owns its response; here the response
    // is held, so releasing it is the correct "browser" behavior.)
    const guard = await early.captureAuto()
    if (!guard) return {}
    const decision = await early.confirmRequest(
      target,
      (await tabWindowId(details.tabId)) ?? undefined,
      guard
    )
    log.info(
      '[early-takeover] confirm decision:',
      decision.action,
      describeUrlForLog(details.url)
    )
    if (decision.action === 'accepted') return { cancel: true }
    if (
      decision.action === 'browser' ||
      decision.action === 'unavailable' ||
      decision.action === 'unsupported'
    ) {
      // "browser": re-issue the download attributed to the extension - the
      // onCreated loop guard then skips it (no second confirm form) and
      // Firefox names it from the server's own Content-Disposition on the
      // fresh request. Form failures re-issue for the same reason. The held
      // response itself is cancelled.
      void browser.downloads.download({ url: details.url })
      return { cancel: true }
    }
    // cancel / dismiss: deliberate user choice - no task, no file.
    return { cancel: true }
  }

  // Direct mode: hold-and-connect. The response stays paused while the
  // connection is established; only an accepted submit cancels it. Any other
  // outcome releases the original response, which then finishes downloading
  // in the browser with its own headers and filename - no re-request, no
  // duplicates (review #45, P1-3).
  const guard = await early.captureAuto()
  if (!guard) {
    log.info(
      '[early-takeover] no auto guard; releasing to browser',
      describeUrlForLog(details.url)
    )
    return {}
  }
  const deadlineAt = Date.now() + CONNECT_DEADLINE_MS
  if (deps.manager.getState() !== 'connected') {
    try {
      await deps.manager.ensureReady({
        intent: 'automatic-download',
        deadlineAt,
        assertCurrent: () => {},
      })
    } catch {
      // fall through to the deadline check below
    }
    const connected = await waitUntilConnected(deps, deadlineAt)
    if (!connected) {
      log.info(
        '[early-takeover] Motrix unreachable; releasing to browser',
        describeUrlForLog(details.url)
      )
      return {}
    }
  }

  // Re-verify with a fresh config read while the response is held: if the
  // user toggled takeover off mid-flight, release instead of submitting.
  const freshCfg = await deps.getConfig()
  if (!freshCfg.enabled || decideTakeover(freshCfg, target) !== 'motrix') {
    log.info(
      '[early-takeover] config changed in flight; releasing to browser',
      describeUrlForLog(details.url)
    )
    return {}
  }

  const guard2 = guard
  const ops = makeOps({
    manager: deps.manager,
    guard: guard2,
    isPaired: deps.isPaired,
    gate: deps.gate,
    nudge: deps.nudge,
    // The held response is cancelled via our return value after an accepted
    // submit; there is no native download item to cancel.
    cancelNative: async () => {},
    // Never re-issue a browser download from here: on any failure the held
    // response is released instead (its own request continues).
    fallbackToBrowser: async () => {},
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
  // runHandoff contract (review #45, P1-3): 'browser' means the browser
  // download was already started inside runHandoff (it cannot happen here -
  // fallbackToBrowser is a no-op - but honor the contract) and 'unknown'
  // means Motrix may have created the task. Mirror the post-hoc path:
  // unknown keeps the browser download, accepted suppresses it.
  if (result?.kind === 'accepted') {
    presentPanel(
      deps,
      freshCfg,
      result,
      guard2,
      await tabWindowId(details.tabId)
    )
    return { cancel: true }
  }
  // browser / unknown / skipped / failed: the held response continues in the
  // browser, which is exactly what the user expects to see.
  return {}
}
