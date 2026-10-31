import type { DownloadSubmitParams } from '@motrix/mdxp'
import {
  DownloadOutcomeUnknownError,
  DownloadPreparationError,
} from '@/background/download-errors'
import { HandoffEndpointChangedError } from '@/background/handoff/guard'
import type { HandoffOps, HandoffResult } from '@/background/handoff/runHandoff'
import {
  RemoteAutomaticTakeoverConsentRequiredError,
  RemoteDataBoundaryConsentRequiredError,
} from '@/background/remote-submit-policy'
import { i18n } from '@/shared/i18n'
import { DOWNLOAD_ERROR } from '@/shared/integration'
import type { Notify } from '@/shared/notifications'

export const CONNECT_DEADLINE_MS = 8000

export function notifySafely(
  ops: Pick<HandoffOps, 'notify'>,
  input: Parameters<Notify>[0]
): void {
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
): Promise<HandoffResult> {
  let accepted: { taskId: string }
  try {
    accepted = await submitOnce(params, ops)
  } catch (error) {
    if (error instanceof DownloadOutcomeUnknownError) {
      notifySafely(ops, {
        title: i18n.t('notify.submitUnknownTitle'),
        message: i18n.t('notify.submitUnknownBody'),
        severity: 'reminder',
      })
      return { kind: 'unknown', operationId: params.idempotencyKey ?? '' }
    }
    let fellBack = false
    let fallbackUncertain = false
    try {
      // Magnet links cannot be restored through the browser downloads API.
      if (params.selection.kind === 'direct') {
        await ops.fallbackToBrowser()
        fellBack = true
      }
    } catch (fallbackError) {
      // The browser API can fail after starting a download. Do not retry or
      // claim that fallback succeeded; ask the user to inspect browser downloads.
      fallbackUncertain = true
      throw fallbackError
    } finally {
      const cookiesRejected =
        error instanceof DownloadPreparationError &&
        error.reason === DOWNLOAD_ERROR.cookiesRejected
      notifySafely(ops, {
        title: i18n.t('notify.submitFailedTitle'),
        message: i18n.t(
          fallbackUncertain
            ? 'notify.browserFallbackUnknownBody'
            : cookiesRejected
              ? fellBack
                ? 'notify.cookiesRejectedBody'
                : 'popup.integration.cookiesRejected'
              : fellBack
                ? 'notify.submitFailedBody'
                : 'notify.submitRejectedBody'
        ),
        severity: 'error',
      })
    }
    return { kind: fellBack ? 'browser' : 'failed' }
  }

  notifySafely(ops, {
    title: i18n.t('notify.handedToMotrix'),
    message: params.meta.suggestedFilename,
    severity: 'confirm',
  })
  return {
    kind: 'accepted',
    taskId: accepted.taskId,
    operationId: params.idempotencyKey ?? '',
  }
}

async function submitOnce(
  params: DownloadSubmitParams,
  ops: HandoffOps
): Promise<{ taskId: string }> {
  try {
    return await ops.submit(params)
  } catch (error) {
    // A generic exception does not prove that the remote side rejected the
    // task. Preserve uncertainty even when an adapter forgot to classify it.
    if (
      error instanceof DownloadOutcomeUnknownError ||
      error instanceof DownloadPreparationError ||
      error instanceof HandoffEndpointChangedError ||
      error instanceof RemoteDataBoundaryConsentRequiredError ||
      error instanceof RemoteAutomaticTakeoverConsentRequiredError
    )
      throw error
    throw new DownloadOutcomeUnknownError()
  }
}

function withIdempotencyKey(
  params: DownloadSubmitParams
): DownloadSubmitParams {
  return params.idempotencyKey
    ? params
    : { ...params, idempotencyKey: crypto.randomUUID() }
}

export async function commitHandoff(
  params: DownloadSubmitParams,
  ops: HandoffOps
): Promise<HandoffResult> {
  const keyedParams = withIdempotencyKey(params)
  await ops.cancelNative()
  return await submitOrFallback(keyedParams, ops)
}
