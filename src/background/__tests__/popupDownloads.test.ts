import { webcrypto } from 'node:crypto'
import type { DownloadSubmitParams } from '@motrix/mdxp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaCredentialStore } from '@/background/capture/MediaCredentialStore'
import { DownloadSubmissionService } from '@/background/DownloadSubmissionService'
import { MediaStore } from '@/background/MediaStore'
import { MediaDocumentTracker } from '@/background/mediaDocument'
import { createPopupDownloadHandlers } from '@/background/popupDownloads'
import type { Browser } from '@/shared/browser'
import { newDownloadOperationId } from '@/shared/integration'
import { mediaStorageKey } from '@/shared/media'

const sender = {
  id: 'extension-id',
  url: 'chrome-extension://extension-id/popup.html',
}
const media = {
  kind: 'hls' as const,
  url: 'https://cdn.example/master.m3u8',
  pageUrl: 'https://www.youtube.com/watch?v=motrix',
  pageTitle: 'Watch',
  detectedAt: 1,
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture(
  options: {
    pageUrl?: string
    webStore?: boolean
    getAllFrames?: (details: {
      tabId: number
    }) => Promise<Array<{ url?: string }> | null>
  } = {}
) {
  const ready = deferred()
  let online = false
  const manager = {
    ensureReady: vi.fn(async () => {
      await ready.promise
      online = true
    }),
    clearGateAndStart: vi.fn(async () => {}),
    getServerCapabilities: vi.fn(() =>
      online
        ? {
            selectionKinds: ['direct', 'hls'],
            ffmpegAvailable: true,
            taskReveal: false,
            mediaFormats: true,
          }
        : null
    ),
    submitDownload: vi.fn(
      async (
        _params: DownloadSubmitParams,
        options: {
          onSubmitting?: () => Promise<void>
          assertCurrent?: () => void
        } = {}
      ) => {
        await options.onSubmitting?.()
        options.assertCurrent?.()
        return { taskId: 'task-1' }
      }
    ),
    listMediaFormats: vi.fn(async () => ({
      formats: {
        available: true as const,
        entries: [
          {
            kind: 'video' as const,
            key: '1080p',
            label: '1080p',
            height: 1080,
          },
          { kind: 'audio' as const, key: 'mp3' as const, label: 'MP3' },
        ],
      },
      assertCurrent: vi.fn(),
    })),
  }
  const submissions = new DownloadSubmissionService({
    manager,
    isPaired: async () => true,
    captureGuard: async () => ({
      endpointId: 'local',
      endpointRevision: 0,
      origin: 'context-menu',
      assertCurrent: () => {},
    }),
  })
  const mediaStore = new MediaStore()
  await mediaStore.add(4, [media])
  const mediaCredentialStore = new MediaCredentialStore()
  const observation = vi.spyOn(mediaCredentialStore, 'get')
  const getActiveTabs = vi.fn(async () => [
    {
      id: 4,
      url: options.pageUrl ?? media.pageUrl,
      title: 'Watch',
    } as Browser.tabs.Tab,
  ])
  const cookieApi = { getAll: vi.fn(async () => []) }
  const getTab = vi.fn(async () => (await getActiveTabs())[0]!)
  const documents = new MediaDocumentTracker({
    getTab,
    getFrames: async () => {
      const frames = options.getAllFrames
        ? await options.getAllFrames({ tabId: 4 })
        : [{ url: options.pageUrl ?? media.pageUrl }]
      return (
        frames?.map((frame, frameId) => ({
          ...frame,
          frameId,
          documentId: `doc-${frameId}`,
        })) ?? null
      )
    },
  })
  const handlers = createPopupDownloadHandlers({
    manager,
    submissions,
    mediaStore,
    mediaCredentialStore,
    getActiveTabs,
    cookieApi,
    extensionId: sender.id,
    extensionBaseUrl: 'chrome-extension://extension-id/',
    browserKind: 'chromium',
    userAgent: 'test-browser',
    webStore: options.webStore ?? false,
    documents,
    getTab,
  })
  return {
    handlers,
    ready,
    manager,
    getActiveTabs,
    cookieApi,
    observation,
    request: manager.listMediaFormats,
    documents,
  }
}
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  const values: Record<string, unknown> = {}
  browser.storage.session.get = vi.fn(async (key: string) => ({
    [key]: values[key],
  })) as never
  browser.storage.session.set = vi.fn(
    async (items: Record<string, unknown>) => {
      Object.assign(values, items)
    }
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('production popup download handlers', () => {
  it('waits for readiness before reading HLS capabilities and credentials', async () => {
    const f = await fixture()
    const operation = f.handlers.submitMedia(
      {
        idempotencyKey: newDownloadOperationId(),
        mediaKey: mediaStorageKey(media),
      },
      sender
    )
    await vi.waitFor(() => expect(f.manager.ensureReady).toHaveBeenCalledOnce())
    expect(f.manager.getServerCapabilities).not.toHaveBeenCalled()
    expect(f.observation).not.toHaveBeenCalled()
    f.ready.resolve()
    await expect(operation).resolves.toEqual({ taskId: 'task-1' })
    expect(f.manager.submitDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: expect.objectContaining({ kind: 'hls' }),
      }),
      expect.anything()
    )
  })
  it('captures page cookies after wake and preserves the original watch URL', async () => {
    const f = await fixture()
    const operation = f.handlers.resolvePageDownload(
      { idempotencyKey: newDownloadOperationId() },
      sender
    )
    await vi.waitFor(() => expect(f.manager.ensureReady).toHaveBeenCalledOnce())
    expect(f.cookieApi.getAll).not.toHaveBeenCalled()
    f.ready.resolve()
    await expect(operation).resolves.toEqual({ taskId: 'task-1' })
    expect(f.cookieApi.getAll).toHaveBeenCalledWith({ url: media.pageUrl })
    expect(f.manager.submitDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ pageUrl: media.pageUrl }),
      }),
      expect.anything()
    )
  })
  it.each(['media', 'page'] as const)(
    'rejects a changed active tab after wake for %s',
    async (source) => {
      const f = await fixture()
      const operation =
        source === 'media'
          ? f.handlers.submitMedia(
              {
                idempotencyKey: newDownloadOperationId(),
                mediaKey: mediaStorageKey(media),
              },
              sender
            )
          : f.handlers.resolvePageDownload(
              { idempotencyKey: newDownloadOperationId() },
              sender
            )
      const rejected = expect(operation).rejects.toThrow(
        'download.context-changed'
      )
      await vi.waitFor(() =>
        expect(f.manager.ensureReady).toHaveBeenCalledOnce()
      )
      f.getActiveTabs.mockResolvedValue([
        { id: 5, url: media.pageUrl } as Browser.tabs.Tab,
      ])
      f.ready.resolve()
      await rejected
      expect(f.manager.submitDownload).not.toHaveBeenCalled()
    }
  )
  it('rejects content-script intents before any lookup or App wake', async () => {
    const f = await fixture()
    const contentSender = { ...sender, tab: { id: 4 } as Browser.tabs.Tab }
    await expect(
      f.handlers.resolvePageDownload(
        { idempotencyKey: newDownloadOperationId(), pairIfNeeded: true },
        contentSender
      )
    ).rejects.toThrow('media-submit.invalid-request')
    await expect(
      f.handlers.submitMedia(
        {
          idempotencyKey: newDownloadOperationId(),
          mediaKey: mediaStorageKey(media),
        },
        contentSender
      )
    ).rejects.toThrow('media-submit.invalid-request')
    expect(f.getActiveTabs).not.toHaveBeenCalled()
    expect(f.manager.ensureReady).not.toHaveBeenCalled()
    expect(f.manager.clearGateAndStart).not.toHaveBeenCalled()
  })

  it('grabberResolvePageDownload accepts content-script sender and derives target from sender.tab', async () => {
    const f = await fixture()
    const contentSender = {
      id: sender.id,
      frameId: 0,
      url: media.pageUrl,
      documentId: 'doc-0',
      tab: { id: 4, url: media.pageUrl, title: 'Watch' } as Browser.tabs.Tab,
    }
    const operation = f.handlers.grabberResolvePageDownload(
      { idempotencyKey: newDownloadOperationId() },
      contentSender
    )
    await vi.waitFor(() => expect(f.manager.ensureReady).toHaveBeenCalledOnce())
    f.ready.resolve()
    await expect(operation).resolves.toEqual({ taskId: 'task-1' })
    expect(f.cookieApi.getAll).toHaveBeenCalledWith({ url: media.pageUrl })
    expect(f.manager.submitDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ pageUrl: media.pageUrl }),
      }),
      expect.anything()
    )
  })

  it('grabberResolvePageDownload rejects sender with invalid or missing tab url', async () => {
    const f = await fixture()
    const badSender = {
      id: sender.id,
      tab: { id: 4, url: 'chrome://settings' } as Browser.tabs.Tab,
    }
    await expect(
      f.handlers.grabberResolvePageDownload(
        { idempotencyKey: newDownloadOperationId() },
        badSender
      )
    ).rejects.toThrow('media-submit.invalid-request')
  })

  describe('authorized public qualities', () => {
    const embed = 'https://ok.ru/videoembed/known'
    const capabilities = {
      selectionKinds: ['direct'],
      ffmpegAvailable: true,
      taskReveal: false,
      mediaFormats: true,
    }
    const contentSender = {
      id: sender.id,
      frameId: 0,
      url: media.pageUrl,
      documentId: 'doc-0',
      tab: { id: 4, url: media.pageUrl } as Browser.tabs.Tab,
    }
    const create = async (webStore = false) => {
      const f = await fixture({
        webStore,
        getAllFrames: async () => [{ url: media.pageUrl }, { url: embed }],
      })
      f.manager.getServerCapabilities.mockReturnValue(capabilities)
      f.ready.resolve()
      return f
    }
    it('lists an exact frame without reading cookies or waking the app', async () => {
      const f = await create()
      const result = await f.handlers.grabberFormats(
        { url: embed },
        contentSender
      )
      expect(result.listingId).toEqual(expect.any(String))
      expect(f.request).toHaveBeenCalledWith({ url: embed }, expect.anything())
      expect(f.cookieApi.getAll).not.toHaveBeenCalled()
      expect(f.manager.ensureReady).not.toHaveBeenCalled()
    })
    it.each(['https://ok.ru/account/private', 'https://evil.example/steal'])(
      'rejects an unvisited target without substituting another page: %s',
      async (url) => {
        const f = await create()
        const result = await f.handlers.grabberFormats({ url }, contentSender)
        expect(result.formats.available).toBe(false)
        expect(f.request).not.toHaveBeenCalled()
      }
    )
    it('never captures top-level browser credentials for an embedded auto request', async () => {
      const embedded = 'https://www.bilibili.com/video/fixture'
      const f = await fixture({
        getAllFrames: async () => [{ url: media.pageUrl }, { url: embedded }],
      })
      f.ready.resolve()
      await expect(
        f.handlers.grabberResolvePageDownload(
          { idempotencyKey: newDownloadOperationId(), pageUrl: embedded },
          contentSender
        )
      ).resolves.toEqual({ taskId: 'task-1' })
      expect(f.cookieApi.getAll).not.toHaveBeenCalled()
      expect(f.manager.submitDownload).toHaveBeenCalledWith(
        expect.objectContaining({
          selection: expect.objectContaining({
            primary: expect.objectContaining({ cookies: [] }),
          }),
        }),
        expect.anything()
      )
    })
    it('requires an actual offered choice and submits public media without cookies', async () => {
      const f = await create()
      const request = {
        idempotencyKey: newDownloadOperationId(),
        qualityLabel: '1080p' as const,
        pageUrl: embed,
      }
      await expect(
        f.handlers.grabberResolvePageDownload(request, contentSender)
      ).rejects.toThrow()
      const result = await f.handlers.grabberFormats(
        { url: embed },
        contentSender
      )
      await expect(
        f.handlers.grabberResolvePageDownload(
          { ...request, listingId: result.listingId },
          contentSender
        )
      ).resolves.toEqual({ taskId: 'task-1' })
      expect(f.cookieApi.getAll).not.toHaveBeenCalled()
      expect(f.manager.submitDownload).toHaveBeenCalledWith(
        expect.objectContaining({
          selection: expect.objectContaining({
            primary: expect.objectContaining({ cookies: [] }),
          }),
        }),
        expect.anything()
      )
    })
    it.each(['unoffered', 'navigation', 'session', 'expiry'])(
      'rejects invalidated quality proof: %s',
      async (reason) => {
        const f = await create()
        const result = await f.handlers.grabberFormats(
          { url: embed },
          contentSender
        )
        if (reason === 'navigation') f.documents.invalidate(4)
        if (reason === 'session')
          f.request.mock.results[0]!.value.then((r) =>
            r.assertCurrent.mockImplementation(() => {
              throw new Error('session changed')
            })
          )
        if (reason === 'expiry')
          vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000)
        await Promise.resolve()
        await expect(
          f.handlers.grabberResolvePageDownload(
            {
              idempotencyKey: newDownloadOperationId(),
              pageUrl: embed,
              qualityLabel: reason === 'unoffered' ? '720p' : '1080p',
              listingId: result.listingId,
            },
            contentSender
          )
        ).rejects.toThrow()
        expect(f.manager.submitDownload).not.toHaveBeenCalled()
        vi.restoreAllMocks()
      }
    )
    it('denies web-store sites before lookup and before quality submission', async () => {
      const f = await create(true)
      expect(
        (await f.handlers.grabberFormats(undefined, contentSender)).formats
          .available
      ).toBe(false)
      await expect(
        f.handlers.resolvePageDownload(
          {
            idempotencyKey: newDownloadOperationId(),
            qualityLabel: '1080p',
            listingId: 'forged',
          },
          sender
        )
      ).rejects.toThrow()
      await expect(
        f.handlers.grabberResolvePageDownload(
          {
            idempotencyKey: newDownloadOperationId(),
            qualityLabel: 'mp3',
            listingId: 'forged',
          },
          contentSender
        )
      ).rejects.toThrow()
      expect(f.request).not.toHaveBeenCalled()
      expect(f.cookieApi.getAll).not.toHaveBeenCalled()
    })
    it.each(['www.youtube.com.', 'youtube-nocookie.com.'])(
      'does not let a DNS root dot bypass web-store exclusion: %s',
      async (host) => {
        const url = `https://${host}/watch?v=fixture`
        const f = await fixture({ webStore: true, pageUrl: url })
        f.manager.getServerCapabilities.mockReturnValue(capabilities)
        const response = await f.handlers.grabberFormats(undefined, sender)
        expect(response.formats.available).toBe(false)
        await expect(
          f.handlers.resolvePageDownload(
            {
              idempotencyKey: newDownloadOperationId(),
              qualityLabel: '1080p',
              listingId: response.listingId,
            },
            sender
          )
        ).rejects.toThrow()
        expect(f.request).not.toHaveBeenCalled()
        expect(f.manager.submitDownload).not.toHaveBeenCalled()
      }
    )
    it('does not query an old host with absent mediaFormats capability', async () => {
      const f = await create()
      f.manager.getServerCapabilities.mockReturnValue({
        ...capabilities,
        mediaFormats: false,
      })
      expect(
        (await f.handlers.grabberFormats(undefined, sender)).formats.available
      ).toBe(false)
      expect(f.request).not.toHaveBeenCalled()
    })
  })
})
