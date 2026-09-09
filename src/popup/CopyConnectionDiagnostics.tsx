import { CheckIcon, CopyIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { buildConnectionDiagnostics } from '@/popup/connectionDiagnostics'
import type { PopupState } from '@/popup/usePopupState'
import { extensionBrowser } from '@/shared/browser'
import { BUILD_VARIANT } from '@/shared/buildFlags'
import { hasNativeMessagingSupport } from '@/shared/platformCapabilities'

export function CopyConnectionDiagnostics({
  state,
}: {
  state: PopupState
}): React.ReactElement {
  const { t, i18n } = useTranslation()
  const [status, setStatus] = useState<
    'idle' | 'copying' | 'copied' | 'failed'
  >('idle')
  const label =
    status === 'copied'
      ? t('options.help.copied')
      : t('options.help.copyDiagnostics')

  useEffect(() => {
    if (status !== 'copied') return
    const timer = setTimeout(() => setStatus('idle'), 2500)
    return () => clearTimeout(timer)
  }, [status])

  const copy = async (): Promise<void> => {
    setStatus('copying')
    try {
      const text = buildConnectionDiagnostics(state, {
        capturedAt: new Date().toISOString(),
        extensionId: extensionBrowser.runtime.id,
        extensionVersion: extensionBrowser.runtime.getManifest().version,
        build: BUILD_VARIANT,
        userAgent: navigator.userAgent,
        language: i18n.resolvedLanguage ?? i18n.language,
        nativeMessagingApi: hasNativeMessagingSupport(),
      })
      // Call in the click handler before any await to retain user activation.
      await navigator.clipboard.writeText(text)
      setStatus('copied')
    } catch {
      setStatus('failed')
    }
  }

  return (
    <div className="mt-2 flex flex-col items-start gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-auto min-h-8 max-w-full whitespace-normal text-left"
        aria-label={label}
        disabled={status === 'copying'}
        onClick={() => void copy()}
      >
        {status === 'copied' ? (
          <CheckIcon data-icon="inline-start" aria-hidden="true" />
        ) : (
          <CopyIcon data-icon="inline-start" aria-hidden="true" />
        )}
        <span role="status">{label}</span>
      </Button>
      {status === 'failed' && (
        <span role="status" className="text-xs text-destructive">
          {t('errors.connection.diagnosticsCopyFailed')}
        </span>
      )}
    </div>
  )
}
