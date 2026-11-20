import {
  parseTakeoverConfig,
  TAKEOVER_CONFIG_KEY,
} from '@/background/TakeoverConfigStore'
import { extensionBrowser as browser } from '@/shared/browser'
import { siteDomain, siteExclusionDomains } from '@/shared/siteExclusion'
import { hostSuffixMatch } from '@/shared/takeover'

export function startDownloadProtection() {
  let domains: string[] | undefined
  const read = (value: unknown) =>
    siteExclusionDomains(parseTakeoverConfig(value))
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && TAKEOVER_CONFIG_KEY in changes)
      domains = read(changes[TAKEOVER_CONFIG_KEY]?.newValue)
  })
  void browser.storage.local
    .get(TAKEOVER_CONFIG_KEY)
    .then((saved) => {
      domains ??= read(saved[TAKEOVER_CONFIG_KEY])
    })
    .catch(() => {})
  // Retire the periodic refresh scheduled by 0.1.24/25.
  void browser.alarms?.clear('motrix.downloadProtection.v1').catch(() => {})
  return (_role: 'source' | 'resource', url?: string) => {
    if (domains === undefined) return true
    const host = siteDomain(url)
    return (
      host !== null && domains.some((domain) => hostSuffixMatch(host, domain))
    )
  }
}
