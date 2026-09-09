import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { send } from '@/background/MessageBus'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { CopyConnectionDiagnostics } from '@/popup/CopyConnectionDiagnostics'
import { buildConnectionDiagnostics } from '@/popup/connectionDiagnostics'
import type { PopupState } from '@/popup/usePopupState'
import { extensionBrowser } from '@/shared/browser'
import { BUILD_VARIANT } from '@/shared/buildFlags'
import {
  diagnosticDeadline,
  redactDiagnosticError,
} from '@/shared/connectionDiagnostics'
import { hasNativeMessagingSupport } from '@/shared/platformCapabilities'

export function ConnectionDiagnosis({
  state,
}: {
  state: PopupState
}): React.ReactElement {
  const { t, i18n } = useTranslation()
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<string | null>(null)
  const reportBox = useRef<HTMLElement>(null)
  useEffect(() => {
    if (report !== null) reportBox.current?.scrollIntoView({ block: 'nearest' })
  }, [report])
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const run = async (): Promise<void> => {
    if (running) return
    setRunning(true)
    setReport(null)
    let extensionVersion = 'unknown'
    try {
      extensionVersion =
        extensionBrowser.runtime.getManifest?.().version ?? 'unknown'
    } catch {
      // An extension reload can invalidate this popup's browser API context.
    }
    // Capture the failure before the async checks; state may be polled again.
    const snapshot = buildConnectionDiagnostics(state, {
      capturedAt: new Date().toISOString(),
      extensionId: extensionBrowser.runtime.id,
      extensionVersion,
      build: BUILD_VARIANT,
      userAgent: navigator.userAgent,
      language: i18n.resolvedLanguage ?? i18n.language,
      nativeMessagingApi: hasNativeMessagingSupport(),
    })
    let text: string
    try {
      const result = await diagnosticDeadline(
        send('bg.runConnectionDiagnostics', {
          endpointId: state.endpoint?.activeEndpointId ?? null,
        }),
        15000
      )
      if (!result || !Array.isArray(result.checks))
        throw new Error('Invalid diagnostic response')
      const findings = result.checks
        .slice()
        .sort(
          (a, b) =>
            ({ fail: 0, warn: 1, pass: 2, skip: 3 })[a.status] -
            { fail: 0, warn: 1, pass: 2, skip: 3 }[b.status]
        )
        .map(
          (check) =>
            `[${check.status.toUpperCase()}] ${check.id} (${check.durationMs} ms)\n${check.detail}`
        )
        .join('\n\n')
      text = `Diagnostic checks — ${result.backend}, ${result.durationMs} ms\n${findings}\n\n${snapshot}`
    } catch (error) {
      text = `[FAIL] background-diagnostics\n${redactDiagnosticError(error instanceof Error ? error.message : 'Background unavailable')}\nChecks could not finish; debug logging may not be enabled. Inspect the extension background console, reload the extension and retry.\n\n${snapshot}`
    }
    if (alive.current) {
      setReport(text)
      setRunning(false)
    }
  }
  return (
    <div className="mt-2 min-w-0 space-y-2 text-left">
      {state.endpoint?.activeEndpointId === 'local' && (
        <p className="text-xs leading-relaxed">
          {t('popup.diagnostics.allowlistHint')}
        </p>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={running}
        onClick={() => void run()}
      >
        {running && <Spinner aria-hidden="true" />}
        {t(
          running
            ? 'popup.diagnostics.running'
            : report
              ? 'popup.diagnostics.rerun'
              : 'popup.diagnostics.run'
        )}
      </Button>
      {running && (
        <p role="status" className="text-xs">
          {t('popup.diagnostics.runningHelp')}
        </p>
      )}
      {report !== null && (
        <section
          ref={reportBox}
          aria-label={t('popup.diagnostics.title')}
          className="min-w-0 rounded-md border border-border bg-background text-foreground"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1">
            <span className="text-xs font-medium">
              {t('popup.diagnostics.title')}
            </span>
            <CopyConnectionDiagnostics key={report} text={report} />
          </div>
          <textarea
            aria-label={t('popup.diagnostics.title')}
            readOnly
            value={report}
            className="block h-48 w-full resize-none overflow-auto whitespace-pre-wrap rounded-b-md bg-transparent p-2 font-mono text-[11px] leading-relaxed [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-ring"
          />
        </section>
      )}
    </div>
  )
}
