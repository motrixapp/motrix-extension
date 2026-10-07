import { normalizeTarget } from '@/background/capture/normalizeTarget'
import { isSensitiveDomain } from '@/background/capture/sensitiveDomains'
import type { ConfirmationResult } from '@/background/DownloadConfirmationService'
import {
  beforeDeadline,
  DownloadPreparationError,
} from '@/background/download-errors'
import {
  HandoffEndpointChangedError,
  type HandoffGuard,
} from '@/background/handoff/guard'
import { makeOps } from '@/background/handoff/makeOps'
import { runHandoff } from '@/background/handoff/runHandoff'
import type { ChromiumInterceptionDeps } from '@/background/interception/chromium'
import {
  recordTakeoverDecline,
  TAKEOVER_DECLINE,
} from '@/background/interception/takeoverDeclines'
import { log } from '@/background/log'
import { decideTakeover } from '@/background/policy/decideTakeover'
import { type Browser, extensionBrowser as browser } from '@/shared/browser'
import { DOWNLOAD_ERROR } from '@/shared/integration'
import {
  hostOf,
  type TakeoverConfig,
  type TakeoverTarget,
} from '@/shared/takeover'

export interface WebRequestEarlyConfirmDeps {
  confirmRequest: (
    target: TakeoverTarget,
    windowId: number | undefined,
    guard: HandoffGuard
  ) => Promise<ConfirmationResult>
}

const EARLY_KEY = 'motrix.earlyTakeover'
const CONFIG_KEY = 'motrix.takeoverConfig'
/**
 * Budget for the read-only preflight that runs inside the blocking listener.
 *
 * The listener must answer before the browser starts the download, so this
 * covers configuration reads, the endpoint guard, and one tab lookup — nothing
 * that touches the network. It was 1.5s, which the storage-backed reads could
 * exceed on a cold worker or while the endpoint catalogue was being recovered;
 * every response that missed the budget was released to the browser with no
 * explanation. 4s still bounds the browser's visible stall while leaving room
 * for a busy IndexedDB-backed storage read.
 */
export const EARLY_PREFLIGHT_MS = 4000

interface EarlyRequestDetails {
  url: string
  method: string
  statusCode: number
  type: string
  tabId: number
  originUrl?: string
  documentUrl?: string
  responseHeaders?: { name: string; value?: string }[]
}

function header(details: EarlyRequestDetails, name: string): string {
  return (
    details.responseHeaders?.find((h) => h.name.toLowerCase() === name)
      ?.value ?? ''
  )
}

/**
 * Content types a browser will *render* rather than download. Anything else on
 * a top-level GET is treated as a file the user meant to save.
 *
 * The previous list enumerated a handful of binary types (zip, 7z, exe, iso…).
 * Every real download outside that list — .deb, .rpm, .apk, .msi, .cab, .dmg,
 * .img, Office documents, `application/octet-stream` with vendor parameters —
 * fell through to the browser, which is what users saw as "some files are not
 * taken over". A render-allowlist is both smaller and safer: it names the
 * types we must protect, and lets everything else through.
 */
const INLINE_RENDERABLE = new Set([
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/markdown',
  'text/css',
  'text/csv',
  'text/calendar',
  'text/vtt',
  'application/json',
  'application/ld+json',
  'application/xml',
  'text/xml',
  'application/rss+xml',
  'application/atom+xml',
  'application/pdf',
  'image/svg+xml',
])

const MEDIA_PREFIXES = ['image/', 'video/', 'audio/']

function essence(contentType: string): string {
  return contentType.split(';')[0]?.trim().toLowerCase() ?? ''
}

function isRenderableDocument(contentType: string): boolean {
  const value = essence(contentType)
  if (value === '') return true // no type at all: assume it renders
  if (INLINE_RENDERABLE.has(value)) return true
  return MEDIA_PREFIXES.some((prefix) => value.startsWith(prefix))
}

function isCandidate(details: EarlyRequestDetails): boolean {
  if (details.tabId < 0) return false
  if (
    details.method !== 'GET' ||
    details.statusCode < 200 ||
    details.statusCode >= 300
  )
    return false
  if (!['main_frame', 'sub_frame', 'object'].includes(details.type))
    return false
  // Extension-initiated downloads include our fallback and confirmed browser
  // action, including redirects. Do not use a URL TTL: a later user request
  // for the same URL is a new download and must still obey the policy.
  if (
    [details.originUrl, details.documentUrl].some((url) =>
      url?.startsWith('moz-extension://')
    )
  )
    return false
  const contentType = header(details, 'content-type')
  const disposition = header(details, 'content-disposition')
    .split(';')[0]
    ?.trim()
    .toLowerCase()
  // An explicit attachment is a download whatever the type says.
  if (disposition === 'attachment') return true
  if (disposition === 'inline') return false
  if (details.type === 'sub_frame') return false
  // No attachment header: take anything the browser would not render inline.
  return !isRenderableDocument(contentType)
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

interface Prepared {
  target: TakeoverTarget
  cfg: TakeoverConfig
  guard: HandoffGuard
  windowId: number | undefined
}

/** The response has already been cancelled before this function runs. */
async function submitCancelled(
  prepared: Prepared,
  deps: ChromiumInterceptionDeps,
  confirmation: WebRequestEarlyConfirmDeps
): Promise<void> {
  const { target, cfg, guard, windowId } = prepared
  // Cache even a rejected attempt. Neither runHandoff's fallback nor an outer
  // catch may issue a second download for the same cancelled response.
  let fallback: Promise<unknown> | undefined
  const fallbackToBrowser = async (): Promise<void> => {
    fallback ??= Promise.resolve().then(() =>
      browser.downloads.download({ url: target.url })
    )
    await fallback
  }
  let owned = false
  try {
    guard.assertCurrent()
    if (cfg.downloadMode === 'confirm') {
      const result = await confirmation.confirmRequest(target, windowId, guard)
      if (result.action === 'unavailable' || result.action === 'unsupported')
        await fallbackToBrowser()
      // accepted/browser are owned by confirmation actions; cancel is final.
      return
    }
    const result = await runHandoff(
      target,
      makeOps({
        manager: deps.manager,
        guard,
        isPaired: deps.isPaired,
        gate: deps.gate,
        nudge: deps.nudge,
        cancelNative: async () => {},
        fallbackToBrowser,
        confirmSensitive: async () => false,
        notify: deps.notify,
      })
    )
    switch (result.kind) {
      case 'accepted':
        owned = true
        if (deps.popup && guard.endpointId && windowId !== undefined) {
          // Presentation errors cannot undo an accepted transfer.
          void deps.popup
            .present({
              ...result,
              endpointId: guard.endpointId,
              endpointRevision: guard.endpointRevision ?? 0,
              windowId,
              enabledAtCapture: cfg.openTaskPanelAfterSubmit,
              assertCurrent: guard.assertCurrent,
            })
            .catch(() => {})
        }
        return
      case 'browser':
      case 'unknown':
        owned = true
        return
      case 'skipped':
      case 'failed':
        recordTakeoverDecline(
          TAKEOVER_DECLINE.handoffFailed,
          hostOf(target.url),
          true
        )
        await fallbackToBrowser()
    }
  } catch {
    if (owned) return
    recordTakeoverDecline(
      TAKEOVER_DECLINE.handoffFailed,
      hostOf(target.url),
      true
    )
    // Do not log exceptions containing signed URLs or response credentials.
    log.debug('[early-takeover] handoff unavailable')
    try {
      await fallbackToBrowser()
    } catch {
      log.debug('[early-takeover] browser fallback unavailable')
    }
  }
}

/** Short, read-only preflight, then cancel and deliver in a separate task.
 * No user interaction or Motrix submission is awaited by the blocking event.
 * As with the native adapter, an accepted Motrix task must replay the URL;
 * strictly one-use URLs cannot be made replayable by this API.
 */
export function registerWebRequestEarlyTakeover(
  deps: ChromiumInterceptionDeps,
  confirmation: WebRequestEarlyConfirmDeps
): void {
  let earlyEnabled = true
  let generation = 0
  let earlyGeneration = 0
  const ready = (async () => {
    const initial = earlyGeneration
    try {
      const stored = await browser.storage.local.get(EARLY_KEY)
      if (earlyGeneration === initial)
        earlyEnabled =
          (stored[EARLY_KEY] as { enabled?: boolean } | undefined)?.enabled !==
          false
    } catch {
      if (earlyGeneration === initial) earlyEnabled = false
    }
  })()
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    if (changes[EARLY_KEY]) {
      earlyGeneration += 1
      earlyEnabled =
        (changes[EARLY_KEY].newValue as { enabled?: boolean } | undefined)
          ?.enabled !== false
    }
    if (changes[EARLY_KEY] || changes[CONFIG_KEY]) generation += 1
  })

  const prepare = async (
    details: EarlyRequestDetails
  ): Promise<Prepared | null> => {
    await ready
    if (!earlyEnabled) return null
    const captured = generation
    // Fan the three storage/runtime reads out concurrently. Chained, they
    // summed to the preflight budget under load and pushed whole batches of
    // concurrent downloads past the deadline.
    const [cfg, guard, tab] = await Promise.all([
      deps.getConfig(),
      deps.captureGuard(),
      // The tab is only a fallback referrer and a popup anchor. A slow or
      // missing tab must never fail an otherwise valid takeover.
      details.tabId >= 0
        ? browser.tabs.get(details.tabId).catch(() => undefined)
        : Promise.resolve(undefined),
    ])
    if (!cfg.enabled) {
      recordTakeoverDecline(
        TAKEOVER_DECLINE.takeoverDisabled,
        hostOf(details.url)
      )
      return null
    }
    if (!guard) {
      recordTakeoverDecline(
        TAKEOVER_DECLINE.endpointUnsupported,
        hostOf(details.url)
      )
      return null
    }
    const length = Number(header(details, 'content-length'))
    const referrer = details.originUrl ?? details.documentUrl ?? tab?.url
    const suggested = filenameFromDisposition(
      header(details, 'content-disposition')
    )
    const sizeBytes = Number.isFinite(length) && length > 0 ? length : null
    const target = normalizeTarget({
      url: details.url,
      ...(referrer ? { referrer } : {}),
      ...(suggested ? { suggestedFilename: suggested } : {}),
      mime: header(details, 'content-type'),
      sizeBytes,
      origin: 'auto',
    })
    const decision = decideTakeover(cfg, target)
    if (decision !== 'motrix') {
      recordTakeoverDecline(
        sizeBytes === null
          ? TAKEOVER_DECLINE.unknownSize
          : TAKEOVER_DECLINE.policyDeclined,
        hostOf(target.url)
      )
      return null
    }
    if (cfg.downloadMode !== 'confirm') {
      if (isSensitiveDomain(hostOf(target.url))) {
        recordTakeoverDecline(
          TAKEOVER_DECLINE.sensitiveHost,
          hostOf(target.url)
        )
        return null
      }
      if (
        deps.manager.getState() !== 'connected' &&
        (!(await deps.isPaired()) || !(await deps.gate.shouldAutoConnect()))
      ) {
        recordTakeoverDecline(
          TAKEOVER_DECLINE.endpointUnsupported,
          hostOf(target.url)
        )
        return null
      }
    }
    const current: HandoffGuard = {
      ...guard,
      assertCurrent: () => {
        guard.assertCurrent()
        if (!earlyEnabled || captured !== generation)
          throw new HandoffEndpointChangedError()
      },
    }
    current.assertCurrent()
    return {
      target: { ...target, nativeDownloadCancelled: true },
      cfg,
      guard: current,
      windowId: tab?.windowId,
    }
  }

  const listener = async (
    details: EarlyRequestDetails
  ): Promise<Browser.webRequest.BlockingResponse> => {
    if (!isCandidate(details)) {
      // Only meaningful for a top-level GET: subresources and self-issued
      // requests are excluded by design and would drown the real reasons.
      if (
        details.tabId >= 0 &&
        details.method === 'GET' &&
        ['main_frame', 'object'].includes(details.type)
      ) {
        recordTakeoverDecline(
          TAKEOVER_DECLINE.notADownload,
          hostOf(details.url)
        )
      }
      return {}
    }
    try {
      const prepared = await beforeDeadline(
        prepare(details),
        Date.now() + EARLY_PREFLIGHT_MS
      )
      if (!prepared) return {}
      prepared.guard.assertCurrent()
      // Return cancellation before opening the form or starting a fallback.
      // Late preflight completion after a timeout has no side effects.
      setTimeout(() => {
        void submitCancelled(prepared, deps, confirmation)
      }, 0)
      return { cancel: true }
    } catch (error) {
      // A deadline miss and a real failure look identical to the caller, but
      // they mean different things: one is load, the other is a broken read.
      const timedOut =
        error instanceof DownloadPreparationError &&
        error.reason === DOWNLOAD_ERROR.preparationTimeout
      recordTakeoverDecline(
        timedOut
          ? TAKEOVER_DECLINE.preflightTimeout
          : TAKEOVER_DECLINE.preflightUnavailable,
        hostOf(details.url)
      )
      log.debug(
        '[early-takeover] preflight unavailable; leaving response intact',
        timedOut ? 'timeout' : 'error'
      )
      return {}
    }
  }
  browser.webRequest.onHeadersReceived.addListener(
    (details) =>
      listener(
        details as EarlyRequestDetails
      ) as unknown as Browser.webRequest.BlockingResponse,
    {
      urls: ['http://*/*', 'https://*/*'],
      types: ['main_frame', 'sub_frame', 'object'],
    },
    ['blocking', 'responseHeaders']
  )
}
