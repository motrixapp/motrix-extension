import {
  isSeverityEnabled,
  type NotificationsConfig,
  type Notify,
} from '@/shared/notifications'

export function createNotify(store: {
  get(): Promise<NotificationsConfig>
}): Notify {
  return (n) => {
    void (async () => {
      const cfg = await store.get()
      if (!isSeverityEnabled(cfg, n.severity)) return
      await browser.notifications
        ?.create({
          type: 'basic',
          iconUrl: browser.runtime.getURL('icons/icon-128.png'),
          title: n.title,
          message: n.message,
        })
        .catch(() => {
          // best-effort: a denied notifications permission must not throw
        })
    })()
  }
}
