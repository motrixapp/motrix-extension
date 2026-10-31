import { ed25519 } from '@noble/curves/ed25519.js'
import {
  b64uDecode,
  b64uEncode,
  concatBytes,
  enc,
} from '@/background/mbp1/canonical'
import { parseNmTicket } from '@/background/mbp1/frames'
import { createOperationQueue } from '@/background/mbp1/operation-queue'
import { ticketDigest } from '@/background/mbp1/transcript'
import { extensionBrowser as browser } from '@/shared/browser'

const STORAGE_KEY = 'motrix.mbp1.safariInstallationKey'
const enqueue = createOperationQueue()

/** Random, installation-local signing key. Never sent to a native host. */
export async function getSafariInstallationKey(): Promise<{
  publicKey: string
  privateKey: Uint8Array
}> {
  return enqueue(async () => {
    const data = await browser.storage.local.get(STORAGE_KEY)
    const existing = data[STORAGE_KEY]
    if (existing === undefined) {
      const privateKey = ed25519.utils.randomSecretKey()
      await browser.storage.local.set({
        [STORAGE_KEY]: { version: 1, privateKey: b64uEncode(privateKey) },
      })
      privateKey.fill(0)
    }
    const saved = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as
      | { version?: unknown; privateKey?: unknown }
      | undefined
    try {
      if (saved?.version !== 1 || typeof saved.privateKey !== 'string')
        throw new Error()
      const privateKey = b64uDecode(saved.privateKey)
      if (privateKey.length !== 32) throw new Error()
      return {
        privateKey,
        publicKey: b64uEncode(ed25519.getPublicKey(privateKey)),
      }
    } catch {
      // Do not replace a corrupt identity: existing authorizations still bind it.
      throw new Error('Safari installation identity is unavailable')
    }
  })
}

export function bindSafariResume(
  rt: Uint8Array,
  publicKey: string,
  nmTicket?: unknown
): Uint8Array {
  return concatBytes(
    rt,
    enc('MBP1/safari-resume/v1'),
    enc(b64uDecode(publicKey)),
    enc(
      nmTicket === undefined
        ? new Uint8Array()
        : ticketDigest(parseNmTicket(nmTicket))
    )
  )
}

export function safariResumeProofInput(
  s: Uint8Array,
  c: Uint8Array,
  rt: Uint8Array
): Uint8Array {
  return concatBytes(enc('MBP1/safari-resume-proof/v1'), s, c, rt)
}

export function signSafariResume(
  privateKey: Uint8Array,
  s: Uint8Array,
  c: Uint8Array,
  rt: Uint8Array
): string {
  return b64uEncode(ed25519.sign(safariResumeProofInput(s, c, rt), privateKey))
}
