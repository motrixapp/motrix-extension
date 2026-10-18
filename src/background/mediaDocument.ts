import type { Browser } from '@/shared/browser'
import { DOWNLOAD_ERROR } from '@/shared/integration'

export interface MediaFrame {
  frameId: number
  url?: string | undefined
  documentId?: string | undefined
}

export interface MediaDocument {
  tab: Browser.tabs.Tab & { id: number; url: string }
  url: string
  identity: string
  isTopFrame: boolean
  signal: AbortSignal
  assertCurrent(): void
  revalidate(): Promise<void>
}

function canonicalUrl(value: string): string {
  const url = new URL(value)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(DOWNLOAD_ERROR.contextChanged)
  return url.href
}

/** A navigation event retires every outstanding intent for that tab, including
 * same-URL reloads and subframe replacements on browsers without documentId. */
export class MediaDocumentTracker {
  private readonly tabs = new Map<number, AbortController>()

  constructor(
    private readonly deps: {
      getTab(tabId: number): Promise<Browser.tabs.Tab>
      getFrames(tabId: number): Promise<MediaFrame[] | null>
    }
  ) {}

  invalidate(tabId: number): void {
    this.tabs.get(tabId)?.abort()
    this.tabs.delete(tabId)
  }

  async capture(
    tabId: number,
    candidate?: string,
    sender?: Browser.runtime.MessageSender
  ): Promise<MediaDocument> {
    let controller = this.tabs.get(tabId)
    if (!controller) {
      controller = new AbortController()
      this.tabs.set(tabId, controller)
    }
    const signal = controller.signal
    const assertCurrent = () => {
      if (signal.aborted) throw new Error(DOWNLOAD_ERROR.contextChanged)
    }
    const tab = await this.deps.getTab(tabId)
    const frames = await this.deps.getFrames(tabId)
    assertCurrent()
    if (tab.id !== tabId || !tab.url || !frames)
      throw new Error(DOWNLOAD_ERROR.contextChanged)
    const topUrl = canonicalUrl(tab.url)
    const top = frames.find((frame) => frame.frameId === 0)
    if (!top?.url || canonicalUrl(top.url) !== topUrl)
      throw new Error(DOWNLOAD_ERROR.contextChanged)
    if (
      sender &&
      (sender.frameId !== 0 ||
        !sender.url ||
        canonicalUrl(sender.url) !== topUrl ||
        (sender.documentId && sender.documentId !== top.documentId))
    )
      throw new Error(DOWNLOAD_ERROR.contextChanged)
    const url = canonicalUrl(candidate ?? topUrl)
    const target = frames.find((frame) => {
      try {
        return frame.url && canonicalUrl(frame.url) === url
      } catch {
        return false
      }
    })
    if (!target) throw new Error(DOWNLOAD_ERROR.contextChanged)
    const topDocumentId = top.documentId
    const targetDocumentId = target.documentId
    const targetFrameId = target.frameId
    return {
      tab: { ...tab } as Browser.tabs.Tab & { id: number; url: string },
      url,
      identity: JSON.stringify([
        tabId,
        topUrl,
        topDocumentId,
        targetFrameId,
        targetDocumentId,
        url,
      ]),
      isTopFrame: targetFrameId === 0,
      signal,
      assertCurrent,
      revalidate: async () => {
        assertCurrent()
        const latestTab = await this.deps.getTab(tabId)
        const latestFrames = await this.deps.getFrames(tabId)
        assertCurrent()
        const currentTop = latestFrames?.find((frame) => frame.frameId === 0)
        const current = latestFrames?.find(
          (frame) => frame.frameId === targetFrameId
        )
        if (
          latestTab.id !== tabId ||
          !latestTab.url ||
          canonicalUrl(latestTab.url) !== topUrl ||
          !currentTop?.url ||
          canonicalUrl(currentTop.url) !== topUrl ||
          currentTop.documentId !== topDocumentId ||
          !current?.url ||
          canonicalUrl(current.url) !== url ||
          current.documentId !== targetDocumentId
        )
          throw new Error(DOWNLOAD_ERROR.contextChanged)
      },
    }
  }
}
