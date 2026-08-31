import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { hasLoopbackPermission } from '@/background/mbp1/permission-gate'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import type { PopupState } from '@/popup/usePopupState'
import { connectionErrorKey } from '@/shared/errorCopy'

interface Props {
  state: PopupState
  onReconnect: () => void
  onShowPairing?: () => void
}

/**
 * Seconds until a §7.3 backoff expires, ticking once a second while one is
 * active. `0` means "no backoff in force" — the tick stops then, so an idle
 * popup holds no timer.
 */
function useBackoffSecondsLeft(retryAtMs: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (retryAtMs === null || retryAtMs <= Date.now()) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [retryAtMs])
  if (retryAtMs === null) return 0
  return Math.max(0, Math.ceil((retryAtMs - now) / 1000))
}

/** `hasLoopbackPermission()` is only a compatibility check today — `<all_urls>` is
 *  a required, install-time host permission that already covers the
 *  loopback origin — so this branch is currently unreachable in production.
 *  It remains wired so a future narrowing of `host_permissions` can add the
 *  corresponding optional permission flow without discovery failing silently. */
function usePermissionMissing(): boolean {
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    let cancelled = false
    void hasLoopbackPermission().then((granted) => {
      if (!cancelled) setMissing(!granted)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return missing
}

const DOT_COLOR: Record<string, string> = {
  connected: 'bg-green-500',
  connecting: 'bg-amber-400 animate-pulse',
  bootstrapping: 'bg-amber-400 animate-pulse',
  handshaking: 'bg-amber-400 animate-pulse',
  'awaiting-code': 'bg-amber-400 animate-pulse',
  disconnected: 'bg-red-500',
  denied: 'bg-red-500',
}

export function ConnectionStatusPanel({
  state,
  onReconnect,
  onShowPairing,
}: Props): React.ReactElement {
  const { t } = useTranslation()
  // Called unconditionally, before the loading early-return below — React's
  // rules of hooks don't bend for it.
  const permissionMissing = usePermissionMissing()
  const backoffSecondsLeft = useBackoffSecondsLeft(
    state.backoff?.retryAtMs ?? null
  )
  // A click must be visibly acknowledged at once — the attempt itself can
  // fail (e.g. under §7.3) faster than the 1 s state poll, which otherwise
  // leaves the UI pixel-identical and the click feeling dead. Cleared when
  // the next poll snapshot arrives (`state` is a fresh object every tick).
  const [pendingReconnect, setPendingReconnect] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies(state): the snapshot object itself is the signal — every poll delivers a fresh `state`, and its arrival is what acknowledges the click.
  useEffect(() => {
    setPendingReconnect(false)
  }, [state])

  if (state.loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" aria-hidden="true" />
        {t('popup.loading')}
      </div>
    )
  }

  const conn = state.connection ?? 'disconnected'
  const isOk = conn === 'connected'
  const canShowPairing =
    state.pairingCode !== null && onShowPairing !== undefined

  return (
    <Card className="h-full min-w-0 rounded-none border-0 py-0 shadow-none ring-0">
      <CardContent className="flex h-full flex-col justify-center gap-3 px-8 py-6 text-center">
        <div className="flex items-center justify-center gap-2">
          <span
            data-testid="status-dot"
            data-state={conn}
            className={cn(
              'h-2.5 w-2.5 rounded-full',
              DOT_COLOR[conn] ?? 'bg-muted-foreground'
            )}
          />
          <span className="text-sm text-foreground">
            {t(`popup.status.${conn}`, { defaultValue: conn })}
          </span>
        </div>
        {/* A reason never arrives without its message (they are set and
         *  suppressed together in bg.getState), so presence keys off the
         *  message alone; the reason picks the copy. */}
        {state.lastError !== null && (
          // Locale copy keyed by the stable reason code — the raw
          // `lastError` sentence is developer-facing (it also goes to
          // logs) and surfaces only as a hover title for diagnosis.
          <Alert variant="destructive" title={state.lastError}>
            <AlertDescription>
              {t(connectionErrorKey(state.lastErrorReason))}
            </AlertDescription>
          </Alert>
        )}
        {/* §6.7/§12: an unattended attempt (autostart, or the automatic
         *  post-close probe-reconnect) correctly refused to fall back to
         *  fresh code-entry pairing on its own — the Connect button below
         *  is the actionable next step, not a nudge to wait. `bg.getState`
         *  never sends `lastError` alongside this flag (see its own doc),
         *  so this replaces that alert rather than joining it. */}
        {state.recoveryExhaustedUnattended && (
          <Alert>
            <AlertTitle>{t('popup.pairing.recoveryExhaustedTitle')}</AlertTitle>
            <AlertDescription>
              {t('popup.pairing.recoveryExhaustedBody')}
            </AlertDescription>
          </Alert>
        )}
        {/* §7.3: the retry time is always the client's own FirstPairBackoff
         *  value — bg.getState never forwards anything the peer reported. */}
        {state.backoff && (
          <Alert>
            <AlertTitle>{t('popup.pairing.backoffTitle')}</AlertTitle>
            <AlertDescription>
              {t('popup.pairing.backoffBody', {
                time: new Date(state.backoff.retryAtMs).toLocaleTimeString(),
              })}
            </AlertDescription>
          </Alert>
        )}
        {permissionMissing && (
          <Alert>
            <AlertTitle>{t('popup.pairing.permissionMissingTitle')}</AlertTitle>
            <AlertDescription>
              {t('popup.pairing.permissionMissingBody')}
            </AlertDescription>
          </Alert>
        )}
        {/* Only shown while actually connected — this describes the live
         *  session's pairing, not an error condition. Not a warning about
         *  Motrix's authenticity: the pairing was still mutually
         *  authenticated by the code, only the host's own corroboration of
         *  *which* Motrix answered is missing. */}
        {isOk && state.degraded && (
          <Alert>
            <AlertTitle>{t('popup.pairing.degradedTitle')}</AlertTitle>
            <AlertDescription>
              {t('popup.pairing.degradedBody')}
            </AlertDescription>
          </Alert>
        )}
        {!isOk && (
          // §7.3: while the backoff is in force a click cannot succeed, so
          // the button says when it can instead of silently failing.
          <Button
            type="button"
            size="sm"
            disabled={
              !canShowPairing && (pendingReconnect || backoffSecondsLeft > 0)
            }
            onClick={() => {
              if (canShowPairing) {
                onShowPairing()
                return
              }
              setPendingReconnect(true)
              onReconnect()
            }}
          >
            {!canShowPairing && pendingReconnect && (
              <Spinner data-icon="inline-start" />
            )}
            {canShowPairing
              ? t('popup.pairing.enterCode')
              : backoffSecondsLeft > 0
                ? t('popup.pairing.retryIn', { seconds: backoffSecondsLeft })
                : t('popup.reconnect')}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
