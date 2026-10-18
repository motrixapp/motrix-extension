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
import type {
  MediaDocument,
  MediaDocumentTracker,
} from '@/background/mediaDocument'
import {
  applyCallerIdempotencyKey,
  toSafeMediaSubmitError,
} from '@/background/mediaSubmission'
import { resolveStoredMedia } from '@/background/mediaTrust'
import type { Browser } from '@/shared/browser'
import type { BrowserKind } from '@/shared/browserKind'
import { DOWNLOAD_ERROR } from '@/shared/integration'
import {
  type DetectedMedia,
  isResolvableVideoPage,
  mediaStorageKey,
  shouldExcludeHost,
} from '@/shared/media'
import {
  type MediaFormatsResult,
  normalizeQualityLabel,
} from '@/shared/mediaFormats'
import { MEDIA_SUBMIT_ERROR } from '@/shared/messages'

/** The overlay offers a short list; the popup remains the full browser. */
const MAX_GRAB_ITEMS = 6

interface PopupDownloadDeps {
  manager: Pick<ConnectionManager, 'getServerCapabilities' | 'listMediaFormats'>
  submissions: Pick<DownloadSubmissionService, 'run'>
  mediaStore: MediaStore
  mediaCredentialStore: MediaCredentialStore
  extensionId: string
  extensionBaseUrl: string
  getActiveTabs: () => Promise<Browser.tabs.Tab[]>
  cookieApi: Parameters<typeof capturePageCookies>[0]['api']
  browserKind: BrowserKind
  userAgent: string
  webStore: boolean
  documents: MediaDocumentTracker
  getTab: (tabId: number) => Promise<Browser.tabs.Tab>
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
    documents,
    getTab,
  } = deps
  const assertSender = (sender: Browser.runtime.MessageSender): void => {
    if (!isExtensionPageSender(sender, deps.extensionId, deps.extensionBaseUrl))
      throw new Error(MEDIA_SUBMIT_ERROR.invalidRequest)
  }
  /**
   * A grab overlay content script is trusted for its own tab only: the
   * browser authenticates `sender.tab`, so a page cannot claim another
   * tab's media. The URL must still be an http(s) document — an extension
   * or browser-internal page has no sniffed media worth submitting.
   */
  const assertGrabberSender = (
    sender: Browser.runtime.MessageSender
  ): Browser.tabs.Tab & { id: number; url: string } => {
    const tab = sender.tab
    if (
      sender.id !== deps.extensionId ||
      typeof tab?.id !== 'number' ||
      !tab.url
    ) {
      throw new Error(MEDIA_SUBMIT_ERROR.invalidRequest)
    }
    if (!/^https?:/i.test(tab.url)) {
      throw new Error(MEDIA_SUBMIT_ERROR.invalidRequest)
    }
    return tab as Browser.tabs.Tab & { id: number; url: string }
  }

  const denyExcluded = (document: MediaDocument): void => {
    for (const url of [document.tab.url, document.url]) {
      if (shouldExcludeHost(new URL(url).hostname, webStore))
        throw new Error(MEDIA_SUBMIT_ERROR.invalidRequest)
    }
  }
  const proofs = new Map<
    string,
    {
      document: MediaDocument
      assertSession(): void
      keys: Set<string>
      expiresAt: number
    }
  >()
  const checkChoice = (
    document: MediaDocument,
    quality: string,
    listingId?: string
  ): (() => void) => {
    denyExcluded(document)
    if (
      quality === 'auto' &&
      isResolvableVideoPage(document.url, webStore).resolvable
    )
      return document.assertCurrent
    const proof = listingId ? proofs.get(listingId) : undefined
    const assertChoice = () => {
      document.assertCurrent()
      denyExcluded(document)
      if (
        !proof ||
        proof.expiresAt <= Date.now() ||
        proof.document.tab.id !== document.tab.id ||
        proof.document.url !== document.url ||
        proof.document.identity !== document.identity ||
        !proof.keys.has(quality)
      )
        throw new Error(MEDIA_SUBMIT_ERROR.invalidRequest)
      proof.document.assertCurrent()
      proof.assertSession()
    }
    assertChoice()
    return assertChoice
  }

  /**
   * Submit one stored media item of `queryTab`'s tab.
   *
   * Shared by the popup (active tab) and the in-page grab overlay (the
   * sender tab). `queryTab` is called twice — once to resolve the stored
   * media and again inside the preparation callback — so a tab that navigates
   * between the two reads fails with `contextChanged` instead of submitting
   * a URL that no longer belongs to that document.
   */
  const submitMediaForTab = async (
    queryTab: () => Promise<Browser.tabs.Tab | undefined>,
    request: {
      mediaKey: string
      idempotencyKey: string
      pairIfNeeded?: boolean
    },
    assertDocument?: () => void
  ): Promise<Awaited<ReturnType<DownloadSubmissionService['run']>>> => {
    if (
      typeof request !== 'object' ||
      request === null ||
      typeof request.mediaKey !== 'string'
    ) {
      throw new Error(MEDIA_SUBMIT_ERROR.invalidRequest)
    }
    try {
      const tab = await queryTab()
      const media = await resolveStoredMedia(
        request.mediaKey,
        async () => tab,
        mediaStore
      )
      return await submissions.run(
        {
          idempotencyKey: request.idempotencyKey,
          pairIfNeeded: request.pairIfNeeded === true,
          source: 'media',
          assertCurrent: assertDocument,
          resourceKey: JSON.stringify([
            tab?.id,
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
          if (typeof tab?.id !== 'number') throw new Error('no active tab')
          const primaryObservation = mediaCredentialStore.get(
            tab.id,
            media.pageUrl,
            media.url
          )
          const primaryCredentials = await buildResourceCredentials({
            url: media.url,
            ...(primaryObservation ? { observation: primaryObservation } : {}),
            userAgent: userAgent,
          })
          const audioObservation = media.audioUrl
            ? mediaCredentialStore.get(tab.id, media.pageUrl, media.audioUrl)
            : undefined
          const audioCredentials = media.audioUrl
            ? await buildResourceCredentials({
                url: media.audioUrl,
                ...(audioObservation ? { observation: audioObservation } : {}),
                userAgent: userAgent,
              })
            : { cookies: [], headers: {} }
          const currentTab = await queryTab()
          if (
            currentTab?.id !== tab.id ||
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
  // bg.submitMedia: forward a detected media item to Motrix via MDXP.
  // Gates on selectionKinds capability reported by the server at initialize time;
  // hls/dash require ffmpeg on the desktop side.
  const submitMedia: MessageBusHandler<'bg.submitMedia'> = async (
    request,
    sender
  ) => {
    assertSender(sender)
    return submitMediaForTab(async () => (await getActiveTabs())[0], request)
  }

  // bg.resolvePageDownload: submit the active tab's watch-page URL for resolution.
  // Used for bilibili/youtube pages where the generic sniffer finds nothing.
  // Motrix's resolveToMux seam resolves the actual stream URLs server-side.
  // Does NOT gate on selectionKinds — 'direct' is always supported and turbo
  // upgrades the submit via resolveToMux on its side.
  const submitPage = async (
    document: MediaDocument,
    request: {
      idempotencyKey: string
      pairIfNeeded?: boolean
      qualityLabel?: string
      listingId?: string
    }
  ) => {
    const qualityLabel = normalizeQualityLabel(request.qualityLabel)
    const assertChoice = checkChoice(document, qualityLabel, request.listingId)
    return submissions.run(
      {
        idempotencyKey: request.idempotencyKey,
        pairIfNeeded: request.pairIfNeeded === true,
        source: 'page',
        resourceKey: JSON.stringify([
          document.tab.id,
          document.url,
          qualityLabel,
        ]),
        assertCurrent: assertChoice,
      },
      async ({ assertCurrent }) => {
        assertCurrent()
        await document.revalidate()
        assertChoice()
        const cookies =
          qualityLabel === 'auto' && document.isTopFrame
            ? await capturePageCookies({
                url: document.url,
                ...(document.tab.cookieStoreId
                  ? { storeId: document.tab.cookieStoreId }
                  : {}),
                browser: browserKind,
                api: cookieApi,
              })
            : []
        await document.revalidate()
        assertCurrent()
        assertChoice()
        const params = applyCallerIdempotencyKey(
          buildMediaSubmitParams(
            {
              kind: 'direct',
              url: document.url,
              pageUrl: document.url,
              pageTitle: document.tab.title ?? document.url,
              detectedAt: Date.now(),
            },
            cookies,
            {
              Referer: `${new URL(document.url).origin}/`,
              'User-Agent': userAgent,
            }
          ),
          request
        )
        params.meta.qualityLabel = qualityLabel
        return params
      }
    )
  }
  const resolvePageDownload: MessageBusHandler<
    'bg.resolvePageDownload'
  > = async (request, sender) => {
    assertSender(sender)
    try {
      const [tab] = await getActiveTabs()
      if (typeof tab?.id !== 'number')
        throw new Error(MEDIA_SUBMIT_ERROR.invalidRequest)
      const document = await documents.capture(tab.id)
      const revalidate = document.revalidate
      document.revalidate = async () => {
        const [active] = await getActiveTabs()
        if (!active || active.id !== tab.id || active.url !== document.tab.url)
          throw new Error(DOWNLOAD_ERROR.contextChanged)
        await revalidate()
      }
      return await submitPage(document, request)
    } catch (error) {
      throw toSafeMediaSubmitError(error)
    }
  }

  /**
   * bg.grabberSnapshot: what the in-page grab overlay should offer for the
   * tab it lives in. Returns a deliberately thin projection — key, kind and
   * a label — so page code never sees the stored stream URL or credentials.
   */
  const grabberSnapshot: MessageBusHandler<'bg.grabberSnapshot'> = async (
    _request,
    sender
  ) => {
    const tab = assertGrabberSender(sender)
    const all = await mediaStore.get(tab.id)
    const wanted = all
      .filter(isGrabTarget)
      .sort(compareGrabTargets)
      .slice(0, MAX_GRAB_ITEMS)
    return {
      connected: manager.getServerCapabilities() !== null,
      media: wanted.map((item) => ({
        key: mediaStorageKey(item),
        kind: item.kind,
        label: grabLabel(item),
        ...(item.height ? { height: item.height } : {}),
        ...(item.sizeBytes ? { sizeBytes: item.sizeBytes } : {}),
        ...(item.mimeType ? { mimeType: item.mimeType } : {}),
      })),
    }
  }
  /**
   * bg.grabberSubmit: send one detected item of the sender's tab to Motrix.
   * The tab comes from the browser-authenticated sender, never from the
   * request payload, so a page cannot submit another tab's media.
   */
  const grabberSubmit: MessageBusHandler<'bg.grabberSubmit'> = async (
    request,
    sender
  ) => {
    const tab = assertGrabberSender(sender)
    const document = await documents.capture(tab.id, undefined, sender)
    denyExcluded(document)
    return submitMediaForTab(
      async () => {
        await document.revalidate()
        return getTab(tab.id)
      },
      request,
      document.assertCurrent
    )
  }

  /** Explicit quality lookup. Page URL disclosure is gated in the manager;
   * this path deliberately never reads or forwards browser credentials. */
  const grabberFormats: MessageBusHandler<'bg.grabberFormats'> = async (
    request,
    sender
  ) => {
    const unavailable = (reason: string): MediaFormatsResult => ({
      available: false,
      reason,
      entries: [],
    })
    const capabilities = manager.getServerCapabilities()
    if (!capabilities)
      return { connected: false, formats: unavailable('not-connected') }
    if (capabilities.mediaFormats !== true)
      return { connected: true, formats: unavailable('unsupported') }
    const popup = isExtensionPageSender(
      sender,
      deps.extensionId,
      deps.extensionBaseUrl
    )
    const tab = popup ? (await getActiveTabs())[0] : assertGrabberSender(sender)
    if (typeof tab?.id !== 'number')
      throw new Error(MEDIA_SUBMIT_ERROR.invalidRequest)
    try {
      const document = await documents.capture(
        tab.id,
        request?.url,
        popup ? undefined : sender
      )
      denyExcluded(document)
      const result = await manager.listMediaFormats(
        { url: document.url },
        document
      )
      document.assertCurrent()
      if (!result.formats.available)
        return { connected: true, formats: result.formats }
      for (const [id, proof] of proofs) {
        if (proof.expiresAt <= Date.now() || proof.document.signal.aborted)
          proofs.delete(id)
      }
      while (proofs.size >= 128)
        proofs.delete(proofs.keys().next().value as string)
      const listingId = crypto.randomUUID()
      proofs.set(listingId, {
        document,
        assertSession: result.assertCurrent,
        keys: new Set(result.formats.entries.map((entry) => entry.key)),
        expiresAt: Date.now() + 60_000,
      })
      return { connected: true, formats: result.formats, listingId }
    } catch {
      return {
        connected: manager.getServerCapabilities() !== null,
        formats: unavailable('failed'),
      }
    }
  }

  const grabberResolvePageDownload: MessageBusHandler<
    'bg.grabberResolvePageDownload'
  > = async (request, sender) => {
    const tab = assertGrabberSender(sender)
    try {
      return await submitPage(
        await documents.capture(tab.id, request.pageUrl, sender),
        request
      )
    } catch (error) {
      throw toSafeMediaSubmitError(error)
    }
  }

  return {
    submitMedia,
    resolvePageDownload,
    grabberSnapshot,
    grabberSubmit,
    grabberFormats,
    grabberResolvePageDownload,
  }
}

/** Images are downloadable from the popup, but not what a grab button is for. */
function isGrabTarget(item: DetectedMedia): boolean {
  if (item.category === 'image') return false
  return (
    item.kind === 'direct' ||
    item.kind === 'hls' ||
    item.kind === 'dash' ||
    item.kind === 'mux'
  )
}

/** Biggest and newest first: size wins, then resolution, then recency. */
function compareGrabTargets(a: DetectedMedia, b: DetectedMedia): number {
  const sizeDelta = (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0)
  if (sizeDelta !== 0) return sizeDelta
  const heightDelta = (b.height ?? 0) - (a.height ?? 0)
  if (heightDelta !== 0) return heightDelta
  return b.detectedAt - a.detectedAt
}

/** Short human label for the overlay: filename, then resolution, then host. */
function grabLabel(item: DetectedMedia): string {
  if (item.suggestedFilename) return item.suggestedFilename.slice(0, 120)
  if (item.height) return `${item.height}p`
  try {
    return new URL(item.url).host
  } catch {
    return item.kind
  }
}
