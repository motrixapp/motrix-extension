import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installGrabOverlay } from '@/content/grab-overlay'

describe('grab-overlay playback transition', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = ''
    const existing = document.getElementById('motrix-grab-overlay')
    existing?.remove()

    // Mock browser.runtime.sendMessage
    chrome.runtime.sendMessage = vi.fn(async (message: any) => {
      if (message?.kind === 'bg.grabberSnapshot') {
        return { connected: true, media: [] }
      }
      if (message?.kind === 'bg.grabberFormats') {
        return {
          connected: true,
          formats: { available: false, entries: [], reason: 'test' },
        }
      }
      if (message?.kind === 'bg.grabberResolvePageDownload') {
        return { taskId: 'task-1' }
      }
      return undefined
    }) as any
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
    const existing = document.getElementById('motrix-grab-overlay')
    existing?.remove()
  })

  function createVideo(): HTMLVideoElement {
    const video = document.createElement('video')
    Object.defineProperty(video, 'videoWidth', { value: 640 })
    Object.defineProperty(video, 'videoHeight', { value: 360 })
    Object.defineProperty(video, 'paused', { value: false, writable: true })
    Object.defineProperty(video, 'ended', { value: false, writable: true })
    Object.defineProperty(video, 'readyState', { value: 4, writable: true })
    video.getBoundingClientRect = () =>
      ({
        top: 100,
        left: 100,
        right: 740,
        bottom: 460,
        width: 640,
        height: 360,
      }) as DOMRect
    return video
  }

  it('renders download pill when video playback starts after initial load', async () => {
    // 1. Install overlay with no media and no playing video
    installGrabOverlay()
    const host = document.getElementById('motrix-grab-overlay') as any
    expect(host).not.toBeNull()
    const shadow = host.__motrixGrabShadow as ShadowRoot
    expect(shadow).toBeDefined()
    const wrap = shadow.querySelector('.wrap') as HTMLElement
    expect(wrap).not.toBeNull()
    expect(wrap.querySelector('.pill')).toBeNull()

    // 2. Insert video element and start playback
    const video = createVideo()
    document.body.appendChild(video)

    // Dispatch play event
    video.dispatchEvent(new Event('play', { bubbles: false }))

    // Advance timer for any pending RAF or tick
    await vi.advanceTimersByTimeAsync(2000)

    // 3. The pill button MUST now be rendered!
    const pill = wrap.querySelector('.pill') as HTMLButtonElement
    expect(pill).not.toBeNull()
    expect(wrap.hidden).toBe(false)
  })

  it('submits page download via bg.grabberResolvePageDownload from the overlay panel', async () => {
    installGrabOverlay()
    const host = document.getElementById('motrix-grab-overlay') as any
    const shadow = host.__motrixGrabShadow as ShadowRoot
    const wrap = shadow.querySelector('.wrap') as HTMLElement

    // Add playing video
    const video = createVideo()
    document.body.appendChild(video)
    video.dispatchEvent(new Event('play'))
    await vi.advanceTimersByTimeAsync(2000)
    await Promise.resolve()

    const pill = wrap.querySelector('.pill') as HTMLButtonElement
    expect(pill).not.toBeNull()

    // Click pill to open panel
    pill.click()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(100)

    const panel = wrap.querySelector('.panel') as HTMLElement
    expect(panel).not.toBeNull()

    // Find and click the download button in the panel
    const row = panel.querySelector('.row:not(.note)') as HTMLButtonElement
    expect(row).not.toBeNull()
    expect(row.disabled).toBe(false)
    row.click()

    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(100)

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'bg.grabberResolvePageDownload',
      })
    )
  })

  it('stays hidden when the page only has sniffed media and no video element', async () => {
    chrome.runtime.sendMessage = vi.fn(async (message: any) => {
      if (message?.kind === 'bg.grabberSnapshot') {
        return {
          connected: true,
          media: [{ key: 'm-1', label: 'clip.mp4', kind: 'video' }],
        }
      }
      if (message?.kind === 'bg.grabberFormats') {
        return {
          connected: true,
          formats: { available: false, entries: [], reason: 'test' },
        }
      }
      return undefined
    }) as any

    installGrabOverlay()
    await vi.advanceTimersByTimeAsync(2000)

    const host = document.getElementById('motrix-grab-overlay') as any
    const shadow = host.__motrixGrabShadow as ShadowRoot
    const wrap = shadow.querySelector('.wrap') as HTMLElement

    // No video to anchor to: the overlay must be hidden rather than float a
    // clickable pill over the page (the bug that blocked clicks on every tab).
    expect(wrap.hidden).toBe(true)
    expect(wrap.querySelector('.pill')).toBeNull()
  })

  it('hides when the video scrolls off-screen instead of falling back to a corner pill', async () => {
    installGrabOverlay()
    const host = document.getElementById('motrix-grab-overlay') as any
    const shadow = host.__motrixGrabShadow as ShadowRoot
    const wrap = shadow.querySelector('.wrap') as HTMLElement

    const video = createVideo()
    document.body.appendChild(video)
    video.dispatchEvent(new Event('play'))
    await vi.advanceTimersByTimeAsync(2000)

    expect(wrap.querySelector('.pill')).not.toBeNull()
    expect(wrap.hidden).toBe(false)

    // Scroll the video fully out of view.
    video.getBoundingClientRect = () =>
      ({
        top: -1000,
        left: 100,
        right: 740,
        bottom: -900,
        width: 640,
        height: 360,
      }) as DOMRect
    video.dispatchEvent(new Event('pause'))

    expect(wrap.hidden).toBe(true)
    expect(wrap.querySelector('.pill')).toBeNull()
    // Never re-anchors to a viewport-stretching corner overlay.
    expect(wrap.style.right).toBe('')
    expect(wrap.style.bottom).toBe('')
  })
})
