import { describe, expect, it } from 'vitest'
import { ConnectionManager } from '@/background/ConnectionManager'

describe('ConnectionManager server capabilities', () => {
  it('returns null before any handshake', () => {
    const cm = new ConnectionManager({} as never)
    expect(cm.getServerCapabilities()).toBeNull()
  })

  it('captures capabilities from an initialize result', () => {
    const cm = new ConnectionManager({} as never)
    // @ts-expect-error — exercise the private capture path used by doInitialize
    cm.captureCapabilities({
      ffmpegAvailable: true,
      selectionKinds: ['direct', 'hls', 'dash', 'mux'],
      progress: true,
      cancellation: true,
      taskReveal: true,
    })
    expect(cm.getServerCapabilities()?.selectionKinds).toContain('dash')
    expect(cm.getServerCapabilities()?.taskReveal).toBe(true)
  })

  it('keeps task reveal disabled when an older server omits the capability', () => {
    const cm = new ConnectionManager({} as never)
    // @ts-expect-error — exercise the private capture path used by doInitialize
    cm.captureCapabilities({
      ffmpegAvailable: false,
      selectionKinds: ['direct'],
    })
    expect(cm.getServerCapabilities()?.taskReveal).toBe(false)
  })
})
