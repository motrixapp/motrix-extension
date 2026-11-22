import { createOperationQueue } from '@/background/mbp1/operation-queue'
import { extensionBrowser as browser } from '@/shared/browser'
import { withSiteExcluded } from '@/shared/siteExclusion'
import {
  type DownloadMode,
  parseTakeoverConfig,
  TAKEOVER_CONFIG_KEY,
  type TakeoverConfig,
  type TakeoverSettings,
} from '@/shared/takeover'

const enqueue = createOperationQueue()

export class TakeoverConfigStore {
  async get(): Promise<TakeoverConfig> {
    const saved = await browser.storage.local.get(TAKEOVER_CONFIG_KEY)
    return parseTakeoverConfig(saved[TAKEOVER_CONFIG_KEY])
  }

  async patchEnabled(
    enabled: boolean,
    consentAckVersion?: number
  ): Promise<TakeoverConfig> {
    return enqueue(async () => {
      if (
        typeof enabled !== 'boolean' ||
        (consentAckVersion !== undefined &&
          (!Number.isInteger(consentAckVersion) || consentAckVersion < 0))
      )
        throw new Error('invalid takeover setting')
      const current = await this.get()
      const next = {
        ...current,
        enabled,
        consentAckVersion:
          consentAckVersion === undefined
            ? current.consentAckVersion
            : Math.max(current.consentAckVersion, consentAckVersion),
      }
      await browser.storage.local.set({ [TAKEOVER_CONFIG_KEY]: next })
      return next
    })
  }

  async set(config: TakeoverConfig): Promise<void> {
    await enqueue(() =>
      browser.storage.local.set({ [TAKEOVER_CONFIG_KEY]: config })
    )
  }

  async patchTakeoverSettings(settings: TakeoverSettings): Promise<void> {
    await enqueue(async () => {
      const current = await this.get()
      await browser.storage.local.set({
        [TAKEOVER_CONFIG_KEY]: {
          ...current,
          downloadMode:
            settings.downloadMode === 'confirm' ||
            settings.downloadMode === 'direct'
              ? settings.downloadMode
              : current.downloadMode,
          enabled: settings.enabled,
          consentAckVersion: settings.consentAckVersion,
          defaultAction: settings.defaultAction,
          unknownSizeAction:
            settings.unknownSizeAction === 'motrix' ? 'motrix' : 'chrome',
          rules: settings.rules,
        },
      })
    })
  }

  async patchTaskPanelPreference(
    openTaskPanelAfterSubmit: boolean
  ): Promise<TakeoverConfig> {
    return enqueue(async () => {
      if (typeof openTaskPanelAfterSubmit !== 'boolean')
        throw new Error('invalid task panel setting')
      const current = await this.get()
      const next = { ...current, openTaskPanelAfterSubmit }
      await browser.storage.local.set({ [TAKEOVER_CONFIG_KEY]: next })
      return next
    })
  }

  async patchDownloadMode(downloadMode: DownloadMode): Promise<TakeoverConfig> {
    return enqueue(async () => {
      if (downloadMode !== 'confirm' && downloadMode !== 'direct')
        throw new Error('invalid download mode')
      const next = { ...(await this.get()), downloadMode }
      await browser.storage.local.set({ [TAKEOVER_CONFIG_KEY]: next })
      return next
    })
  }

  async patchSiteExclusion(
    domain: string,
    excluded: boolean
  ): Promise<TakeoverConfig> {
    return enqueue(async () => {
      const next = withSiteExcluded(await this.get(), domain, excluded)
      await browser.storage.local.set({ [TAKEOVER_CONFIG_KEY]: next })
      return next
    })
  }
}
