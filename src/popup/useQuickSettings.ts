import { useCallback, useEffect, useRef, useState } from 'react'
import { send } from '@/background/MessageBus'
import type { NotificationsConfig } from '@/shared/notifications'
import { CONSENT_VERSION, type TakeoverConfig } from '@/shared/takeover'

export type NotificationSetting = keyof NotificationsConfig

export interface QuickSettingsError {
  operation: 'load' | 'save'
  message: string
}

export interface QuickSettingsController {
  takeover: TakeoverConfig | null
  notifications: NotificationsConfig | null
  loading: boolean
  saving: boolean
  error: QuickSettingsError | null
  consentRequired: boolean
  reload: () => Promise<void>
  requestTakeoverEnabled: (enabled: boolean) => Promise<void>
  confirmTakeoverConsent: () => Promise<void>
  cancelTakeoverConsent: () => void
  setNotification: (
    setting: NotificationSetting,
    enabled: boolean
  ) => Promise<void>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Loads and persists the two real background-owned configs used by the popup's
 * quick settings. Mutations always spread the last full config so fields that
 * are only editable on the Options page are not reset by a quick toggle.
 */
export function useQuickSettings(): QuickSettingsController {
  const [takeover, setTakeover] = useState<TakeoverConfig | null>(null)
  const [notifications, setNotifications] =
    useState<NotificationsConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<QuickSettingsError | null>(null)
  const [consentRequired, setConsentRequired] = useState(false)

  const mountedRef = useRef(true)
  const loadGenerationRef = useRef(0)
  const savingRef = useRef(false)
  const takeoverRef = useRef<TakeoverConfig | null>(null)
  const notificationsRef = useRef<NotificationsConfig | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    const generation = ++loadGenerationRef.current
    if (mountedRef.current) {
      setLoading(true)
      setError(null)
    }

    try {
      const [nextTakeover, nextNotifications] = await Promise.all([
        send('bg.getTakeoverConfig', undefined),
        send('bg.getNotificationsConfig', undefined),
      ])
      if (!mountedRef.current || generation !== loadGenerationRef.current)
        return

      takeoverRef.current = nextTakeover
      notificationsRef.current = nextNotifications
      setTakeover(nextTakeover)
      setNotifications(nextNotifications)
      setConsentRequired(false)
    } catch (loadError) {
      if (!mountedRef.current || generation !== loadGenerationRef.current)
        return
      setError({ operation: 'load', message: errorMessage(loadError) })
    } finally {
      if (mountedRef.current && generation === loadGenerationRef.current) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void reload()
    return () => {
      mountedRef.current = false
      loadGenerationRef.current += 1
    }
  }, [reload])

  const persistTakeover = useCallback(
    async (next: TakeoverConfig): Promise<boolean> => {
      const previous = takeoverRef.current
      if (previous === null || savingRef.current) return false

      savingRef.current = true
      takeoverRef.current = next
      if (mountedRef.current) {
        setSaving(true)
        setError(null)
        setTakeover(next)
      }

      try {
        await send('bg.setTakeoverConfig', next)
        return true
      } catch (saveError) {
        const shouldRollback = takeoverRef.current === next
        if (shouldRollback) takeoverRef.current = previous
        if (mountedRef.current) {
          if (shouldRollback) setTakeover(previous)
          setError({ operation: 'save', message: errorMessage(saveError) })
        }
        return false
      } finally {
        savingRef.current = false
        if (mountedRef.current) setSaving(false)
      }
    },
    []
  )

  const persistNotifications = useCallback(
    async (next: NotificationsConfig): Promise<boolean> => {
      const previous = notificationsRef.current
      if (previous === null || savingRef.current) return false

      savingRef.current = true
      notificationsRef.current = next
      if (mountedRef.current) {
        setSaving(true)
        setError(null)
        setNotifications(next)
      }

      try {
        await send('bg.setNotificationsConfig', next)
        return true
      } catch (saveError) {
        const shouldRollback = notificationsRef.current === next
        if (shouldRollback) {
          notificationsRef.current = previous
        }
        if (mountedRef.current) {
          if (shouldRollback) setNotifications(previous)
          setError({ operation: 'save', message: errorMessage(saveError) })
        }
        return false
      } finally {
        savingRef.current = false
        if (mountedRef.current) setSaving(false)
      }
    },
    []
  )

  const requestTakeoverEnabled = useCallback(
    async (enabled: boolean): Promise<void> => {
      const current = takeoverRef.current
      if (current === null || current.enabled === enabled) return

      if (enabled && current.consentAckVersion < CONSENT_VERSION) {
        if (mountedRef.current) setConsentRequired(true)
        return
      }

      if (!enabled && mountedRef.current) setConsentRequired(false)
      await persistTakeover({ ...current, enabled })
    },
    [persistTakeover]
  )

  const confirmTakeoverConsent = useCallback(async (): Promise<void> => {
    const current = takeoverRef.current
    if (current === null) return

    const saved = await persistTakeover({
      ...current,
      enabled: true,
      consentAckVersion: Math.max(current.consentAckVersion, CONSENT_VERSION),
    })
    if (saved && mountedRef.current) setConsentRequired(false)
  }, [persistTakeover])

  const cancelTakeoverConsent = useCallback((): void => {
    if (mountedRef.current) setConsentRequired(false)
  }, [])

  const setNotification = useCallback(
    async (setting: NotificationSetting, enabled: boolean): Promise<void> => {
      const current = notificationsRef.current
      if (current === null || current[setting] === enabled) return
      await persistNotifications({ ...current, [setting]: enabled })
    },
    [persistNotifications]
  )

  return {
    takeover,
    notifications,
    loading,
    saving,
    error,
    consentRequired,
    reload,
    requestTakeoverEnabled,
    confirmTakeoverConsent,
    cancelTakeoverConsent,
    setNotification,
  }
}
