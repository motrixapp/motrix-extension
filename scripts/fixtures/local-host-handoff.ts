// Test-only UI entry for the host repository's local cross-checkout acceptance.
import type { DownloadSubmitParams } from '@motrix/mdxp'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { buildSubmitParams } from '@/background/capture/buildSubmitParams'
import { normalizeTarget } from '@/background/capture/normalizeTarget'
import { DownloadConfirmationService } from '@/background/DownloadConfirmationService'
import { DownloadConfirmationForm } from '@/popup/DownloadConfirmationDialog'
import { extensionBrowser as browser } from '@/shared/browser'
import { i18n } from '@/shared/i18n'
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
    browser.runtime.onMessage.addListener((message, sender) => {
      const url = new URL('/download/click-live', origin).href
      if (
        sender.id !== browser.runtime.id ||
        sender.url !== new URL('/start/click-live', origin).href ||
        sender.tab?.windowId === undefined ||
        message?.kind !== 'fixture.confirm' ||
        message.url !== url
      )
        return
      const target = normalizeTarget({
        url,
        referrer: sender.url,
        origin: 'context-menu',
      })
      void confirmation.request(
        target,
        sender.tab.windowId,
        {
          submit: async (options) =>
            window.submitLocalCandidate(
              applyTaskOptions(buildSubmitParams(target, [], {}), options)
            ),
        },
        { endpointId: 'local-candidate', endpointRevision: 0 }
      )
    })
  },
})
