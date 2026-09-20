import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeTarget } from '@/background/capture/normalizeTarget'
import { createContextMenuDownloadRunner } from '@/background/contextMenu/download'
import {
  DownloadOutcomeUnknownError,
  DownloadPreparationError,
} from '@/background/download-errors'
import { extensionBrowser } from '@/shared/browser'
import { DOWNLOAD_ERROR } from '@/shared/integration'

function fixture() {
  const present = vi.fn(async () => {})
  const guard = {
    origin: 'context-menu' as const,
    endpointId: 'nas',
    endpointRevision: 2,
    assertCurrent: vi.fn(),
  }
  const deps = {
    popup: { captureSubmission: vi.fn(() => present) },
    ready: vi.fn(async () => {}),
    captureGuard: vi.fn(async () => guard),
    manager: {
      getState: () => 'connected' as const,
      getLastError: () => null,
      getRpcStatus: () => ({ health: 'healthy' }),
      submitDownload: vi.fn(async () => ({ taskId: 'right-click-task' })),
    },
    isPaired: async () => true,
    gate: {},
    nudge: {},
    notify: vi.fn(),
  }
  return {
    present,
    deps,
    guard,
    run: createContextMenuDownloadRunner(deps as never),
  }
}

beforeEach(() => {
  Object.assign(extensionBrowser, {
    cookies: { getAll: vi.fn(async () => []) },
    downloads: { download: vi.fn(async () => 1) },
  })
})

describe('context menu download presentation', () => {
  it.each(['https://example.com/file.zip', 'magnet:?xt=urn:btih:abc'])(
    'presents only after an explicit task is accepted: %s',
    async (url) => {
      const f = fixture()
      await f.run(normalizeTarget({ url, origin: 'context-menu' }))
      expect(
        f.deps.popup.captureSubmission.mock.invocationCallOrder[0]
      ).toBeLessThan(f.deps.ready.mock.invocationCallOrder[0]!)
      expect(f.present).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'right-click-task',
          operationId: expect.any(String),
        }),
        f.guard
      )
      expect(
        f.deps.manager.submitDownload.mock.invocationCallOrder[0]
      ).toBeLessThan(f.present.mock.invocationCallOrder[0]!)
    }
  )

  it.each([
    new DownloadOutcomeUnknownError(),
    new DownloadPreparationError(DOWNLOAD_ERROR.rejected),
  ])('does not present an unaccepted task: %s', async (error) => {
    const f = fixture()
    f.deps.manager.submitDownload.mockRejectedValue(error)
    await f.run(
      normalizeTarget({
        url: 'https://example.com/file.zip',
        origin: 'context-menu',
      })
    )
    expect(f.present).not.toHaveBeenCalled()
  })

  it('does not turn a popup failure into a browser fallback', async () => {
    const f = fixture()
    f.present.mockRejectedValue(new Error('popup unavailable'))
    await expect(
      f.run(
        normalizeTarget({
          url: 'https://example.com/file.zip',
          origin: 'context-menu',
        })
      )
    ).resolves.toBeUndefined()
    expect(extensionBrowser.downloads.download).not.toHaveBeenCalled()
  })
})
