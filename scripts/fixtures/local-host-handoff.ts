// Test-only UI entry for the host repository's local cross-checkout acceptance.
import type { DownloadSubmitParams } from '@motrix/mdxp'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { buildSubmitParams } from '@/background/capture/buildSubmitParams'
import { DownloadConfirmationService } from '@/background/DownloadConfirmationService'
import { registerReleaseClicks } from '@/background/interception/releaseClick'
import { DownloadConfirmationForm } from '@/popup/DownloadConfirmationDialog'
import { i18n } from '@/shared/i18n'
import { TAKEOVER_DEFAULT } from '@/shared/takeover'
import { applyTaskOptions } from '@/shared/taskOptions'

declare global {
  interface Window {
    submitLocalCandidate(
      params: DownloadSubmitParams
    ): Promise<{ taskId: string }>
  }
}
Object.assign(window, {
  async installLocalCandidate(origin: string) {
    if (new URL(origin).hostname !== '127.0.0.1')
      throw new Error('Local fixture origin required')
    await i18n.changeLanguage('en-US')
    const root = createRoot(
      document.body.appendChild(document.createElement('div'))
    )
    const confirmation = new DownloadConfirmationService({
      supported: () => true,
      userAgent: () => navigator.userAgent,
      open: async () => {},
      publish: (windowId, draft) => {
        root.render(
          draft
            ? createElement(DownloadConfirmationForm, {
                draft,
                onDismiss: () => confirmation.close(windowId),
                onDecide: (decision) =>
                  confirmation.decide(windowId, draft.id, decision),
              })
            : null
        )
      },
    })
    registerReleaseClicks(
      {
        getConfig: async () => ({
          ...TAKEOVER_DEFAULT,
          enabled: true,
          releaseClick: true,
          downloadMode: 'confirm',
        }),
        captureGuard: async () => ({
          origin: 'auto',
          endpointId: 'local-candidate',
          assertCurrent() {},
        }),
        available: () => true,
        protected: () => false,
        confirmation,
        actions: (target, _guard, beforeSend) => ({
          submit: async (options) => {
            await beforeSend()
            return window.submitLocalCandidate(
              applyTaskOptions(buildSubmitParams(target, [], {}), options)
            )
          },
        }),
        report: (outcome) => {
          document.body.dataset.outcome = outcome
        },
      },
      (url) => url === `${origin}/start/click-live`,
      (url) => url === `${origin}/download/click-live`
    )
  },
})
