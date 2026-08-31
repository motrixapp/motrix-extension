import { describe, expect, it, vi } from 'vitest'
import { probeSize } from '@/background/capture/probeSize'

function res(ok: boolean, headers: Record<string, string>): Response {
  return { ok, headers: new Headers(headers) } as unknown as Response
}

describe('probeSize', () => {
  it('returns Content-Length on a successful HEAD', async () => {
    const fetchImpl = vi.fn(async () => res(true, { 'content-length': '4096' }))
    expect(
      await probeSize('https://h/f', {
        fetch: fetchImpl as unknown as typeof fetch,
      })
    ).toBe(4096)
  })

  it('returns null on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => res(false, {}))
    expect(
      await probeSize('https://h/f', {
        fetch: fetchImpl as unknown as typeof fetch,
      })
    ).toBeNull()
  })

  it('returns null when fetch throws (timeout / network / opaque)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('aborted')
    })
    expect(
      await probeSize('https://h/f', {
        fetch: fetchImpl as unknown as typeof fetch,
      })
    ).toBeNull()
  })
})
