import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChromiumInterceptionDeps } from '@/background/interception/chromium'
import {
  cancelFirefoxDownload,
  handleFirefoxDownloadSafely,
} from '@/background/interception/firefox'

interface DownloadsStub {
  cancel: ReturnType<typeof vi.fn>
  erase: ReturnType<typeof vi.fn>
}

let downloads: DownloadsStub

beforeEach(() => {
  downloads = {
    cancel: vi.fn(async () => {}),
    erase: vi.fn(async () => {}),
  }
  ;(
    globalThis as Record<string, unknown> & { browser: Record<string, unknown> }
  ).browser.downloads = downloads
})

describe('cancelFirefoxDownload', () => {
  it('cancels before erasing the history item', async () => {
    await cancelFirefoxDownload(7)

    expect(downloads.cancel).toHaveBeenCalledWith(7)
    expect(downloads.erase).toHaveBeenCalledWith({ id: 7 })
    expect(downloads.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      downloads.erase.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
  })

  it('treats erase failure as best-effort after cancellation', async () => {
    downloads.erase.mockRejectedValueOnce(new Error('history unavailable'))

    await expect(cancelFirefoxDownload(7)).resolves.toBeUndefined()
    expect(downloads.cancel).toHaveBeenCalledWith(7)
  })

  it('propagates cancel failure so the native download is not submitted twice', async () => {
    downloads.cancel.mockRejectedValueOnce(new Error('cancel failed'))

    await expect(cancelFirefoxDownload(7)).rejects.toThrow('cancel failed')
    expect(downloads.erase).not.toHaveBeenCalled()
  })
})

describe('handleFirefoxDownloadSafely', () => {
  it('contains a rejected startup barrier before touching the native download', async () => {
    const deps = {
      getConfig: async () => {
        throw new Error('background startup unavailable: private data')
      },
    } as unknown as ChromiumInterceptionDeps

    await expect(
      handleFirefoxDownloadSafely(
        {
          id: 7,
          url: 'https://private.example/download',
          totalBytes: 1,
        } as browser.downloads.DownloadItem,
        deps
      )
    ).resolves.toBeUndefined()
    expect(downloads.cancel).not.toHaveBeenCalled()
    expect(downloads.erase).not.toHaveBeenCalled()
  })
})
