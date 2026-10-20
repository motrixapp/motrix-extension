import { Methods } from '@motrix/mdxp'
import { describe, expect, it, vi } from 'vitest'
import { ConnectionManager } from '@/background/ConnectionManager'

function fixture() {
  const policy = {
    remoteDataBoundaryAcceptedAt: 1,
    allowRequestCredentials: false,
  }
  const getPolicy = vi.fn(async () => policy)
  const request = vi.fn(async () => ({
    available: true,
    entries: [{ kind: 'video', key: '1080p', label: '1080p' }],
  }))
  const state = {
    state: 'connected',
    generation: 1,
    currentConn: {},
    currentEndpointScope: { authority: { kind: 'remote' } },
    currentAuthenticatedInstanceId: 'instance-a',
    serverCapabilities: { mediaFormats: true },
    rpcRecovery: { request, snapshot: () => ({ health: 'healthy' }) },
    remotePolicyFor: vi.fn(() => ({ get: getPolicy })),
  }
  const manager = Object.assign(
    Object.create(ConnectionManager.prototype),
    state
  ) as ConnectionManager
  const document = {
    assertCurrent: vi.fn(),
    revalidate: vi.fn(async () => {}),
    signal: new AbortController().signal,
  }
  return {
    manager,
    state: manager as unknown as typeof state,
    document,
    policy,
    getPolicy,
    request,
  }
}

describe('dedicated media query authorization', () => {
  it('blocks the generic RPC path even when passed a valid request', async () => {
    const f = fixture()
    await expect(
      f.manager.request(Methods.MediaFormats, {
        url: 'https://page.example/watch',
      })
    ).rejects.toThrow('authorized query path')
    expect(f.request).not.toHaveBeenCalled()
  })
  it('uses only the URL and the current remote data grant, never credential grants', async () => {
    const f = fixture()
    const result = await f.manager.listMediaFormats(
      {
        url: 'https://page.example/watch',
        cookies: [{ name: 'sid', value: 'NEVER_SEND' }],
      } as never,
      f.document
    )
    expect(f.getPolicy).toHaveBeenCalledOnce()
    expect(f.request).toHaveBeenCalledWith(
      Methods.MediaFormats,
      { url: 'https://page.example/watch' },
      expect.anything()
    )
    expect(result.formats.available).toBe(true)
    f.state.generation += 1
    expect(result.assertCurrent).toThrow()
  })
  it('rejects a paired remote session without data-sharing consent', async () => {
    const f = fixture()
    f.policy.remoteDataBoundaryAcceptedAt = null as never
    await expect(
      f.manager.listMediaFormats(
        { url: 'https://page.example/watch' },
        f.document
      )
    ).rejects.toMatchObject({ reason: 'permissionRequired' })
    expect(f.request).not.toHaveBeenCalled()
  })
  it.each([undefined, false])(
    'does not probe a missing/false capability: %s',
    async (capability) => {
      const f = fixture()
      f.state.serverCapabilities.mediaFormats = capability as never
      await expect(
        f.manager.listMediaFormats(
          { url: 'https://page.example/watch' },
          f.document
        )
      ).rejects.toThrow()
      expect(f.request).not.toHaveBeenCalled()
    }
  )
  it.each(['document', 'policy'])(
    'fences endpoint changes during %s reads',
    async (stage) => {
      const f = fixture()
      if (stage === 'document')
        f.document.revalidate.mockImplementationOnce(async () => {
          f.state.generation += 1
        })
      else
        f.getPolicy.mockImplementationOnce(async () => {
          f.state.currentAuthenticatedInstanceId = 'instance-b'
          return f.policy
        })
      await expect(
        f.manager.listMediaFormats(
          { url: 'https://page.example/watch' },
          f.document
        )
      ).rejects.toThrow()
      expect(f.request).not.toHaveBeenCalled()
    }
  )
  it('discards a response after session retirement', async () => {
    const f = fixture()
    f.request.mockImplementationOnce(async () => {
      f.state.generation += 1
      return {
        available: true,
        entries: [{ kind: 'video', key: '1080p', label: '1080p' }],
      }
    })
    await expect(
      f.manager.listMediaFormats(
        { url: 'https://page.example/watch' },
        f.document
      )
    ).rejects.toThrow()
  })
  it('validates the returned wire result instead of trusting transport types', async () => {
    const f = fixture()
    f.request.mockResolvedValueOnce({ available: true, entries: [] })
    await expect(
      f.manager.listMediaFormats(
        { url: 'https://page.example/watch' },
        f.document
      )
    ).rejects.toThrow()
  })
})
