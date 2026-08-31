import {
  NOTIFICATIONS_DEFAULT,
  type NotificationsConfig,
} from '@/shared/notifications'

const STORAGE_KEY = 'motrix.notificationsConfig'

export class NotificationsConfigStore {
  async get(): Promise<NotificationsConfig> {
    const obj = await browser.storage.local.get(STORAGE_KEY)
    const v = (obj as Record<string, unknown>)[STORAGE_KEY]
    if (!v || typeof v !== 'object') return NOTIFICATIONS_DEFAULT
    const c = v as Partial<NotificationsConfig>
    if (
      typeof c.master !== 'boolean' ||
      typeof c.confirm !== 'boolean' ||
      typeof c.error !== 'boolean' ||
      typeof c.reminder !== 'boolean'
    ) {
      return NOTIFICATIONS_DEFAULT
    }
    return {
      master: c.master,
      confirm: c.confirm,
      error: c.error,
      reminder: c.reminder,
    }
  }

  async set(config: NotificationsConfig): Promise<void> {
    await browser.storage.local.set({ [STORAGE_KEY]: config })
  }
}
