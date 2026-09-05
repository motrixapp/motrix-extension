import '@/styles/globals.css'
import { createRoot } from 'react-dom/client'
import type { NotificationsConfig } from '@/shared/notifications'
import type { TakeoverConfig } from '@/shared/takeover'

const previewParams = new URLSearchParams(globalThis.location.search)
const previewScan = previewParams.get('scan')
const previewLocale = previewParams.get('lang') === 'zh-CN' ? 'zh-CN' : 'en-US'
let previewConnection =
  previewParams.get('connection') === 'offline' ? 'disconnected' : 'connected'

const previewMedia = [
  {
    kind: 'hls' as const,
    url: 'https://cdn.example.com/live/master.m3u8',
    pageUrl: 'https://example.com/watch',
    pageTitle: 'Live showcase',
    mimeType: 'application/vnd.apple.mpegurl',
    detectedAt: Date.now(),
  },
  {
    kind: 'direct' as const,
    url: 'https://cdn.example.com/video/launch-film.mp4',
    pageUrl: 'https://example.com/watch',
    pageTitle: 'Launch film',
    mimeType: 'video/mp4',
    detectedAt: Date.now(),
  },
]

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
  activeEndpointId: 'local',
  servers: [
    {
      id: 'studio',
      name: 'Studio Server',
      url: 'wss://motrix-studio.example:16800',
      revision: 0,
      state: 'ready',
    },
    {
      id: 'nas',
      name: 'Home NAS',
      url: 'wss://motrix.example.com/ws',
      revision: 0,
      state: 'ready',
    },
  ],
  cleanupTombstones: [],
}

let previewTakeover: TakeoverConfig = {
  enabled: true,
  consentAckVersion: 1,
  defaultAction: 'motrix',
  rules: [],
}
let previewNotifications: NotificationsConfig = {
  master: true,
  confirm: false,
  error: true,
  reminder: true,
}

const previewRuntime = {
  id: 'motrix-popup-preview',
  onMessage: { addListener: () => undefined, removeListener: () => undefined },
  connectNative: () => undefined,
  openOptionsPage: async () => undefined,
  sendMessage: async (message: unknown): Promise<unknown> => {
    const request = message as { kind?: string; payload?: unknown }
    const kind = request.kind
    switch (kind) {
      case 'bg.getTakeoverConfig':
        return previewTakeover
      case 'bg.setTakeoverConfig':
        previewTakeover = request.payload as TakeoverConfig
        return { ok: true }
      case 'bg.getNotificationsConfig':
        return previewNotifications
      case 'bg.setNotificationsConfig':
        previewNotifications = request.payload as NotificationsConfig
        return { ok: true }
      case 'bg.getState':
        if (previewConnection !== 'connected') {
          return {
            state: previewConnection,
            lastError: 'motrix-not-running',
          }
        }
        return {
          state: previewConnection,
          server: {
            name: 'Motrix',
            version: '2.0.0',
            runtime:
              previewEndpoint.activeEndpointId === 'local'
                ? 'electron'
                : 'server',
          },
        }
      case 'bg.reconnect':
        previewConnection = 'connected'
        return { ok: true }
      case 'bg.getEndpointConfig':
        return previewEndpoint
      case 'bg.activateEndpoint': {
        const { endpointId } = request.payload as { endpointId: string }
        previewEndpoint = {
          ...previewEndpoint,
          activeEndpointId: endpointId,
        }
        return { config: previewEndpoint }
      }
      case 'bg.taskList':
        return { tasks: [], total: 0 }
      case 'bg.statsGet':
        return {
          totalDownloadSpeed: 0,
          totalUploadSpeed: 0,
          activeTasks: 0,
          waitingTasks: 0,
          stoppedTasks: 0,
        }
      case 'bg.engineStatus':
        return { state: 'ready', featureReport: null }
      case 'bg.scanActiveTab':
        if (previewScan === 'restricted') {
          return { error: 'Cannot access a chrome:// URL' }
        }
        if (previewScan === 'empty') {
          return { media: [], selectionKinds: ['direct'] }
        }
        return {
          media: previewMedia,
          selectionKinds: ['direct', 'hls', 'dash', 'mux'],
        }
      case 'bg.submitMedia':
      case 'bg.resolvePageDownload':
        return { taskId: 'preview-task' }
      default:
        return { ok: true }
    }
  },
  getManifest: () => ({ version: '0.1.0' }),
}

const storageChanged = {
  addListener: () => undefined,
  removeListener: () => undefined,
}
const previewBrowser = {
  runtime: previewRuntime,
  i18n: { getUILanguage: () => previewLocale },
  storage: {
    local: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    },
    onChanged: storageChanged,
  },
}
const previewChrome = {
  ...previewBrowser,
  tabs: {
    query: async () => [
      { id: 1, url: 'https://example.com/watch', title: 'Launch film' },
    ],
  },
}

;(globalThis as unknown as { browser: unknown }).browser = previewBrowser
;(globalThis as unknown as { chrome: unknown }).chrome = previewChrome

const [{ App }, { initI18n }, { initTheme }] = await Promise.all([
  import('@/popup/App'),
  import('@/shared/i18n'),
  import('@/shared/theme'),
])

initTheme()
await initI18n()

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
