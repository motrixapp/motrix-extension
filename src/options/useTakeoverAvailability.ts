import { useEffect, useState } from 'react'
import { ENDPOINT_CONFIG_STORAGE_KEY } from '@/background/EndpointConfigStore'
import { send } from '@/background/MessageBus'
import { supportsAutomaticTakeover } from '@/shared/takeoverAvailability'

/** Refresh selection without resetting unsaved settings in the form. */
export function useTakeoverAvailability(): 'local' | 'remote' | 'unknown' {
  const [availability, setAvailability] = useState<
    'local' | 'remote' | 'unknown'
  >('unknown')
  useEffect(() => {
    let generation = 0
    let disposed = false
    const refresh = async (): Promise<void> => {
      const current = ++generation
      setAvailability('unknown')
      try {
        const config = await send('bg.getEndpointConfig', undefined)
        if (!disposed && current === generation) {
          setAvailability(
            supportsAutomaticTakeover(config) ? 'local' : 'remote'
          )
        }
      } catch {
        // Keep controls unavailable until the selected backend is known.
      }
    }
    const onChanged = (
      changes: Record<string, browser.storage.StorageChange>,
      area: string
    ): void => {
      if (area === 'local' && ENDPOINT_CONFIG_STORAGE_KEY in changes)
        void refresh()
    }
    browser.storage.onChanged.addListener(onChanged)
    void refresh()
    return () => {
      disposed = true
      browser.storage.onChanged.removeListener(onChanged)
    }
  }, [])
  return availability
}
