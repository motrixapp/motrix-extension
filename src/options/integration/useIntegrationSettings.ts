import type * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ConnectionState,
  ServerIdentity,
} from '@/background/ConnectionManager'
import {
  type EndpointConfig,
  LOCAL_ENDPOINT_ID,
  type MotrixServerEndpoint,
} from '@/background/EndpointConfigStore'
import { send } from '@/background/MessageBus'
import type {
  RemoteBackendPolicyReplacement,
  RemoteBackendPolicyV1,
} from '@/background/RemoteBackendPolicyStore'
import { assertMessageSucceeded } from '@/options/integration/messages'
import type { ServerFormValues } from '@/options/tabs/schemas'
import { normalizeRemoteEndpoint } from '@/shared/endpoint'

/** Keeps catalog mutations, connection refreshes and recovery in one place. */
export function useIntegrationSettings() {
  const { t } = useTranslation()
  const [config, setConfig] = useState<EndpointConfig | null>(null)
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('disconnected')
  const [serverIdentity, setServerIdentity] = useState<ServerIdentity | null>(
    null
  )
  const [pairing, setPairing] = useState<{
    endpointId: string
    paired: boolean
  } | null>(null)
  const [pairingLoading, setPairingLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [remotePolicyBusy, setRemotePolicyBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [snapshotUnavailable, setSnapshotUnavailable] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingServer, setEditingServer] =
    useState<MotrixServerEndpoint | null>(null)
  const [serverToDelete, setServerToDelete] =
    useState<MotrixServerEndpoint | null>(null)
  const [remotePolicy, setRemotePolicy] =
    useState<RemoteBackendPolicyV1 | null>(null)

  const snapshotRevision = useRef(0)
  const activeActions = useRef(0)
  const mounted = useRef(true)

  const refreshConnection = useCallback(async (): Promise<void> => {
    const revision = ++snapshotRevision.current
    try {
      // Endpoint, pairing and transport state are one background-owned snapshot.
      // Separate reads can attach a new connection to the previously selected row.
      const response = await send('bg.getState', undefined)
      assertMessageSucceeded(response)
      if (!response.endpoint)
        throw new Error('integration snapshot unavailable')
      if (!mounted.current || revision !== snapshotRevision.current) return
      setSnapshotUnavailable(false)
      setConfig(response.endpoint)
      setConnectionState(response.state)
      setServerIdentity(response.server ?? null)
      setPairing({
        endpointId: response.endpoint.activeEndpointId,
        paired: response.pairing === 'stored',
      })
      setPairingLoading(response.pairing === 'loading')
    } catch (cause) {
      if (!mounted.current || revision !== snapshotRevision.current) return
      throw cause
    }
  }, [])

  const activeEndpointId = config?.activeEndpointId ?? LOCAL_ENDPOINT_ID
  const activeServer =
    config?.servers.find((server) => server.id === activeEndpointId) ?? null
  const paired =
    pairing?.endpointId === activeEndpointId ? pairing.paired : false
  const isRemote = activeEndpointId !== LOCAL_ENDPOINT_ID

  useEffect(() => {
    mounted.current = true
    let inFlight = false
    const syncConnection = async (): Promise<void> => {
      if (document.hidden || inFlight || activeActions.current > 0) return
      inFlight = true
      try {
        await refreshConnection()
      } catch {
        // An unavailable background page is not proof that a credential was
        // revoked, but the settings page must not keep claiming it is connected.
        setConnectionState('disconnected')
        setServerIdentity(null)
        setRemotePolicy(null)
        setPairingLoading(false)
        setSnapshotUnavailable(true)
      } finally {
        inFlight = false
      }
    }
    const wake = () => void syncConnection()
    // Terminal states can change without an action in this page (NAS restart,
    // revocation, another popup). Keep reconciling while visible; never connect.
    window.addEventListener('focus', wake)
    document.addEventListener('visibilitychange', wake)
    void syncConnection()
    const timer = window.setInterval(wake, 1_000)
    return () => {
      mounted.current = false
      snapshotRevision.current += 1
      window.clearInterval(timer)
      window.removeEventListener('focus', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [refreshConnection])

  useEffect(() => {
    let cancelled = false
    if (!isRemote || !paired) {
      setRemotePolicy(null)
      return () => {
        cancelled = true
      }
    }
    if (connectionState !== 'connected') {
      return () => {
        cancelled = true
      }
    }
    void send('bg.getRemoteBackendPolicy', undefined)
      .then((response) => {
        if (cancelled) return
        assertMessageSucceeded(response)
        setRemotePolicy(response.policy)
      })
      .catch(() => {
        if (!cancelled) setRemotePolicy(null)
      })
    return () => {
      cancelled = true
    }
  }, [connectionState, isRemote, paired])

  const runAction = async (
    action: () => Promise<void>,
    rethrow = false,
    setPending: React.Dispatch<React.SetStateAction<boolean>> = setBusy
  ): Promise<void> => {
    activeActions.current += 1
    snapshotRevision.current += 1
    setPending(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError((cause as Error).message)
      try {
        const latest = await send('bg.getEndpointConfig', undefined)
        assertMessageSucceeded(latest)
        setConfig(latest)
        setPairing(null)
        await refreshConnection()
      } catch {
        // Preserve the original operation error. A subsequent user action or
        // page reload will retry the catalogue read if this refresh also fails.
      }
      if (rethrow) throw cause
    } finally {
      activeActions.current -= 1
      setPending(false)
    }
  }

  const handleEndpointChange = async (
    endpointId: string,
    rethrow = false
  ): Promise<void> => {
    if (config === null || endpointId === config.activeEndpointId) return
    await runAction(async () => {
      const activated = await send('bg.activateEndpoint', { endpointId })
      assertMessageSucceeded(activated)
      setConfig(activated.config)
      setPairing(null)
      setRemotePolicy(null)
      setConnectionState('bootstrapping')
      setServerIdentity(null)
      await refreshConnection()
    }, rethrow)
  }

  const handleReconnect = async (): Promise<void> => {
    await runAction(async () => {
      const response = await send('bg.reconnect', undefined)
      assertMessageSucceeded(response)
      await refreshConnection()
    })
  }

  const handleForget = async (): Promise<void> => {
    await runAction(async () => {
      const response = await send('bg.unpair', {
        endpointId: activeEndpointId,
      })
      assertMessageSucceeded(response)
      await refreshConnection()
    })
  }

  const replaceRemotePolicy = async (
    replacement: RemoteBackendPolicyReplacement
  ): Promise<void> => {
    await runAction(
      async () => {
        const response = await send(
          'bg.replaceRemoteBackendPolicy',
          replacement
        )
        assertMessageSucceeded(response)
        setRemotePolicy(response.policy)
        // replaceRemoteBackendPolicy acknowledges only after its one
        // renegotiation attempt reaches a terminal state. Read that state
        // instead of leaving the page on a synthetic `bootstrapping` snapshot.
        await refreshConnection()
      },
      false,
      setRemotePolicyBusy
    )
  }

  const openAddServer = (): void => {
    setEditingServer(null)
    setEditorOpen(true)
  }

  const openEditServer = (server: MotrixServerEndpoint): void => {
    setEditingServer(server)
    setEditorOpen(true)
  }

  const handleSaveServer = async (
    values: ServerFormValues,
    pairAfterSave = false
  ): Promise<void> => {
    if (config === null) return
    await runAction(async () => {
      const normalizedUrl = normalizeRemoteEndpoint(values.url)
      const duplicate = config.servers.some(
        (server) =>
          server.id !== editingServer?.id && server.url === normalizedUrl
      )
      if (duplicate) throw new Error(t('options.servers.urlDuplicate'))

      const name = values.name.trim()
      const result =
        editingServer === null
          ? await send('bg.addServer', { name, url: normalizedUrl })
          : await send('bg.updateServer', {
              endpointId: editingServer.id,
              expected: {
                name: editingServer.name,
                url: editingServer.url,
                revision: editingServer.revision,
              },
              changes: { name, url: normalizedUrl },
            })
      assertMessageSucceeded(result)
      if (pairAfterSave) setEditingServer(result.server)
      const nextConfig = pairAfterSave
        ? (
            await send('bg.activateEndpoint', {
              endpointId: result.server.id,
            })
          ).config
        : result.config
      setConfig(nextConfig)
      setPairing(null)
      await refreshConnection()
    }, true)
  }

  const handleDeleteServer = async (): Promise<void> => {
    if (config === null || serverToDelete === null) return
    const deleting = serverToDelete
    await runAction(async () => {
      const removed = await send('bg.removeServer', {
        endpointId: deleting.id,
        expected: {
          name: deleting.name,
          url: deleting.url,
          revision: deleting.revision,
        },
      })
      assertMessageSucceeded(removed)
      setConfig(removed.config)
      setServerToDelete(null)
      if (removed.wasActive) {
        setPairing(null)
        setConnectionState('disconnected')
        await refreshConnection()
      }
    })
  }

  const refreshAfterPairing = (): void => {
    void refreshConnection().catch(() => undefined)
  }

  return {
    config,
    connectionState,
    serverIdentity,
    activeEndpointId,
    activeServer,
    isRemote,
    paired,
    pairingLoading,
    busy,
    remotePolicyBusy,
    remotePolicy,
    error:
      error ??
      (snapshotUnavailable ? t('popup.integration.connectionFailed') : null),
    editorOpen,
    setEditorOpen,
    editingServer,
    serverToDelete,
    setServerToDelete,
    openAddServer,
    openEditServer,
    handleEndpointChange,
    handleReconnect,
    handleForget,
    replaceRemotePolicy,
    handleSaveServer,
    handleDeleteServer,
    refreshAfterPairing,
  }
}
