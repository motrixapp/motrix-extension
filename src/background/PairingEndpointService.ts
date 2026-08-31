import { BackendOperationCoordinator } from '@/background/BackendOperationCoordinator'
import type { ResolvedEndpointConfig } from '@/background/EndpointConfigStore'
import {
  type EndpointConfigStore,
  resolveActiveEndpoint,
  resolveEndpointById,
} from '@/background/EndpointConfigStore'
import {
  type BackendAuthority,
  createRemoteBackendAuthority,
  LOCAL_BACKEND_AUTHORITY,
} from '@/background/mbp1/backend-authority'
import { getClientInstallationId } from '@/background/mbp1/client-installation-id'
import type {
  CredentialStore,
  Principal,
} from '@/background/mbp1/credential-store'
import type { PinStore } from '@/background/mbp1/pin-store'
import { computeVerifiedOrigin } from '@/background/mbp1/verified-origin'

/**
 * What this service needs to answer "is this endpoint paired" and revoke it.
 * Every endpoint uses MBP1 credentials scoped by a factory-issued backend
 * authority; token-era storage is never consulted.
 */
export interface LocalPairingDeps {
  credentialStore: CredentialStore
  pinStore: PinStore
  browser: 'chromium' | 'firefox'
}

export interface PairingEndpointServiceOptions {
  coordinator?: BackendOperationCoordinator
  onActiveUnpair?: (
    authority: BackendAuthority,
    endpointId: string
  ) => void | Promise<void>
}

/** Convert a resolved catalogue snapshot into its credential authority. */
export function pairingAuthorityForEndpoint(
  endpoint: ResolvedEndpointConfig
): BackendAuthority {
  if (endpoint.mode === 'local') return LOCAL_BACKEND_AUTHORITY
  if (
    typeof endpoint.endpointId !== 'string' ||
    endpoint.endpointId.length === 0
  ) {
    throw new Error('remote endpoint is missing its stable id')
  }
  return createRemoteBackendAuthority({
    endpointId: endpoint.endpointId,
    wsBase: endpoint.remoteUrl,
  })
}

/**
 * Endpoint-explicit pairing operations used by runtime message handlers.
 * Resolving the id and mutating credentials happen against one immutable
 * snapshot, preventing an active-endpoint switch from redirecting an
 * operation to another backend while an Options request is in flight.
 */
export class PairingEndpointService {
  private readonly coordinator: BackendOperationCoordinator
  private readonly onActiveUnpair: (
    authority: BackendAuthority,
    endpointId: string
  ) => void | Promise<void>

  constructor(
    private readonly endpointConfigStore: EndpointConfigStore,
    private readonly local: LocalPairingDeps,
    options: PairingEndpointServiceOptions = {}
  ) {
    this.coordinator = options.coordinator ?? new BackendOperationCoordinator()
    this.onActiveUnpair = options.onActiveUnpair ?? (() => undefined)
  }

  /**
   * Pairing status is an authority-scoped MBP1 credential predicate for both
   * the App and configured Servers. A remote snapshot without its stable
   * catalogue id cannot define a credential authority and is rejected.
   */
  async getStatus(endpointId: string): Promise<{ paired: boolean }> {
    return this.coordinator.run(async () => {
      const { endpoint } = await this.resolve(endpointId)
      return { paired: await this.paired(endpoint) }
    })
  }

  /**
   * Answers "is the currently active endpoint paired" — the same predicate
   * as `getStatus`, resolved against `activeEndpointId` instead of a
   * caller-supplied one. This is the one place outside the options UI that
   * needs `paired`: the auto-takeover gate (`makeOps.isPaired`) and the
   * context-menu label both call this rather than re-deriving the check.
   */
  async isActivePaired(): Promise<boolean> {
    return this.coordinator.run(async () => {
      const config = await this.endpointConfigStore.get()
      return this.paired(resolveActiveEndpoint(config))
    })
  }

  private async paired(endpoint: ResolvedEndpointConfig): Promise<boolean> {
    const authority = pairingAuthorityForEndpoint(endpoint)
    return this.local.credentialStore.hasCommittedCredentialForAuthority(
      authority,
      await this.localPrincipal()
    )
  }

  /**
   * §12: "Expired or revoked credentials always require a fresh code-entry
   * pairing — never silent re-trust." Delete the current principal's MBP1
   * credentials within the endpoint authority. Local routing pins are hints
   * and are removed before the authoritative credential write; remote
   * authorities have no local-port pins.
   */
  async unpair(endpointId: string): Promise<{ active: boolean }> {
    return this.coordinator.run(async () => {
      const { endpoint, active } = await this.resolve(endpointId, true)
      const authority = pairingAuthorityForEndpoint(endpoint)
      const principal = await this.localPrincipal()
      if (endpoint.mode === 'local') {
        await this.local.credentialStore.revokePrincipalForAuthority(
          authority,
          principal,
          async (ids) => {
            for (const id of ids) {
              try {
                await this.local.pinStore.clear(id)
              } catch {
                // Pins are routing hints, never authentication authority.
              }
            }
          }
        )
      } else {
        await this.local.credentialStore.revokePrincipalForAuthority(
          authority,
          principal
        )
      }
      if (active) await this.onActiveUnpair(authority, endpointId)
      return { active }
    })
  }

  private async localPrincipal(): Promise<Principal> {
    return {
      browser: this.local.browser,
      verifiedOrigin: computeVerifiedOrigin(),
      clientInstallationId: await getClientInstallationId(),
    }
  }

  private async resolve(
    endpointId: string,
    forLifecycleMutation = false
  ): Promise<{
    endpoint: ResolvedEndpointConfig
    active: boolean
  }> {
    const config = forLifecycleMutation
      ? await this.endpointConfigStore.getForLifecycleMutation()
      : await this.endpointConfigStore.get()
    const endpoint = resolveEndpointById(config, endpointId)
    if (endpoint === null) throw new Error(`unknown endpoint: ${endpointId}`)
    return { endpoint, active: config.activeEndpointId === endpointId }
  }
}
