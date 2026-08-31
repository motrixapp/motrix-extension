import { useEffect, useRef, useState } from 'react'
import type { ConnectionState } from '@/background/ConnectionManager'
import {
  type EndpointConfig,
  LOCAL_ENDPOINT_ID,
  type MotrixServerEndpoint,
} from '@/background/EndpointConfigStore'
import { send } from '@/background/MessageBus'
import { isErrorResponse } from '@/shared/messages'

export { LOCAL_ENDPOINT_ID }
export type PopupServerEndpoint = MotrixServerEndpoint
export type PopupEndpoint = EndpointConfig

export interface PopupState {
  loading: boolean
  connection: ConnectionState | null
  lastError: string | null
  /** Stable failure code from bg.getState. The UI renders locale copy keyed
   *  by this (`errorCopy.ts`); `lastError` stays developer-facing. */
  lastErrorReason: string | null
  endpoint: PopupEndpoint | null
  server: {
    name: string
    version: string
    runtime: 'electron' | 'server'
  } | null
  /** §7.3 first-pair backoff, straight from bg.getState — `retryAtMs` is
   *  always the client's own `FirstPairBackoff` value, never anything the
   *  peer reported. `null` when no backoff is currently active. */
  backoff: { retryAtMs: number } | null
  /** `true` exactly when the last attempt was an unattended one whose
   *  recovery order was exhausted — straight from `bg.getState`, see that
   *  message's own doc. Drives its own presentable copy in
   *  `ConnectionStatusPanel` instead of the raw `lastError` sentence. */
  recoveryExhaustedUnattended: boolean
  /** `true` exactly when this session's pairing completed with no
   *  native-host attestation ticket. Not a warning about Motrix's
   *  authenticity — the pairing was still mutually authenticated by the
   *  code; what's missing is corroboration of *which* Motrix answered. */
  degraded: boolean
  capabilities: {
    taskReveal: boolean
  }
  /** Present exactly while a first-pair `PairingCodeProvider` call is
   *  outstanding, straight from `bg.getState` — see that message's own doc.
   *  A pairing started anywhere (the options "Pair" dialog, or any future
   *  entry point) is answerable from here, not just from whatever surface
   *  started it. */
  pairingCode: {
    run: number
    maxRuns: number
    attemptsRemaining: number | null
    deadlineMs: number
  } | null
}

export function usePopupState(): {
  state: PopupState
  switching: boolean
  reconnect: () => Promise<void>
  switchEndpoint: (endpointId: string) => Promise<void>
  submitPairingCode: (code: string) => Promise<void>
} {
  const [state, setState] = useState<PopupState>({
    loading: true,
    connection: null,
    lastError: null,
    lastErrorReason: null,
    endpoint: null,
    server: null,
    backoff: null,
    recoveryExhaustedUnattended: false,
    degraded: false,
    capabilities: { taskReveal: false },
    pairingCode: null,
  })
  const [switching, setSwitching] = useState(false)
  const stateVersionRef = useRef(0)
  const switchingRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    void send('bg.clearBadgeError', undefined)
    const tick = async (): Promise<void> => {
      if (switchingRef.current) return
      const requestVersion = stateVersionRef.current
      try {
        const [connection, endpoint] = await Promise.all([
          send('bg.getState', undefined),
          send('bg.getEndpointConfig', undefined),
        ])
        if (isErrorResponse(connection)) throw new Error(connection.error)
        if (isErrorResponse(endpoint)) throw new Error(endpoint.error)
        if (
          cancelled ||
          switchingRef.current ||
          requestVersion !== stateVersionRef.current
        ) {
          return
        }
        setState({
          loading: false,
          connection: connection.state,
          lastError: connection.lastError ?? null,
          lastErrorReason: connection.lastErrorReason ?? null,
          endpoint,
          server: connection.server ?? null,
          backoff: connection.backoff ?? null,
          recoveryExhaustedUnattended:
            connection.recoveryExhaustedUnattended ?? false,
          degraded: connection.degraded ?? false,
          capabilities: {
            taskReveal: connection.capabilities?.taskReveal === true,
          },
          pairingCode: connection.pairingCode ?? null,
        })
      } catch (error) {
        if (
          cancelled ||
          switchingRef.current ||
          requestVersion !== stateVersionRef.current
        ) {
          return
        }
        setState((current) => ({
          ...current,
          loading: false,
          connection: 'disconnected',
          lastError: (error as Error).message,
          // A round-trip failure carries no reason code; clearing the stale
          // one keeps the alert on generic copy instead of the previous
          // error's sentence.
          lastErrorReason: null,
          server: null,
          capabilities: { taskReveal: false },
          // A genuine new error (a `bg.getState` round-trip failure) always
          // supersedes a stale flag from whatever the last successful poll
          // reported.
          recoveryExhaustedUnattended: false,
        }))
      }
    }
    void tick()
    const t = setInterval(() => void tick(), 1000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  const reconnect = async (): Promise<void> => {
    const response = await send('bg.reconnect', undefined)
    if (isErrorResponse(response)) throw new Error(response.error)
  }

  const submitPairingCode = async (code: string): Promise<void> => {
    const response = await send('bg.submitPairingCode', { code })
    if (isErrorResponse(response)) throw new Error(response.error)
    if (!response.ok) {
      throw new Error(response.error ?? 'no pairing code request is pending')
    }
  }

  const switchEndpoint = async (endpointId: string): Promise<void> => {
    const currentEndpoint = state.endpoint
    if (!currentEndpoint || currentEndpoint.activeEndpointId === endpointId) {
      return
    }
    if (
      endpointId !== LOCAL_ENDPOINT_ID &&
      !currentEndpoint.servers.some((server) => server.id === endpointId)
    ) {
      throw new Error('Motrix Server is not configured')
    }

    switchingRef.current = true
    stateVersionRef.current += 1
    setSwitching(true)
    try {
      const activated = await send('bg.activateEndpoint', { endpointId })
      if (isErrorResponse(activated)) throw new Error(activated.error)
      setState((current) => ({
        ...current,
        connection: 'connecting',
        endpoint: activated.config,
        lastError: null,
        lastErrorReason: null,
        server: null,
        capabilities: { taskReveal: false },
      }))
    } finally {
      switchingRef.current = false
      setSwitching(false)
    }
  }

  return { state, switching, reconnect, switchEndpoint, submitPairingCode }
}
