import type { ConnectionManager } from '@/background/ConnectionManager'
import { buildMediaSubmitParams } from '@/background/capture/buildMediaSubmitParams'
import type { MediaCredentialStore } from '@/background/capture/MediaCredentialStore'
import { buildResourceCredentials } from '@/background/capture/mediaCredentials'
import { capturePageCookies } from '@/background/capture/pageCookies'
import type { DownloadSubmissionService } from '@/background/DownloadSubmissionService'
import { DownloadPreparationError } from '@/background/download-errors'
import type { MediaStore } from '@/background/MediaStore'
import type { MessageBusHandler } from '@/background/MessageBus'
import { isExtensionPageSender } from '@/background/manualTask'
import {
  applyCallerIdempotencyKey,
  toSafeMediaSubmitError,
} from '@/background/mediaSubmission'
import { resolveStoredMedia } from '@/background/mediaTrust'
import { DOWNLOAD_ERROR } from '@/shared/integration'
import { isResolvableVideoPage } from '@/shared/media'
import { MEDIA_SUBMIT_ERROR } from '@/shared/messages'

interface PopupDownloadDeps {
  manager: Pick<ConnectionManager, 'getServerCapabilities'>
  submissions: Pick<DownloadSubmissionService, 'run'>
  mediaStore: MediaStore
  mediaCredentialStore: MediaCredentialStore
  extensionId: string
  extensionBaseUrl: string
  getActiveTabs: () => Promise<browser.tabs.Tab[]>
  cookieApi: Parameters<typeof capturePageCookies>[0]['api']
  browserKind: 'chromium' | 'firefox'
  userAgent: string
  webStore: boolean
}

/** Trusted popup intents capture their source before wake, then collect sensitive
 * request data only after readiness and capability negotiation. */
export function createPopupDownloadHandlers(deps: PopupDownloadDeps) {
  const {
    manager,
    submissions,
    mediaStore,
    mediaCredentialStore,
    getActiveTabs,
    cookieApi,
    browserKind,
    userAgent,
    webStore,
  } = deps
  const assertSender = (sender: browser.runtime.MessageSender): void => {
    if (!isExtensionPageSender(sender, deps.extensionId, deps.extensionBaseUrl))
      throw new Error(MEDIA_SUBMIT_ERROR.invalidRequest)
  }
  // bg.submitMedia: forward a detected media item to Motrix via MDXP.
  // Gates on selectionKinds capability reported by the server at initialize time;
  // hls/dash require ffmpeg on the desktop side.
  const submitMedia: MessageBusHandler<'bg.submitMedia'> = async (
    request,
    sender
  ) => {
    assertSender(sender)
    if (
      typeof request !== 'object' ||
      request === null ||
      typeof request.mediaKey !== 'string'
    ) {
      throw new Error(MEDIA_SUBMIT_ERROR.invalidRequest)
    }
    try {
      const [activeTab] = await getActiveTabs()
      const media = await resolveStoredMedia(
        request.mediaKey,
        async () => activeTab,
        mediaStore
      )
      return await submissions.run(
        {
          idempotencyKey: request.idempotencyKey,
          pairIfNeeded: request.pairIfNeeded === true,
          source: 'media',
          resourceKey: JSON.stringify([
            activeTab?.id,
            media.pageUrl,
            request.mediaKey,
          ]),
        },
        async ({ assertCurrent }) => {
          assertCurrent()
          const caps = manager.getServerCapabilities()
          const kinds = caps?.selectionKinds ?? ['direct']
          if (!kinds.includes(media.kind)) {
            throw new DownloadPreparationError(DOWNLOAD_ERROR.unsupported)
          }
          if (typeof activeTab?.id !== 'number')
            throw new Error('no active tab')
          const primaryObservation = mediaCredentialStore.get(
            activeTab.id,
            media.pageUrl,
            media.url
          )
          const primaryCredentials = await buildResourceCredentials({
            url: media.url,
            ...(primaryObservation ? { observation: primaryObservation } : {}),
            userAgent: userAgent,
          })
          const audioObservation = media.audioUrl
            ? mediaCredentialStore.get(
                activeTab.id,
                media.pageUrl,
                media.audioUrl
              )
            : undefined
          const audioCredentials = media.audioUrl
            ? await buildResourceCredentials({
                url: media.audioUrl,
                ...(audioObservation ? { observation: audioObservation } : {}),
                userAgent: userAgent,
              })
            : { cookies: [], headers: {} }
          const [currentTab] = await getActiveTabs()
          if (
            currentTab?.id !== activeTab.id ||
            !currentTab.url ||
            new URL(currentTab.url).toString() !== media.pageUrl
          ) {
            throw new DownloadPreparationError(DOWNLOAD_ERROR.contextChanged)
          }
          const params = applyCallerIdempotencyKey(
            buildMediaSubmitParams(
              media,
              primaryCredentials.cookies,
              primaryCredentials.headers,
              audioCredentials
            ),
            request
          )
          assertCurrent()
          return params
        }
      )
    } catch (error) {
      // Stored media, cookie, transport and native errors can contain private
      // URLs or paths. Only expose a stable reason to the popup.
      throw toSafeMediaSubmitError(error)
    }
  }

  // bg.resolvePageDownload: submit the active tab's watch-page URL for resolution.
  // Used for bilibili/youtube pages where the generic sniffer finds nothing.
  // Motrix's resolveToMux seam resolves the actual stream URLs server-side.
  // Does NOT gate on selectionKinds — 'direct' is always supported and turbo
  // upgrades the submit via resolveToMux on its side.
  const resolvePageDownload: MessageBusHandler<
    'bg.resolvePageDownload'
  > = async (request, sender) => {
    assertSender(sender)
    try {
      const [tab] = await getActiveTabs()
      if (!tab?.url) throw new Error('no active tab')
      const pageUrl = tab.url
      const check = isResolvableVideoPage(pageUrl, webStore)
      if (!check.resolvable) throw new Error('page not resolvable')
      return await submissions.run(
        {
          idempotencyKey: request.idempotencyKey,
          pairIfNeeded: request.pairIfNeeded === true,
          source: 'page',
          resourceKey: JSON.stringify([tab.id, pageUrl]),
        },
        async ({ assertCurrent }) => {
          assertCurrent()
          const cookies = await capturePageCookies({
            url: pageUrl,
            ...(tab.cookieStoreId ? { storeId: tab.cookieStoreId } : {}),
            browser: browserKind,
            api: cookieApi,
          })
          const [currentTab] = await getActiveTabs()
          if (
            !currentTab ||
            currentTab.id !== tab.id ||
            !currentTab.url ||
            new URL(currentTab.url).toString() !== new URL(pageUrl).toString()
          ) {
            throw new DownloadPreparationError(DOWNLOAD_ERROR.contextChanged)
          }
          const headers: Record<string, string> = {
            Referer: `${new URL(pageUrl).origin}/`,
            'User-Agent': userAgent,
          }
          const media = {
            kind: 'direct' as const,
            url: pageUrl,
            pageUrl: pageUrl,
            pageTitle: tab.title ?? pageUrl,
            detectedAt: Date.now(),
          }
          const params = applyCallerIdempotencyKey(
            buildMediaSubmitParams(media, cookies, headers),
            request
          )
          assertCurrent()
          return params
        }
      )
    } catch (error) {
      // Do not surface the active URL, cookie details or native errors.
      throw toSafeMediaSubmitError(error)
    }
  }

  return { submitMedia, resolvePageDownload }
}
