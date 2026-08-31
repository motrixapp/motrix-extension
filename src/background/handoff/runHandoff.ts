import type { Cookie, DownloadSubmitParams } from '@motrix/mdxp'
import type { ConnectionState } from '@/background/ConnectionManager'
import { buildSubmitParams } from '@/background/capture/buildSubmitParams'
import { i18n } from '@/shared/i18n'
import type { Notify } from '@/shared/notifications'
import { hostOf, isMagnetUrl, type TakeoverTarget } from '@/shared/takeover'

export interface HandoffOps {
  getState(): ConnectionState
  /** Explicit user-intent (re)connect that launches Motrix (clearGateAndStart). */
  connectWithLaunch(): Promise<void>
  /** Poll until state==='connected' or the deadline elapses. */
  waitForConnected(deadlineMs: number): Promise<boolean>
  isPaired(): Promise<boolean>
  canAutoConnect(): Promise<boolean>
  isSensitive(host: string): boolean
  confirmSensitive(target: TakeoverTarget): Promise<boolean>
  /** Cancel + erase the native download (no-op on the right-click path). */
  cancelNative(): Promise<void>
  /** Resume an auto download, or start a browser download for an explicit right-click. */
  fallbackToBrowser(): Promise<void>
  captureCookies(url: string): Promise<Cookie[]>
  buildHeaders(target: TakeoverTarget): Record<string, string>
  submit(params: DownloadSubmitParams): Promise<{ taskId: string }>
  notify: Notify
  nudgePair(): Promise<void>
}

const CONNECT_DEADLINE_MS = 8000

function notifySafely(ops: HandoffOps, input: Parameters<Notify>[0]): void {
  try {
    ops.notify(input)
  } catch {
    // Notifications are advisory. A renderer/API failure must never change the
    // already-committed download transaction or trigger a native fallback.
  }
}

async function submitOrFallback(
  params: DownloadSubmitParams,
  ops: HandoffOps
): Promise<void> {
  try {
    await ops.submit(params)
  } catch {
    // A request can reach Motrix even when its response is lost. Re-send the
    // same logical submission once before restoring the native download; the
    // stable idempotency key makes this safe across a reconnect.
    if (ops.getState() !== 'connected') {
      try {
        await ops.waitForConnected(CONNECT_DEADLINE_MS)
      } catch {
        // The retry below is authoritative; a failed wait simply makes it
        // reject immediately and continue to the native fallback.
      }
    }
    try {
      await ops.submit(params)
    } catch {
      let fellBack = false
      try {
        // A magnet URI is not a browser download. Keep it available for a
        // later Motrix retry instead of handing it to downloads.download().
        if (params.selection.kind === 'direct') {
          await ops.fallbackToBrowser()
          fellBack = true
        }
      } finally {
        notifySafely(ops, {
          title: i18n.t('notify.submitFailedTitle'),
          message: i18n.t(
            fellBack ? 'notify.submitFailedBody' : 'notify.notReachableBody'
          ),
          severity: 'error',
        })
      }
      return
    }
  }

  notifySafely(ops, {
    title: i18n.t('notify.handedToMotrix'),
    message: params.meta.suggestedFilename,
    severity: 'confirm',
  })
}

function canFallbackExplicitly(target: TakeoverTarget): boolean {
  return (
    target.origin === 'context-menu' &&
    (target.url.startsWith('http://') || target.url.startsWith('https://'))
  )
}

async function fallbackExplicitly(
  target: TakeoverTarget,
  ops: HandoffOps
): Promise<boolean> {
  if (!canFallbackExplicitly(target)) return false
  await ops.fallbackToBrowser()
  return true
}

function notifyBrowserFallback(ops: HandoffOps): void {
  notifySafely(ops, {
    title: i18n.t('notify.browserFallbackTitle'),
    message: i18n.t('notify.browserFallbackBody'),
    severity: 'reminder',
  })
}

type PreparedHandoff =
  | { kind: 'submit'; params: DownloadSubmitParams }
  | { kind: 'sensitive-skipped' }

async function prepareHandoff(
  target: TakeoverTarget,
  ops: HandoffOps
): Promise<PreparedHandoff> {
  if (ops.isSensitive(hostOf(target.url))) {
    if (!(await ops.confirmSensitive(target))) {
      return { kind: 'sensitive-skipped' }
    }
    return {
      kind: 'submit',
      params: buildSubmitParams(target, [], ops.buildHeaders(target)),
    }
  }

  const magnet = isMagnetUrl(target.url)
  const cookies = magnet ? [] : await ops.captureCookies(target.url)
  const headers = magnet ? {} : ops.buildHeaders(target)
  return {
    kind: 'submit',
    params: buildSubmitParams(target, cookies, headers),
  }
}

function withIdempotencyKey(
  params: DownloadSubmitParams
): DownloadSubmitParams {
  return params.idempotencyKey
    ? params
    : { ...params, idempotencyKey: crypto.randomUUID() }
}

async function commit(
  params: DownloadSubmitParams,
  ops: HandoffOps
): Promise<void> {
  const keyedParams = withIdempotencyKey(params)
  await ops.cancelNative()
  await submitOrFallback(keyedParams, ops)
}

export async function runHandoff(
  target: TakeoverTarget,
  ops: HandoffOps
): Promise<void> {
  // Step 1 — resolve connection without touching the native download.
  if (ops.getState() !== 'connected') {
    const explicit = target.origin === 'context-menu'
    if (
      !explicit &&
      (!(await ops.isPaired()) || !(await ops.canAutoConnect()))
    ) {
      await ops.nudgePair()
      ops.notify({
        title: i18n.t('notify.notConnectedTitle'),
        message: i18n.t('notify.notConnectedBody'),
        severity: 'reminder',
      })
      return
    }
    let connected = false
    try {
      await ops.connectWithLaunch()
      connected = await ops.waitForConnected(CONNECT_DEADLINE_MS)
    } catch {
      // The native auto download is still untouched. Explicit HTTP(S) picks
      // have no native item yet, so they are started in the browser below.
    }
    if (!connected) {
      if (await fallbackExplicitly(target, ops)) {
        notifyBrowserFallback(ops)
        return
      }
      notifySafely(ops, {
        title: i18n.t('notify.notReachableTitle'),
        message: i18n.t('notify.notReachableBody'),
        severity: 'error',
      })
      return
    }
  }

  // Step 2 — prepare without touching the native download. A right-click has
  // no native item to preserve, so preparation failures also start it in the
  // browser when the URL can be downloaded equivalently there.
  let prepared: PreparedHandoff
  try {
    prepared = await prepareHandoff(target, ops)
  } catch (error) {
    if (await fallbackExplicitly(target, ops)) {
      notifyBrowserFallback(ops)
      return
    }
    throw error
  }

  if (prepared.kind === 'sensitive-skipped') {
    if (await fallbackExplicitly(target, ops)) {
      notifySafely(ops, {
        title: i18n.t('notify.sensitiveSkippedTitle'),
        message: i18n.t('notify.sensitiveSkippedBody'),
        severity: 'reminder',
      })
      return
    }
    notifySafely(ops, {
      title: i18n.t('notify.sensitiveSkippedTitle'),
      message: i18n.t('notify.sensitiveSkippedBody'),
      severity: 'reminder',
    })
    return
  }

  // Step 3 — commit. Only now may the auto path cancel its native download.
  await commit(prepared.params, ops)
}
