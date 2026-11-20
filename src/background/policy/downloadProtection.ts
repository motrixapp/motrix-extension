import bundled from '@/background/policy/download-protection.json'
import {
  parseTakeoverConfig,
  TAKEOVER_CONFIG_KEY,
} from '@/background/TakeoverConfigStore'
import { extensionBrowser as browser } from '@/shared/browser'
import { isProtectedDownload, listSchema } from '@/shared/downloadProtection'
import { siteDomain, siteExclusionDomains } from '@/shared/siteExclusion'
import { hostSuffixMatch } from '@/shared/takeover'

const KEY = 'motrix.downloadProtection.v1'
const FEED = 'https://motrix.app/rules/download-protection/v1.json'
const baseline = listSchema.parse(bundled)

export function startDownloadProtection() {
  let list = baseline
  let etag: string | undefined
  let loaded = false
  let personalDomains: string[] = []
  let changedDuringLoad = false
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(TAKEOVER_CONFIG_KEY in changes)) return
    changedDuringLoad = true
    personalDomains = siteExclusionDomains(
      parseTakeoverConfig(changes[TAKEOVER_CONFIG_KEY]?.newValue)
    )
  })
  const ready = browser.storage.local
    .get([KEY, TAKEOVER_CONFIG_KEY])
    .then((saved) => {
      if (!changedDuringLoad)
        personalDomains = siteExclusionDomains(
          parseTakeoverConfig(saved[TAKEOVER_CONFIG_KEY])
        )
      const cached = saved[KEY] as { list?: unknown; etag?: string } | undefined
      const parsed = listSchema.safeParse(cached?.list)
      if (parsed.success && parsed.data.revision >= list.revision) {
        list = parsed.data
        etag = cached?.etag
      }
      loaded = true
    })
    .catch(() => {})
  const refresh = async () => {
    await ready
    const res = await fetch(FEED, {
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(5000),
      headers: etag ? { 'If-None-Match': etag } : {},
    })
    if (
      !res.ok ||
      !res.headers.get('content-type')?.includes('application/json')
    )
      return
    const body = await res.text()
    if (body.length > 256_000) return
    const next = listSchema.parse(JSON.parse(body))
    if (next.revision < list.revision) return
    const tag = res.headers.get('etag') ?? undefined
    await browser.storage.local.set({ [KEY]: { list: next, etag: tag } })
    list = next
    etag = tag
  }
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEY) void refresh().catch(() => {})
  })
  void browser.alarms
    .get(KEY)
    .then((alarm) => {
      if (!alarm)
        return browser.alarms.create(KEY, {
          delayInMinutes: 1,
          periodInMinutes: 24 * 60,
        })
    })
    .catch(() => {})
  return (role: 'source' | 'resource', url?: string) => {
    if (!loaded || isProtectedDownload(list, role, url)) return true
    const domain = siteDomain(url)
    return (
      domain !== null &&
      personalDomains.some((entry) => hostSuffixMatch(domain, entry))
    )
  }
}
