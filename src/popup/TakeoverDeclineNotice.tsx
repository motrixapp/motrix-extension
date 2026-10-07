import { ShieldQuestion } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { send } from '@/background/MessageBus'
import { Button } from '@/components/ui/button'

interface Decline {
  at: number
  code: string
  host: string
  nativeCancelled: boolean
}

/** How long a decline stays interesting. Older rows are history, not news. */
const FRESH_MS = 10 * 60_000

/**
 * Explains downloads that stayed in the browser.
 *
 * Takeover declines are silent by nature: the policy engine returns "no" and
 * the browser finishes the file, which is correct but indistinguishable from a
 * broken extension. Surfacing the reason and the host closes that gap without
 * logging URLs anywhere persistent.
 */
export const TakeoverDeclineNotice = memo(function TakeoverDeclineNotice({
  enabled,
}: {
  enabled: boolean
}): React.ReactElement | null {
  const { t } = useTranslation()
  const [declines, setDeclines] = useState<Decline[]>([])
  const [dismissedCount, setDismissedCount] = useState(0)

  useEffect(() => {
    if (!enabled) {
      setDeclines([])
      return
    }
    let cancelled = false
    const read = async (): Promise<void> => {
      try {
        const next = await send('bg.getTakeoverDeclines', undefined)
        if (!cancelled && Array.isArray(next)) setDeclines(next)
      } catch {
        // Advisory only: the download already happened either way.
      }
    }
    void read()
    const timer = setInterval(() => void read(), 4000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [enabled])

  const fresh = useMemo(() => {
    const cutoff = Date.now() - FRESH_MS
    return declines.filter(
      (decline) => decline.at >= cutoff && decline.host.length > 0
    )
  }, [declines])

  const visible = useMemo(
    () => fresh.slice(dismissedCount),
    [fresh, dismissedCount]
  )

  const dismiss = useCallback(() => {
    setDismissedCount(fresh.length)
  }, [fresh.length])

  if (visible.length === 0) return null

  return (
    <div
      role="status"
      data-testid="takeover-decline-notice"
      className="mt-2 flex shrink-0 items-start gap-2 rounded-[10px] border border-amber-500/20 bg-amber-500/[0.07] px-3 py-2 text-[11px]/4 text-amber-700 dark:text-amber-400"
    >
      <ShieldQuestion className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {t('popup.takeover.declineTitle', { count: visible.length })}
        </p>
        <ul className="mt-0.5 space-y-0.5">
          {visible.slice(0, 3).map((decline) => (
            // Records are append-only and never reordered, so the host plus
            // the reason identifies the row without an index key.
            <li key={`${decline.host}-${decline.code}`} className="truncate">
              <span className="font-medium">{decline.host}</span>
              <span className="text-amber-700/80 dark:text-amber-400/80">
                {' · '}
                {t(`popup.takeover.declines.${decline.code}`)}
              </span>
            </li>
          ))}
        </ul>
        {visible.length > 3 && (
          <p className="mt-0.5 text-amber-700/80 dark:text-amber-400/80">
            {t('popup.takeover.declineMore', { count: visible.length - 3 })}
          </p>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="shrink-0 text-amber-700 dark:text-amber-400"
        onClick={dismiss}
      >
        {t('options.common.cancel')}
      </Button>
    </div>
  )
})
