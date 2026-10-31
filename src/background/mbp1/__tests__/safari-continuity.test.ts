import { ed25519 } from '@noble/curves/ed25519.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRemoteBackendAuthority } from '@/background/mbp1/backend-authority'
import {
  b64uDecode,
  b64uEncode,
  concatBytes,
  enc,
} from '@/background/mbp1/canonical'
import {
  CredentialStore,
  type Principal,
  principalKey,
  type StoredCredential,
} from '@/background/mbp1/credential-store'
import type { FrameChannel } from '@/background/mbp1/frames'
import { PinStore } from '@/background/mbp1/pin-store'
import { ReconnectFlow } from '@/background/mbp1/reconnect-flow'
import {
  reconnectMacs,
  reconnectTranscript,
} from '@/background/mbp1/reconnect-mac'
import { getSafariInstallationKey } from '@/background/mbp1/safari-installation'
import { extensionBrowser as browser } from '@/shared/browser'

const originA = 'safari-web-extension://41cf2a73-eb74-4f1d-a74b-da20e9f24d8b'
const originB = 'safari-web-extension://dc0ebd48-d655-4c58-baca-87b4960e6534'
const principal: Principal = {
  browser: 'safari',
  verifiedOrigin: originA,
  clientInstallationId: 'profile-a',
}
const changed = { ...principal, verifiedOrigin: originB }
const mutualKey = new Uint8Array(32).fill(42)
const instanceId = 'server-instance'
let backing: Record<string, unknown>

beforeEach(() => {
  backing = {}
  browser.storage.local.get = vi.fn(async (keys) =>
    Object.fromEntries(
      (typeof keys === 'string' ? [keys] : Object.keys(backing))
        .filter((key) => key in backing)
        .map((key) => [key, backing[key]])
    )
  )
  browser.storage.local.set = vi.fn(async (values) => {
    Object.assign(backing, structuredClone(values))
  })
  browser.storage.local.remove = vi.fn(async (keys) => {
    for (const key of typeof keys === 'string' ? [keys] : keys)
      delete backing[key]
  })
})

function legacy(
  credentialId: string,
  origin: string,
  installation = 'profile-a',
  createdAt = 1
): StoredCredential {
  return {
    credentialId,
    mutualKey: b64uEncode(mutualKey),
    principalKey: b64uEncode(
      concatBytes(enc('safari'), enc(origin), enc(installation))
    ),
    state: 'committed',
    createdAt,
  }
}

function seed(...credentials: StoredCredential[]): void {
  backing['motrix.mbp1.credentials'] = {
    version: 1,
    credentials,
    activeCredentialId: credentials[0]?.credentialId ?? null,
  }
}

describe('Safari persistent installation credentials', () => {
  it('recovers old origin-bound credentials without changing installation or backend ownership', async () => {
    seed(
      legacy('a', originA),
      legacy('b', originB, 'profile-a', 2),
      legacy('other-profile', originA, 'profile-b')
    )
    const store = new CredentialStore()
    expect(
      (await store.recoverOrder(changed)).map((row) => row.credentialId)
    ).toEqual(['a', 'b'])
    expect(await store.hasCommittedCredential(changed)).toBe(true)
    const other = store.forAuthorityForTest(
      createRemoteBackendAuthority({
        endpointId: 'remote',
        wsBase: 'wss://remote.example',
      })
    )
    expect(await other.recoverOrder(changed)).toEqual([])
    expect(principalKey(principal)).toBe(principalKey(changed))
    expect(
      principalKey({ ...principal, clientInstallationId: 'profile-b' })
    ).not.toBe(principalKey(principal))
  })

  it('persists a single random signing identity across fresh readers and concurrent requests', async () => {
    const keys = await Promise.all(
      Array.from({ length: 8 }, () => getSafariInstallationKey())
    )
    expect(new Set(keys.map((key) => key.publicKey)).size).toBe(1)
    const next = await getSafariInstallationKey()
    expect(next.publicKey).toBe(keys[0]?.publicKey)
    expect(browser.storage.local.set).toHaveBeenCalledTimes(1)
    for (const key of [...keys, next]) key.privateKey.fill(0)
  })

  it('does not silently replace a corrupt stored signing identity', async () => {
    backing['motrix.mbp1.safariInstallationKey'] = {
      version: 1,
      privateKey: 'corrupt',
    }
    await expect(getSafariInstallationKey()).rejects.toThrow('unavailable')
    expect(browser.storage.local.set).not.toHaveBeenCalled()
  })

  it('retains remote legacy rows for explicit revocation but permits a fresh pair after the origin changes', async () => {
    const root = new CredentialStore()
    const remote = root.forAuthorityForTest(
      createRemoteBackendAuthority({
        endpointId: 'remote',
        wsBase: 'wss://remote.example',
      })
    )
    await remote.writeProvisionalUnacked(
      principal,
      { credentialId: 'legacy', mutualKey: b64uEncode(mutualKey) },
      instanceId
    )
    await remote.commitAndActivate('legacy', principal, instanceId)
    expect(await remote.recoverOrder(changed)).toEqual([])
    expect(
      (await remote.recoverOrder(principal)).map((c) => c.credentialId)
    ).toEqual(['legacy'])
    expect(await remote.revokeAll(changed)).toEqual(['legacy'])
  })

  it('verifies the server before enrolling a key or pruning stale local credentials', async () => {
    seed(
      legacy('active', originA),
      legacy('stale', originB),
      legacy('other-profile', originA, 'profile-b')
    )
    const store = new CredentialStore()
    const candidate = (await store.recoverOrder(changed))[0] as StoredCredential
    const installation = await getSafariInstallationKey()
    installation.privateKey.fill(0)
    const s = new Uint8Array(32).fill(3)
    let sent: Record<string, unknown> | undefined
    let reads = 0
    let validServer = false
    const channel: FrameChannel = {
      open: async () => {},
      close: () => {},
      sendText: async (frame) => {
        sent = frame as Record<string, unknown>
      },
      sendBinary: async () => {
        throw new Error('Unexpected binary')
      },
      receiveBinary: async () => {
        throw new Error('Unexpected binary')
      },
      receiveText: async () => {
        if (reads++ === 0)
          return JSON.stringify({
            type: 'reconnectChallenge',
            protocolVersion: 1,
            S: b64uEncode(s),
          })
        if (!sent) throw new Error('Missing response')
        const resume = sent.safariResume as {
          installationKey: string
          proof: string
        }
        const c = b64uDecode(sent.C as string)
        // Independent peer composition: every live-origin and installation byte is authenticated.
        const rt = concatBytes(
          reconnectTranscript({
            protocolVersion: 1,
            credentialId: candidate.credentialId,
            browser: 'safari',
            verifiedOrigin: originB,
            instanceId,
          }),
          enc('MBP1/safari-resume/v1'),
          enc(b64uDecode(resume.installationKey)),
          enc(new Uint8Array())
        )
        const macs = reconnectMacs(mutualKey, s, c, rt)
        expect(sent.mac).toBe(b64uEncode(macs.client))
        expect(
          ed25519.verify(
            b64uDecode(resume.proof),
            concatBytes(enc('MBP1/safari-resume-proof/v1'), s, c, rt),
            b64uDecode(resume.installationKey),
            { zip215: false }
          )
        ).toBe(true)
        return JSON.stringify({
          type: 'reconnectAccept',
          mac: b64uEncode(validServer ? macs.server : new Uint8Array(32)),
        })
      },
    }
    const flow = new ReconnectFlow({
      channel,
      creds: store,
      pins: new PinStore(),
      isCurrent: () => true,
    })
    const args = {
      credential: candidate,
      discovery: {
        transport: 'probe' as const,
        wsPort: 16802,
        safariContinuity: true,
      },
      principal: changed,
      instanceId,
    }
    await expect(flow.run(args)).rejects.toMatchObject({
      reason: 'serverMacMismatch',
    })
    expect(await store.recoverOrder(changed)).toHaveLength(2)
    expect(
      (await store.recoverOrder(changed))[0]?.safariInstallationKey
    ).toBeUndefined()
    reads = 0
    validServer = true
    await flow.run(args)
    const recovered = await new CredentialStore().recoverOrder({
      ...changed,
      verifiedOrigin: originA,
    })
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({
      credentialId: 'active',
      safariInstallationKey: installation.publicKey,
    })
    expect(
      await store.recoverOrder({
        ...principal,
        clientInstallationId: 'profile-b',
      })
    ).toHaveLength(1)
  })
})
