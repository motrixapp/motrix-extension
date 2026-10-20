import { describe, expect, it, vi } from 'vitest'
import {
  DiscoveryService,
  type NativeBootstrapReply,
} from '@/background/mbp1/discovery-service'

const bindingPub = new Uint8Array(32).fill(7)

function setup(reply: NativeBootstrapReply | Error, live = true) {
  const bootstrap = vi
    .fn()
    .mockRejectedValueOnce(new Error('host disconnected during app launch'))
  if (reply instanceof Error) bootstrap.mockRejectedValue(reply)
  else bootstrap.mockResolvedValue(reply)
  const fetchImpl = vi.fn(async () => {
    if (!live) throw new Error('connection refused')
    return Response.json({
      app: 'motrix-bridge',
      apiVersion: 1,
      instanceId: 'local-instance',
      appVersion: '2.0.0',
      runtime: 'electron',
      extensionPairing: { protocol: 'mbp1', versions: [1] },
      applicationProtocols: { mdxp: ['1.0'] },
    })
  })
  return {
    bootstrap,
    fetchImpl,
    service: new DiscoveryService({
      pins: { get: async () => null },
      nativeBootstrap: { bootstrap },
      candidatePorts: [16802],
      fetchImpl,
    }),
  }
}

describe('first-pair attestation after native launch failure', () => {
  it('recovers the native ticket and nonce once the launched app is reachable', async () => {
    const nmTicket = { callerId: 'motrix-extension@motrix.app', bindingPub }
    const { service, bootstrap, fetchImpl } = setup({
      port: 16802,
      nonce: 'fresh-native-nonce',
      nmTicket,
    })

    const [candidate] = await service.discoverForFirstPair({
      allowLaunch: true,
      bindingPub,
    })

    expect(candidate).toEqual({
      transport: 'nm',
      wsPort: 16802,
      nonce: 'fresh-native-nonce',
      nmTicket,
    })
    expect(candidate?.nmTicket).toBe(nmTicket)
    expect(bootstrap.mock.calls).toEqual([
      [{ allowLaunch: true, bindingPub }],
      [{ allowLaunch: false, bindingPub }],
    ])
    expect(bootstrap.mock.calls[1]?.[0].bindingPub).toBe(bindingPub)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['another failure', new Error('host still unavailable')],
    ['a different endpoint', { port: 16803, nonce: 'other', nmTicket: {} }],
  ])(
    'keeps the probe fallback after %s without retrying again',
    async (_name, reply) => {
      const { service, bootstrap } = setup(reply)
      const [candidate] = await service.discoverForFirstPair({
        allowLaunch: true,
        bindingPub,
      })
      expect(candidate).toMatchObject({ transport: 'probe', wsPort: 16802 })
      expect(candidate).not.toHaveProperty('nmTicket')
      expect(candidate).not.toHaveProperty('nonce')
      expect(bootstrap).toHaveBeenCalledTimes(2)
    }
  )

  it.each([
    ['no live app', true, bindingPub, false],
    ['a background probe', false, bindingPub, true],
    ['candidate enumeration', true, undefined, true],
  ])('does not retry for %s', async (_name, allowLaunch, pub, live) => {
    const { service, bootstrap } = setup(new Error('unavailable'), live)
    await service.discoverForFirstPair({ allowLaunch, bindingPub: pub })
    expect(bootstrap).toHaveBeenCalledTimes(1)
  })

  it('preserves a deliberate ticketless native reply without retrying', async () => {
    const { service, bootstrap, fetchImpl } = setup(new Error('unused'))
    bootstrap.mockReset().mockResolvedValue({ port: 16802, nonce: 'n' })
    expect(
      await service.discoverForFirstPair({ allowLaunch: true, bindingPub })
    ).toEqual([{ transport: 'nm', wsPort: 16802, nonce: 'n' }])
    expect(bootstrap).toHaveBeenCalledTimes(1)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
