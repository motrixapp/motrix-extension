/**
 * Native Messaging bootstrap. Connects to the Motrix native host shim,
 * which reads endpoint.json (or launches Motrix if needed) and reports
 * back the local WebSocket port plus a one-shot pairing nonce. The NM
 * channel exists only for this handoff — once we know port + nonce, we
 * disconnect and use WebSocket for all subsequent traffic.
 *
 * Wire shape (local native-host contract), now one of two request shapes the host's
 * `parse_host_request` accepts side by side (`packages/native-host/src/lib.rs`):
 *
 *   { action: 'start', allowLaunch }                                  (v1, legacy)
 *   { action: 'bootstrap', protocolVersion: 1, bindingPub, allowLaunch } (§9.1)
 *
 * Both replies look like:
 *   { action: 'requestPair', protocolVersion: <int>, port: <number>,
 *     nonce: <string | null>, nmTicket?: <object> }
 *
 * The host serializes `protocolVersion` on *every* `requestPair` reply
 * regardless of which request shape triggered it
 * (`ResolveResult::request_pair`/`request_pair_with_ticket` in
 * `packages/native-host/src/resolve.rs`), and omits `nmTicket` entirely
 * rather than sending it `null` — a ticket is only ever minted for a
 * `bootstrap` request whose caller identity and `endpoint.json` inputs are
 * all trusted (§9.1/§9.2), so a `start` request never gets one.
 *
 * `nonce` is null if the host failed to fetch a fresh nonce from
 * /nonce. Bootstrap still surfaces the port — the caller (ConnectionManager)
 * decides whether to attempt /pair (needs a non-null nonce) or an
 * authenticated MBP1 reconnect (uses a stored credential).
 */

import { log } from '@/background/log'
import { buildBootstrapRequest } from '@/background/mbp1/ticket-bootstrap'
import { hasNativeMessagingSupport } from '@/shared/platformCapabilities'

export interface NativeBootstrapResult {
  wsPort: number
  /** One-shot pair nonce from /nonce. `null` if host fetch failed. */
  nonce: string | null
  /** The §9.1 attestation ticket, opaque here — the server validates it (§9.2). */
  nmTicket: unknown | null
  /** The native host's own protocol version for this reply (see module doc). */
  protocolVersion: number
}

export interface NativeBootstrapOptions {
  hostName?: string
  timeoutMs?: number
}

/** Raw length of the §9.1 binding public key `bindingPub` must decode to. */
const BINDING_PUB_BYTES = 32

export interface DiscoverOptions {
  allowLaunch?: boolean
  /**
   * The §9.1 ephemeral binding public key (32 raw bytes), forwarded to
   * `buildBootstrapRequest` (`mbp1/ticket-bootstrap.ts`) unchanged — this
   * module never derives or interprets it, only checks its length.
   *
   * Optional for backward-compatible direct callers. Production first-pair
   * attempts generate a fresh keypair in `ConnectionManager` and always pass
   * its public half here. Omitting it sends the legacy `{action:'start'}`
   * request, which remains useful only as a ticketless compatibility path.
   */
  bindingPub?: Uint8Array
}

export class NativeBootstrapError extends Error {
  public readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'NativeBootstrapError'
    this.code = code
  }
}

// Must match the `name` field Motrix's NativeMessagingInstaller
// writes into the chrome NM manifest. The Plan 03a docs originally
// quoted `app.motrix.bridge`, but the actual installer uses
// `app.motrix.bridge` — verified in Motrix at
// src/main/bridge/NativeMessagingInstaller.ts (MANIFEST_HOST_NAME).
const DEFAULT_HOST_NAME = 'app.motrix.bridge'
const DEFAULT_TIMEOUT_MS = 20_000 // must exceed native host's 15s launch poll
const MAX_NONCE_LENGTH = 512

interface NMPort {
  postMessage(msg: unknown): void
  disconnect(): void
  onMessage: { addListener(fn: (m: unknown) => void): void }
  onDisconnect: { addListener(fn: () => void): void }
}

export class NativeBootstrap {
  private readonly opts: NativeBootstrapOptions
  constructor(opts: NativeBootstrapOptions = {}) {
    this.opts = opts
  }

  async discover(opts: DiscoverOptions = {}): Promise<NativeBootstrapResult> {
    const hostName = this.opts.hostName ?? DEFAULT_HOST_NAME
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const allowLaunch = opts.allowLaunch === true

    // Checked before ever touching Native Messaging: the host's answer to a
    // wrong-length `bindingPub` is silence (parse_host_request returns None
    // and the process exits without a reply), which is indistinguishable
    // from "Motrix is not installed" — a diagnosis this project protects
    // deliberately. Fail with something diagnosable instead.
    if (
      opts.bindingPub !== undefined &&
      opts.bindingPub.length !== BINDING_PUB_BYTES
    ) {
      throw new NativeBootstrapError(
        `bindingPub must be exactly ${BINDING_PUB_BYTES} bytes, got ${opts.bindingPub.length}`,
        'invalid-binding-pub'
      )
    }

    if (!hasNativeMessagingSupport()) {
      throw new NativeBootstrapError(
        'Native Messaging is unavailable on this browser; configure a Motrix Server instead',
        'unsupported'
      )
    }

    // DEBUG: spawns a fresh native host process (which may relaunch
    // Motrix). TODO(remove-after-rootcause).
    log.info(`[NM] connectNative(${hostName}) allowLaunch=${allowLaunch}`)
    const port = browser.runtime.connectNative(hostName) as unknown as NMPort

    return new Promise<NativeBootstrapResult>((resolve, reject) => {
      let settled = false
      const settle = (action: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          port.disconnect()
        } catch {
          // best-effort; host may already be gone
        }
        action()
      }

      const timer = setTimeout(() => {
        settle(() =>
          reject(new NativeBootstrapError('NM bootstrap timeout', 'timeout'))
        )
      }, timeoutMs)

      port.onMessage.addListener((rawMsg: unknown) => {
        const msg = rawMsg as {
          action?: string
          port?: unknown
          nonce?: unknown
          protocolVersion?: unknown
          nmTicket?: unknown
          error?: unknown
        }
        log.info(
          `[NM] recv action=${msg.action ?? 'none'} ` +
            `port=${typeof msg.port === 'number' ? msg.port : 'none'} ` +
            `error=${msg.error !== undefined ? String(msg.error) : 'none'}`
        )
        if (msg.error !== undefined) {
          settle(() =>
            reject(
              new NativeBootstrapError(
                String(msg.error),
                `host-error:${String(msg.error)}`
              )
            )
          )
          return
        }
        const validPort =
          typeof msg.port === 'number' &&
          Number.isInteger(msg.port) &&
          msg.port >= 1 &&
          msg.port <= 65_535
        const validNonce =
          msg.nonce === undefined ||
          msg.nonce === null ||
          (typeof msg.nonce === 'string' &&
            msg.nonce.length > 0 &&
            msg.nonce.length <= MAX_NONCE_LENGTH)
        // Every requestPair reply carries protocolVersion, regardless of
        // which request shape triggered it (see module doc) — this is not
        // gated on the request having been a `bootstrap`.
        const validProtocolVersion =
          typeof msg.protocolVersion === 'number' &&
          Number.isInteger(msg.protocolVersion) &&
          msg.protocolVersion >= 0
        // `nmTicket` is opaque here — §9.2 verification is the server's job,
        // and pre-screening its interior here could only downgrade a good
        // ticket's outcome (§5), never improve it. Only the *shape* the host
        // can produce is checked: an object when a ticket was minted,
        // entirely absent otherwise (never `null` on the wire, but accepted
        // leniently the same way `nonce` is above).
        const validNmTicket =
          msg.nmTicket === undefined ||
          msg.nmTicket === null ||
          (typeof msg.nmTicket === 'object' && !Array.isArray(msg.nmTicket))
        if (
          msg.action === 'requestPair' &&
          validPort &&
          validNonce &&
          validProtocolVersion &&
          validNmTicket
        ) {
          const nonce = typeof msg.nonce === 'string' ? msg.nonce : null
          const nmTicket =
            msg.nmTicket === undefined || msg.nmTicket === null
              ? null
              : msg.nmTicket
          settle(() =>
            resolve({
              wsPort: msg.port as number,
              nonce,
              nmTicket,
              protocolVersion: msg.protocolVersion as number,
            })
          )
          return
        }
        settle(() =>
          reject(new NativeBootstrapError('malformed NM response', 'malformed'))
        )
      })

      port.onDisconnect.addListener(() => {
        const lastErr = browser.runtime.lastError?.message
        log.info(`[NM] onDisconnect lastError=${lastErr ?? 'none'}`)
        settle(() =>
          reject(
            new NativeBootstrapError(
              `NM host disconnected${lastErr ? `: ${lastErr}` : ''}`,
              'disconnect'
            )
          )
        )
      })

      const request =
        opts.bindingPub === undefined
          ? { action: 'start' as const, allowLaunch }
          : buildBootstrapRequest(opts.bindingPub, allowLaunch)

      try {
        port.postMessage(request)
      } catch (error) {
        settle(() =>
          reject(
            new NativeBootstrapError(
              `NM start failed: ${(error as Error).message ?? String(error)}`,
              'disconnect'
            )
          )
        )
      }
    })
  }
}
