import '@/styles/globals.css'
import { createRoot } from 'react-dom/client'

type PreviewEndpoint = {
  version: 3
  activeEndpointId: string
  servers: Array<{
    id: string
    name: string
    url: string
    revision: number
    state: 'ready' | 'cleanup-pending'
  }>
  cleanupTombstones: Array<{
    endpointId: string
    canonicalWsBase: string
    invalidatedRevision: number
  }>
}

let previewEndpoint: PreviewEndpoint = {
  version: 3,
  activeEndpointId: 'studio',
  servers: [
    {
      id: 'studio',
      name: '工作室 Server',
      url: 'wss://motrix-studio.example:16800',
      revision: 0,
      state: 'ready',
    },
    {
      id: 'nas',
      name: '家庭 NAS',
      url: 'wss://motrix.example.com/bridge',
      revision: 0,
      state: 'ready',
    },
  ],
  cleanupTombstones: [],
}

const pairedEndpoints = new Set(['local', 'studio'])
let nextServerId = 1
let previewConnectionState: 'connected' | 'disconnected' = 'connected'

const previewRuntime = {
  id: 'motrix-options-preview',
  getManifest: () => ({ version: '0.1.0' }),
  sendMessage: async (message: unknown): Promise<unknown> => {
    const request = message as { kind?: string; payload?: unknown }
    switch (request.kind) {
      case 'bg.getEndpointConfig':
        return previewEndpoint
      case 'bg.activateEndpoint': {
        const payload = request.payload as { endpointId: string }
        previewEndpoint = {
          ...previewEndpoint,
          activeEndpointId: payload.endpointId,
        }
        previewConnectionState = pairedEndpoints.has(payload.endpointId)
          ? 'connected'
          : 'disconnected'
        return { config: previewEndpoint }
      }
      case 'bg.addServer': {
        const payload = request.payload as { name: string; url: string }
        const server = {
          id: `preview-server-${nextServerId++}`,
          ...payload,
          revision: 0,
          state: 'ready' as const,
        }
        previewEndpoint = {
          ...previewEndpoint,
          servers: [...previewEndpoint.servers, server],
        }
        return { config: previewEndpoint, server }
      }
      case 'bg.updateServer': {
        const payload = request.payload as {
          endpointId: string
          expected: { name: string; url: string; revision: number }
          changes: { name: string; url: string }
        }
        const previous = previewEndpoint.servers.find(
          ({ id }) => id === payload.endpointId
        )
        if (
          previous === undefined ||
          previous.name !== payload.expected.name ||
          previous.url !== payload.expected.url ||
          previous.revision !== payload.expected.revision
        ) {
          return { error: 'server changed; refresh and try again' }
        }
        const server = {
          id: payload.endpointId,
          ...payload.changes,
          revision: previous.revision,
          state: 'ready' as const,
        }
        const urlChanged = previous?.url !== server.url
        if (urlChanged) {
          // The real lifecycle persists cleanup-pending and a tombstone before
          // retiring the old authority. The preview performs those states
          // synchronously, but still exposes the final revision contract.
          const invalidatedRevision = previous.revision + 1
          previewEndpoint = {
            ...previewEndpoint,
            servers: previewEndpoint.servers.map((candidate) =>
              candidate.id === payload.endpointId
                ? {
                    ...server,
                    revision: invalidatedRevision,
                    state: 'cleanup-pending' as const,
                  }
                : candidate
            ),
            cleanupTombstones: [
              ...previewEndpoint.cleanupTombstones,
              {
                endpointId: previous.id,
                canonicalWsBase: previous.url,
                invalidatedRevision,
              },
            ],
          }
          server.revision = invalidatedRevision
        }
        previewEndpoint = {
          ...previewEndpoint,
          servers: previewEndpoint.servers.map((candidate) =>
            candidate.id === payload.endpointId ? server : candidate
          ),
          cleanupTombstones: previewEndpoint.cleanupTombstones.filter(
            ({ endpointId, invalidatedRevision }) =>
              endpointId !== payload.endpointId ||
              invalidatedRevision !== server.revision
          ),
        }
        if (urlChanged) {
          pairedEndpoints.delete(payload.endpointId)
          if (previewEndpoint.activeEndpointId === payload.endpointId) {
            previewConnectionState = 'disconnected'
          }
        }
        return {
          config: previewEndpoint,
          server,
          urlChanged,
          active: previewEndpoint.activeEndpointId === payload.endpointId,
        }
      }
      case 'bg.removeServer': {
        const payload = request.payload as {
          endpointId: string
          expected: { name: string; url: string; revision: number }
        }
        const previous = previewEndpoint.servers.find(
          ({ id }) => id === payload.endpointId
        )
        if (
          previous === undefined ||
          previous.name !== payload.expected.name ||
          previous.url !== payload.expected.url ||
          previous.revision !== payload.expected.revision
        ) {
          return { error: 'server changed; refresh and try again' }
        }
        const wasActive =
          previewEndpoint.activeEndpointId === payload.endpointId
        const invalidatedRevision = previous.revision + 1
        previewEndpoint = {
          ...previewEndpoint,
          servers: previewEndpoint.servers.map((candidate) =>
            candidate.id === payload.endpointId
              ? {
                  ...candidate,
                  revision: invalidatedRevision,
                  state: 'cleanup-pending' as const,
                }
              : candidate
          ),
          cleanupTombstones: [
            ...previewEndpoint.cleanupTombstones,
            {
              endpointId: previous.id,
              canonicalWsBase: previous.url,
              invalidatedRevision,
            },
          ],
        }
        previewEndpoint = {
          ...previewEndpoint,
          activeEndpointId: wasActive
            ? 'local'
            : previewEndpoint.activeEndpointId,
          servers: previewEndpoint.servers.filter(
            ({ id }) => id !== payload.endpointId
          ),
          cleanupTombstones: previewEndpoint.cleanupTombstones.filter(
            ({ endpointId, invalidatedRevision: revision }) =>
              endpointId !== payload.endpointId ||
              revision !== invalidatedRevision
          ),
        }
        pairedEndpoints.delete(payload.endpointId)
        if (wasActive) previewConnectionState = 'disconnected'
        return { config: previewEndpoint, wasActive }
      }
      case 'bg.getPairingStatus': {
        const payload = request.payload as { endpointId: string }
        return { paired: pairedEndpoints.has(payload.endpointId) }
      }
      case 'bg.unpair': {
        const payload = request.payload as { endpointId: string }
        pairedEndpoints.delete(payload.endpointId)
        if (previewEndpoint.activeEndpointId === payload.endpointId) {
          previewConnectionState = 'disconnected'
        }
        return { ok: true }
      }
      case 'bg.reconnect':
        previewConnectionState = pairedEndpoints.has(
          previewEndpoint.activeEndpointId
        )
          ? 'connected'
          : 'disconnected'
        return { ok: true }
      case 'bg.getState':
        return { state: previewConnectionState }
      case 'bg.getTakeoverConfig':
        return {
          enabled: false,
          consentAckVersion: 0,
          defaultAction: 'motrix',
          rules: [],
        }
      case 'bg.getNotificationsConfig':
        return { master: true, confirm: false, error: true, reminder: true }
      case 'bg.listAdapters':
        return { adapters: [] }
      default:
        return { ok: true }
    }
  },
}

const storageChanged = {
  addListener: () => undefined,
  removeListener: () => undefined,
}
const previewBrowser = {
  runtime: previewRuntime,
  i18n: { getUILanguage: () => 'zh-CN' },
  storage: {
    local: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    },
    onChanged: storageChanged,
  },
}

;(globalThis as unknown as { browser: unknown }).browser = previewBrowser
;(globalThis as unknown as { chrome: unknown }).chrome = previewBrowser

const [{ App }, { initI18n }, { initTheme }] = await Promise.all([
  import('@/options/App'),
  import('@/shared/i18n'),
  import('@/shared/theme'),
])

initTheme()
await initI18n()

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
