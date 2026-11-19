import { buildSubmitParams } from '@/background/capture/buildSubmitParams'
import { downloadHttpInBrowser } from '@/background/contextMenu/register'
import type {
  ConfirmationActions,
  DownloadConfirmationService,
} from '@/background/DownloadConfirmationService'
import type { DownloadSubmissionService } from '@/background/DownloadSubmissionService'
import { DownloadPreparationError } from '@/background/download-errors'
import { notifySafely } from '@/background/handoff/delivery'
import type { HandoffGuard } from '@/background/handoff/guard'
import { makeOps, type OpsDeps } from '@/background/handoff/makeOps'
import { i18n } from '@/shared/i18n'
import { DOWNLOAD_ERROR } from '@/shared/integration'
import { supportsBrowserDownload } from '@/shared/platformCapabilities'
import { hostOf, isMagnetUrl, type TakeoverTarget } from '@/shared/takeover'
import { applyTaskOptions, type TaskOptions } from '@/shared/taskOptions'

export type ConfirmedDownloadDeps = Pick<
  OpsDeps,
  'manager' | 'isPaired' | 'gate' | 'nudge' | 'notify'
> & {
  confirmation: Pick<DownloadConfirmationService, 'request'>
  submissions: Pick<DownloadSubmissionService, 'run'>
}

export async function prepareConfirmedParams(
  deps: ConfirmedDownloadDeps,
  target: TakeoverTarget,
  guard: HandoffGuard,
  options: TaskOptions
) {
  guard.assertCurrent()
  if (
    options.directory &&
    (options.directory.endpointId !== guard.endpointId ||
      options.directory.endpointRevision !== (guard.endpointRevision ?? 0))
  )
    throw new DownloadPreparationError(DOWNLOAD_ERROR.contextChanged)
  const ops = makeOps({
    ...deps,
    guard,
    taskOptions: options,
    cancelNative: async () => {},
    fallbackToBrowser: async () => {},
    confirmSensitive: async () => true,
  })
  const cookies =
    isMagnetUrl(target.url) || ops.isSensitive(hostOf(target.url))
      ? []
      : await ops.captureCookies(target.url)
  guard.assertCurrent()
  return applyTaskOptions(buildSubmitParams(target, cookies, {}), options)
}

export function createConfirmedDownloadActions(
  deps: ConfirmedDownloadDeps,
  target: TakeoverTarget,
  guard: HandoffGuard,
  beforeSend?: () => Promise<void>
): ConfirmationActions {
  return {
    submit: (options, operationId) => {
      guard.assertCurrent()
      return deps.submissions.run(
        {
          idempotencyKey: operationId,
          source: 'direct',
          directory: options.directory,
          pairIfNeeded: true,
          resourceKey: JSON.stringify([target.url, options]),
        },
        async ({ assertCurrent }) => {
          guard.assertCurrent()
          assertCurrent()
          const params = await prepareConfirmedParams(
            deps,
            target,
            guard,
            options
          )
          guard.assertCurrent()
          assertCurrent()
          await beforeSend?.()
          guard.assertCurrent()
          assertCurrent()
          return params
        }
      )
    },
    browser:
      target.origin === 'auto' || supportsBrowserDownload()
        ? async () => {
            // The native adapter keeps its response; early interception cancels it.
            if (target.origin === 'auto' && !target.nativeDownloadCancelled)
              return
            guard.assertCurrent()
            await downloadHttpInBrowser(target.url)
          }
        : undefined,
  }
}

export async function requestConfirmedDownload(
  deps: ConfirmedDownloadDeps,
  target: TakeoverTarget,
  windowId: number | undefined,
  guard: HandoffGuard
): Promise<void> {
  guard.assertCurrent()
  const decision = await deps.confirmation.request(
    target,
    windowId,
    createConfirmedDownloadActions(deps, target, guard),
    guard.endpointId
      ? {
          endpointId: guard.endpointId,
          endpointRevision: guard.endpointRevision ?? 0,
        }
      : undefined
  )
  if (
    target.origin === 'context-menu' &&
    (decision.action === 'unavailable' || decision.action === 'unsupported')
  ) {
    notifySafely(deps, {
      title: i18n.t('options.downloadMode.confirm'),
      message: i18n.t(
        decision.action === 'unsupported'
          ? 'options.taskPanel.unsupported'
          : 'popup.confirmDownload.unavailable'
      ),
      // Keep a visible toolbar error even when system notifications are muted.
      severity: 'error',
    })
  }
}
