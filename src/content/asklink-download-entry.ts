import { extensionBrowser as browser } from '@/shared/browser'
import { excludedSiteDomain } from '@/shared/siteExclusion'
import {
  parseTakeoverConfig,
  TAKEOVER_CONFIG_KEY,
  type TakeoverConfig,
} from '@/shared/takeover'

if (window.top === window && location.origin === 'https://www.asklink.com') {
  let config: TakeoverConfig | undefined
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && TAKEOVER_CONFIG_KEY in changes)
      config = parseTakeoverConfig(changes[TAKEOVER_CONFIG_KEY]?.newValue)
  })
  void browser.storage.local
    .get(TAKEOVER_CONFIG_KEY)
    .then((saved) => {
      config ??= parseTakeoverConfig(saved[TAKEOVER_CONFIG_KEY])
    })
    .catch(() => {})

  window.addEventListener(
    'click',
    (event) => {
      if (
        !config?.enabled ||
        !event.isTrusted ||
        event.defaultPrevented ||
        !event.cancelable ||
        event.button !== 0 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return
      const anchor = event
        .composedPath()
        .find((node) => node instanceof HTMLAnchorElement)
      if (!anchor || !URL.canParse(anchor.href)) return
      const url = new URL(anchor.href)
      if (
        url.origin !== 'https://dl.asklink.com' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !/^\/download\/windows\/Full\/AskLink_Full_[\w.-]+\.exe$/i.test(
          url.pathname
        ) ||
        excludedSiteDomain(config, location.hostname) ||
        excludedSiteDomain(config, url.hostname)
      )
        return
      // AskLink fetches this public installer into a Blob. Preserve the
      // anchor's default action so the normal download adapter can handle it.
      event.stopImmediatePropagation()
    },
    true
  )
}
