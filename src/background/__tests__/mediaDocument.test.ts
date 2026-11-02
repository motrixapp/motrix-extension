import { describe, expect, it, vi } from 'vitest'
import {
  MediaDocumentTracker,
  type MediaFrame,
} from '@/background/mediaDocument'

function fixture() {
  const url = 'https://page.example/watch'
  const tab = { id: 4, url }
  const frames: MediaFrame[] = [
    { frameId: 0, url, documentId: 'top-a' },
    { frameId: 1, url: 'about:blank' },
    {
      frameId: 2,
      url: 'https://player.example/embed/known',
      documentId: 'frame-a',
    },
  ]
  const getTab = vi.fn(async () => tab)
  const getFrames = vi.fn(async () => frames)
  const tracker = new MediaDocumentTracker({ getTab, getFrames })
  return { tracker, tab, frames, getTab, getFrames }
}

describe('browser-verified media documents', () => {
  it('accepts only an exact live frame and rechecks its identity', async () => {
    const f = fixture()
    const document = await f.tracker.capture(
      4,
      'https://player.example/embed/known'
    )
    await expect(document.revalidate()).resolves.toBeUndefined()
    await expect(
      f.tracker.capture(4, 'https://player.example/account/private')
    ).rejects.toThrow()
    f.frames[2]!.documentId = 'frame-b'
    await expect(document.revalidate()).rejects.toThrow()
  })
  it('rejects an old sender even when its tab URL is current', async () => {
    const f = fixture()
    await expect(
      f.tracker.capture(4, undefined, {
        frameId: 0,
        url: f.tab.url,
        documentId: 'old-document',
      })
    ).rejects.toThrow()
    await expect(
      f.tracker.capture(4, undefined, {
        frameId: 2,
        url: f.tab.url,
        documentId: 'top-a',
      })
    ).rejects.toThrow()
  })
  it('same-URL navigation cancels and retires old guards without documentId support', async () => {
    const f = fixture()
    delete f.frames[0]!.documentId
    const old = await f.tracker.capture(4)
    f.tracker.invalidate(4)
    expect(old.signal.aborted).toBe(true)
    expect(old.assertCurrent).toThrow()
    await expect(old.revalidate()).rejects.toThrow()
    const fresh = await f.tracker.capture(4)
    expect(fresh.signal.aborted).toBe(false)
  })
  it('rejects a fragment-only subframe change during asynchronous revalidation', async () => {
    const f = fixture()
    const document = await f.tracker.capture(
      4,
      'https://player.example/embed/known'
    )
    f.frames[2]!.url += '#different-video'
    await expect(document.revalidate()).rejects.toThrow()
    // Service-worker reference-fragment events also retire the synchronous fence.
    f.tracker.invalidate(4)
    expect(document.signal.aborted).toBe(true)
    expect(document.assertCurrent).toThrow()
  })
  it('does not accept navigation during asynchronous frame lookup', async () => {
    const f = fixture()
    f.getFrames.mockImplementationOnce(async () => {
      f.tracker.invalidate(4)
      return f.frames
    })
    await expect(f.tracker.capture(4)).rejects.toThrow()
  })
})
