import { describe, expect, it, vi } from 'vitest'
import { probeTarget } from '@/background/capture/probeSize'

function res(ok: boolean, headers: Record<string, string>): Response {
  return { ok, headers: new Headers(headers) } as unknown as Response
}

describe('probeTarget size', () => {
  it('returns Content-Length on a successful HEAD', async () => {
    const fetchImpl = vi.fn(async () => res(true, { 'content-length': '4096' }))
    expect(
      (
        await probeTarget('https://h/f', {
          fetch: fetchImpl as unknown as typeof fetch,
        })
      ).sizeBytes
    ).toBe(4096)
  })

  it('returns null on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => res(false, {}))
    expect(
      (
        await probeTarget('https://h/f', {
          fetch: fetchImpl as unknown as typeof fetch,
        })
      ).sizeBytes
    ).toBeNull()
  })

  it('returns null when fetch throws (timeout / network / opaque)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('aborted')
    })
    expect(
      (
        await probeTarget('https://h/f', {
          fetch: fetchImpl as unknown as typeof fetch,
        })
      ).sizeBytes
    ).toBeNull()
  })
})

describe('probeTarget', () => {
  it('reports the Content-Type alongside the size', async () => {
    const fetchImpl = vi.fn(async () =>
      res(true, { 'content-length': '4096', 'content-type': 'application/zip' })
    )
    expect(
      await probeTarget('https://h/f', {
        fetch: fetchImpl as unknown as typeof fetch,
      })
    ).toEqual({ sizeBytes: 4096, contentType: 'application/zip' })
  })

  it('reports the Content-Type even when the size is unknown', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(true, { 'content-type': 'text/html' }))
      .mockResolvedValueOnce(res(true, { 'content-type': 'text/html' }))
    expect(
      await probeTarget('https://h/f', {
        fetch: fetchImpl as unknown as typeof fetch,
      })
    ).toEqual({ sizeBytes: null, contentType: 'text/html' })
  })

  it('shares one deadline across HEAD and the ranged GET fallback', async () => {
    // The hold budgets the probe at 3 s (HOLD_DEADLINE_MS). A HEAD that used
    // the whole window must not buy the fallback GET another full timeout.
    let clock = 0
    const fetchImpl = vi.fn(async () => {
      clock += 3000
      return res(true, { 'content-type': 'text/html' })
    })
    expect(
      await probeTarget('https://h/f', {
        fetch: fetchImpl as unknown as typeof fetch,
        timeoutMs: 3000,
        now: () => clock,
      })
    ).toEqual({ sizeBytes: null, contentType: 'text/html' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('reports nothing when the probe cannot run', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('aborted')
    })
    expect(
      await probeTarget('https://h/f', {
        fetch: fetchImpl as unknown as typeof fetch,
      })
    ).toEqual({ sizeBytes: null, contentType: null })
  })
})
