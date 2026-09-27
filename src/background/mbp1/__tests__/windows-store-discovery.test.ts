import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteBackendAuthority,
  WINDOWS_STORE_BACKEND_AUTHORITY,
} from '@/background/mbp1/backend-authority'
import {
  DiscoveryService,
  type DiscoveryServiceOptions,
  type TabsPort,
} from '@/background/mbp1/discovery-service'

function live(instanceId: string): Response {
  return Response.json({
    app: 'motrix-bridge',
    apiVersion: 1,
    instanceId,
    appVersion: '2.0.0',
    runtime: 'electron',
    extensionPairing: { protocol: 'mbp1', versions: [1] },
    applicationProtocols: { mdxp: ['1.0'] },
  })
}

function fixture(options: Partial<DiscoveryServiceOptions> = {}) {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = []
  const responders = new Map<number, string>()
  const pins = {
    get: vi.fn(async () => null),
    commit: vi.fn(),
    clear: vi.fn(),
  }
  const tabs = {
    create: vi.fn<TabsPort['create']>(async () => ({ id: 12 })),
    remove: vi.fn<TabsPort['remove']>(async () => undefined),
  }
  const nativeBootstrap = {
    bootstrap: vi.fn(async () => ({ port: 16802, nonce: 'default-only' })),
  }
  const service = new DiscoveryService({
    authority: WINDOWS_STORE_BACKEND_AUTHORITY,
    candidatePorts: [16802, 16803],
    wakeDeadlineMs: 1200,
    pins,
    tabs,
    nativeBootstrap,
    fetchImpl: vi.fn(async (input, init) => {
      const url = String(input)
      requests.push({ url, init })
      const instanceId = responders.get(Number(new URL(url).port))
      return instanceId ? live(instanceId) : new Response('', { status: 503 })
    }),
    ...options,
  })
  return { service, requests, responders, pins, tabs, nativeBootstrap }
}

afterEach(() => vi.useRealTimers())

describe('Windows Store discovery policy', () => {
  it('rejects forged and remote authorities before any discovery', () => {
    expect(() =>
      fixture({ authority: { ...WINDOWS_STORE_BACKEND_AUTHORITY } })
    ).toThrow('module factory')
    expect(() =>
      fixture({
        authority: createRemoteBackendAuthority({
          endpointId: 'nas',
          wsBase: 'wss://nas.example',
        }) as never,
      })
    ).toThrow('local authority')
  })

  it('enumerates every candidate without invoking the default native host or launching', async () => {
    const f = fixture()
    f.responders.set(16802, 'direct')
    f.responders.set(16803, 'store')
    const candidates = await f.service.discoverForFirstPair({
      allowLaunch: true,
      bindingPub: new Uint8Array(32),
    })
    expect(candidates.map(({ wsPort }) => wsPort)).toEqual([16802, 16803])
    expect(candidates.every(({ transport }) => transport === 'probe')).toBe(
      true
    )
    expect(candidates.every(({ nonce, nmTicket }) => !nonce && !nmTicket)).toBe(
      true
    )
    expect(f.nativeBootstrap.bootstrap).not.toHaveBeenCalled()
    expect(f.tabs.create).not.toHaveBeenCalled()
    expect(f.requests.every(({ url }) => url.endsWith('/discovery'))).toBe(true)
  })

  it('does not replace an explicit choice with the other live installation', async () => {
    const f = fixture()
    f.responders.set(16802, 'direct')
    expect(
      await f.service.discoverForFirstPair({
        allowLaunch: true,
        preferredCandidatePort: 16803,
      })
    ).toEqual([])
    expect(f.requests.map(({ url }) => new URL(url).port)).toEqual(['16803'])
    expect(f.nativeBootstrap.bootstrap).not.toHaveBeenCalled()
  })

  it('opens only the fixed Store URI and retains the tab when another app is live', async () => {
    const f = fixture()
    f.responders.set(16802, 'direct')
    expect(await f.service.wakeAndPoll()).toHaveLength(1)
    expect(f.tabs.create).toHaveBeenCalledExactlyOnceWith({
      url: 'motrix-store://open',
    })
    expect(f.tabs.remove).not.toHaveBeenCalled()
    expect(f.nativeBootstrap.bootstrap).not.toHaveBeenCalled()
  })

  it('requires the credential identity even with a pin or one live candidate', async () => {
    const f = fixture({
      pins: { get: vi.fn(async () => ({ port: 16802, instanceId: 'direct' })) },
    })
    f.responders.set(16802, 'direct')
    expect(await f.service.discoverForReconnect('credential')).toBeNull()
    expect(await f.service.wakeForReconnect(['credential'])).toEqual(new Map())
    expect(f.requests).toEqual([])
    expect(f.tabs.create).not.toHaveBeenCalled()
    expect(f.nativeBootstrap.bootstrap).not.toHaveBeenCalled()
  })

  it('finds the credential instance after a port move without adopting a stale pin identity', async () => {
    const f = fixture({
      pins: { get: vi.fn(async () => ({ port: 35001, instanceId: 'direct' })) },
    })
    f.responders.set(35001, 'direct')
    f.responders.set(16802, 'direct')
    f.responders.set(16803, 'store')
    expect(
      await f.service.discoverForReconnect('credential', 'store')
    ).toMatchObject({
      wsPort: 16803,
      instanceId: 'store',
      transport: 'probe',
    })
    expect(f.requests.some(({ url }) => new URL(url).port === '35001')).toBe(
      false
    )
    expect(f.tabs.create).not.toHaveBeenCalled()
  })

  it('supports interrupted pairing with no pin but an authenticated credential instance', async () => {
    const f = fixture()
    f.responders.set(16802, 'direct')
    f.responders.set(16803, 'store')
    expect(
      await f.service.discoverForReconnect('credential', 'store')
    ).toMatchObject({
      wsPort: 16803,
      instanceId: 'store',
    })
    expect(f.pins.commit).not.toHaveBeenCalled()
    expect(f.pins.clear).not.toHaveBeenCalled()
  })

  it('does not choose a single wrong instance or an ambiguous repeated identity', async () => {
    const f = fixture()
    f.responders.set(16802, 'direct')
    expect(
      await f.service.discoverForReconnect('credential', 'store')
    ).toBeNull()
    f.responders.set(16802, 'store')
    f.responders.set(16803, 'store')
    expect(
      await f.service.discoverForReconnect('credential', 'store')
    ).toBeNull()
  })

  it('polls past a live direct installation and returns only retained Store credentials', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.responders.set(16802, 'direct')
    const pending = f.service.wakeForReconnect(
      ['known', 'unbound'],
      new Map([
        ['known', 'store'],
        ['unlisted', 'direct'],
      ])
    )
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(settled).toBe(false)
    f.responders.set(16803, 'store')
    await vi.advanceTimersByTimeAsync(500)
    const matches = await pending
    expect([...matches.keys()]).toEqual(['known'])
    expect(matches.get('known')).toMatchObject({
      wsPort: 16803,
      instanceId: 'store',
    })
    expect(f.tabs.create).toHaveBeenCalledExactlyOnceWith({
      url: 'motrix-store://open',
    })
    expect(f.tabs.remove).not.toHaveBeenCalled()
    expect(f.nativeBootstrap.bootstrap).not.toHaveBeenCalled()
    expect(f.pins.commit).not.toHaveBeenCalled()
    expect(f.pins.clear).not.toHaveBeenCalled()
    for (const { url, init } of f.requests) {
      expect(url.endsWith('/discovery')).toBe(true)
      expect(init?.method).toBeUndefined()
      expect(init?.headers).toBeUndefined()
      expect(init?.redirect).toBe('error')
      expect(init?.cache).toBe('no-store')
    }
  })

  it('uses a matching pin outside the range during both discovery and explicit wake', async () => {
    const f = fixture({
      pins: { get: vi.fn(async () => ({ port: 35001, instanceId: 'store' })) },
    })
    f.responders.set(16802, 'direct')
    f.responders.set(35001, 'store')
    expect(
      await f.service.discoverForReconnect('credential', 'store')
    ).toMatchObject({ wsPort: 35001 })
    const matches = await f.service.wakeForReconnect(
      ['credential'],
      new Map([['credential', 'store']])
    )
    expect(matches.get('credential')).toMatchObject({ wsPort: 35001 })
  })

  it.each(['first-pair', 'reconnect'] as const)(
    'bounds %s polling even when the browser never resolves the protocol tab',
    async (mode) => {
      vi.useFakeTimers()
      const f = fixture()
      f.tabs.create.mockImplementation(() => new Promise(() => {}))
      let settled = false
      const pending =
        mode === 'first-pair'
          ? f.service.wakeAndPoll()
          : f.service.wakeForReconnect(
              ['credential'],
              new Map([['credential', 'store']])
            )
      void pending.then(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(1199)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBe(true)
      const result = await pending
      expect(result instanceof Map ? result.size : result.length).toBe(0)
      expect(f.tabs.create).toHaveBeenCalledTimes(1)
      expect(f.tabs.remove).not.toHaveBeenCalled()
    }
  )

  it('returns no match after a rejected launch and never falls back to the default host', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.tabs.create.mockRejectedValue(new Error('no protocol handler'))
    f.responders.set(16802, 'direct')
    const pending = f.service.wakeForReconnect(
      ['credential'],
      new Map([['credential', 'store']])
    )
    await vi.advanceTimersByTimeAsync(1200)
    expect(await pending).toEqual(new Map())
    expect(f.nativeBootstrap.bootstrap).not.toHaveBeenCalled()
    expect(f.tabs.remove).not.toHaveBeenCalled()
  })

  it.each(['', 'has space', 'non-ascii-界', 'x'.repeat(129)])(
    'does not launch or probe for an invalid credential identity %j',
    async (instanceId) => {
      const f = fixture()
      expect(
        await f.service.discoverForReconnect('credential', instanceId)
      ).toBeNull()
      expect(
        await f.service.wakeForReconnect(
          ['credential'],
          new Map([['credential', instanceId]])
        )
      ).toEqual(new Map())
      expect(f.requests).toEqual([])
      expect(f.tabs.create).not.toHaveBeenCalled()
    }
  )

  it('does not turn a repeated instance hint into a reconnect choice during wake', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.responders.set(16802, 'store')
    f.responders.set(16803, 'store')
    const pending = f.service.wakeForReconnect(
      ['credential'],
      new Map([['credential', 'store']])
    )
    await vi.advanceTimersByTimeAsync(1200)
    expect(await pending).toEqual(new Map())
    expect(f.tabs.remove).not.toHaveBeenCalled()
  })

  it('does not open a protocol tab for an already-cancelled attempt', async () => {
    const f = fixture()
    const controller = new AbortController()
    controller.abort()
    expect(await f.service.wakeAndPoll(controller.signal)).toEqual([])
    expect(
      await f.service.wakeForReconnect(
        ['credential'],
        new Map([['credential', 'store']]),
        controller.signal
      )
    ).toEqual(new Map())
    expect(f.requests).toEqual([])
    expect(f.tabs.create).not.toHaveBeenCalled()
    expect(f.pins.get).not.toHaveBeenCalled()
  })

  it('rechecks cancellation after loading retained pins before launching', async () => {
    const controller = new AbortController()
    const f = fixture({
      pins: {
        get: vi.fn(async () => {
          controller.abort()
          return { port: 16803, instanceId: 'store' }
        }),
      },
    })
    expect(
      await f.service.wakeForReconnect(
        ['credential'],
        new Map([['credential', 'store']]),
        controller.signal
      )
    ).toEqual(new Map())
    expect(f.requests).toEqual([])
    expect(f.tabs.create).not.toHaveBeenCalled()
  })

  it('discards late discovery results when the caller cancels during a probe', async () => {
    const controller = new AbortController()
    const f = fixture({
      fetchImpl: vi.fn(async () => {
        controller.abort()
        return live('store')
      }),
    })
    expect(
      await f.service.wakeForReconnect(
        ['credential'],
        new Map([['credential', 'store']]),
        controller.signal
      )
    ).toEqual(new Map())
    expect(f.tabs.create).toHaveBeenCalledTimes(1)
    expect(f.tabs.remove).not.toHaveBeenCalled()
  })
})
