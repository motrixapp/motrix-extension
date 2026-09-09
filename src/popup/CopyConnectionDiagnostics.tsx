import { CheckIcon, CopyIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

export function CopyConnectionDiagnostics({
  text,
}: {
  text: string
}): React.ReactElement {
  const { t } = useTranslation()
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
      // Call in the click handler before any await to retain user activation.
      await navigator.clipboard.writeText(text)
      setStatus('copied')
    } catch {
      setStatus('failed')
    }
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="size-7 p-0"
        aria-label={label}
        title={label}
        disabled={status === 'copying'}
        onClick={() => void copy()}
      >
        {status === 'copied' ? (
          <CheckIcon data-icon="inline-start" aria-hidden="true" />
        ) : (
          <CopyIcon data-icon="inline-start" aria-hidden="true" />
        )}
        <span role="status" className="sr-only">
          {label}
        </span>
      </Button>
      {status === 'failed' && (
        <span role="status" className="max-w-44 text-xs text-destructive">
          {t('errors.connection.diagnosticsCopyFailed')}
        </span>
      )}
    </div>
  )
}
