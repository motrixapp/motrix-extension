import { extensionBrowser as browser } from '@/shared/browser'
import { siteDomain, siteExclusionDomains } from '@/shared/siteExclusion'
import {
  hostSuffixMatch,
  parseTakeoverConfig,
  TAKEOVER_CONFIG_KEY,
} from '@/shared/takeover'

export type DownloadProtection = ((
  role: 'source' | 'resource',
  url?: string
) => boolean) & {
  ready: Promise<void>
}

export function startDownloadProtection(): DownloadProtection {
  let domains: string[] | undefined
  const read = (value: unknown) =>
    siteExclusionDomains(parseTakeoverConfig(value))
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && TAKEOVER_CONFIG_KEY in changes)
      domains = read(changes[TAKEOVER_CONFIG_KEY]?.newValue)
  })
  const ready = Promise.resolve(browser.storage.local.get(TAKEOVER_CONFIG_KEY))
    .then((saved) => {
      domains ??= read(saved[TAKEOVER_CONFIG_KEY])
    })
    .catch(() => {
      domains ??= []
    })
  // Retire the periodic refresh scheduled by 0.1.24/25.
  void browser.alarms?.clear('motrix.downloadProtection.v1').catch(() => {})
  const check = (_role: 'source' | 'resource', url?: string) => {
    if (domains === undefined) return true
    const host = siteDomain(url)
    return (
      host !== null && domains.some((domain) => hostSuffixMatch(host, domain))
    )
  }
  return Object.assign(check, { ready })
}
