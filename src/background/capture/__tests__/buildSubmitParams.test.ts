import { describe, expect, it } from 'vitest'
import { buildSubmitParams } from '@/background/capture/buildSubmitParams'
import type { TakeoverTarget } from '@/shared/takeover'

function target(over: Partial<TakeoverTarget> = {}): TakeoverTarget {
  return {
    url: 'https://cdn.example.com/big.zip',
    pageUrl: 'https://example.com/p',
    pageTitle: 'P',
    suggestedFilename: 'big.zip',
    mime: 'application/zip',
    sizeBytes: 2048,
    siteHint: 'example.com',
    origin: 'auto',
    ...over,
  }
}

describe('buildSubmitParams', () => {
  it('builds a direct selection with the quality sentinel and estimatedBytes when size known', () => {
    const p = buildSubmitParams(target(), [], {
      Referer: 'https://example.com/p',
    })
    expect(p.selection.kind).toBe('direct')
    expect(p.meta.qualityLabel).toBe('file')
    expect(p.meta.suggestedFilename).toBe('big.zip')
    expect(p.meta.estimatedBytes).toBe(2048)
    expect(p.source.pageUrl).toBe('https://example.com/p')
    expect(p.source.siteHint).toBe('example.com')
    if (p.selection.kind === 'direct') {
      expect(p.selection.primary.url).toBe('https://cdn.example.com/big.zip')
      expect(p.selection.primary.headers.Referer).toBe('https://example.com/p')
    }
  })

  it('omits estimatedBytes when size is unknown (exactOptionalPropertyTypes)', () => {
    const p = buildSubmitParams(target({ sizeBytes: null }), [], {})
    expect('estimatedBytes' in p.meta).toBe(false)
  })

  it('builds a magnet selection for magnet targets, ignoring cookies/headers', () => {
    const p = buildSubmitParams(
      target({
        url: 'magnet:?xt=urn:btih:abc&dn=Movie',
        suggestedFilename: 'Movie',
        sizeBytes: null,
        mime: 'application/x-bittorrent',
      }),
      [
        {
          name: 'x',
          value: 'y',
          domain: 'd',
          path: '/',
          secure: false,
          httpOnly: false,
          sameSite: 'unspecified',
        },
      ],
      { Referer: 'https://example.com/p' }
    )
    expect(p.selection.kind).toBe('magnet')
    if (p.selection.kind === 'magnet') {
      expect(p.selection.uri).toBe('magnet:?xt=urn:btih:abc&dn=Movie')
    }
    expect(p.meta.suggestedFilename).toBe('Movie')
    expect('estimatedBytes' in p.meta).toBe(false)
  })
})
