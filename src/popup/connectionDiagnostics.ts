import type { PopupState } from '@/popup/usePopupState'

interface DiagnosticEnvironment {
  capturedAt: string
  extensionId: string
  extensionVersion: string
  build: string
  userAgent: string
  language: string
  nativeMessagingApi: boolean
}

/** Keep the address useful without sharing URL credentials or pairing nonces. */
function redactErrorUrls(message: string): string {
  return message.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, (text) => {
    try {
      const url = new URL(text)
      url.username = ''
      url.password = ''
      url.search = ''
      url.hash = ''
      return url.href
    } catch {
      return '[invalid URL omitted]'
    }
  })
}

export function buildConnectionDiagnostics(
  state: Pick<
    PopupState,
    'connection' | 'lastError' | 'lastErrorReason' | 'endpoint' | 'server'
  >,
  environment: DiagnosticEnvironment
): string {
  // Select fields explicitly: endpoint profiles and unrelated popup data do
  // not belong in a report intended to be pasted into a public issue.
  const report = {
    capturedAt: environment.capturedAt,
    extension: {
      id: environment.extensionId,
      version: environment.extensionVersion,
      build: environment.build,
    },
    environment: {
      userAgent: environment.userAgent,
      language: environment.language,
      nativeMessagingApi: environment.nativeMessagingApi,
    },
    connection: {
      backend:
        state.endpoint === null
          ? 'unknown'
          : state.endpoint.activeEndpointId === 'local'
            ? 'local'
            : 'remote',
      state: state.connection,
      protocol: 'MBP1',
      app: state.server
        ? { version: state.server.version, runtime: state.server.runtime }
        : null,
      error: {
        reason: state.lastErrorReason,
        message:
          state.lastError === null ? null : redactErrorUrls(state.lastError),
      },
    },
  }
  return `Motrix Extension connection diagnostics\n${JSON.stringify(report, null, 2)}`
}
