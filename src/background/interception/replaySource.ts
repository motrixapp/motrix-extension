import { contentDispositionFilename } from '@/background/capture/contentDisposition'
import { type Browser, extensionBrowser as browser } from '@/shared/browser'
import { getBuildBrowser } from '@/shared/browserKind'

type Protected = (role: 'source' | 'resource', url?: string) => boolean
export interface ReplayItem {
  id?: number | undefined
  requestId?: string | undefined
  url: string
  finalUrl?: string | undefined
  referrer?: string | undefined
}
export interface ReplaySource {
  tabId?: number
  url: string
  source?: string | undefined
  filename?: string | undefined
  size?: number | undefined
  mime?: string | undefined
  allowed: () => boolean
}

export type ReplayLookup = ((item: ReplayItem) => ReplaySource | null) & {
  waitForResponse?: (item: ReplayItem) => Promise<ReplaySource | null>
}

// A URL-only DownloadItem cannot disambiguate an evicted request. Remember
// its hash bucket briefly; collisions leave those downloads with the browser.
function bucket(url: string) {
  let hash = 0
  for (let i = 0; i < url.length; i++)
    hash = (Math.imul(hash, 31) + url.charCodeAt(i)) | 0
  return hash & 2047
}

export function observeReplaySources(protectedUrl: Protected) {
  type Record = {
    tabId: number
    initial: string
    final: string
    source?: string | undefined
    time: number
    response?: ReplaySource
    blocked: boolean
    hops: string[]
    downloadId?: number
  }
  const waiting = new Map<string, Set<() => void>>()
  const candidates = new Map<string, Record>()
  const evictedUntil = new Float64Array(2048)
  const lifetime = 30_000
  // Use network evidence for the request that became a download. Exclude page
  // subresources from the bounded cache so busy sites cannot crowd out downloads.
  const filter: Browser.webRequest.RequestFilter = {
    urls: ['http://*/*', 'https://*/*'],
    types: ['main_frame', 'sub_frame', 'other', 'object'],
  }
  const prune = () => {
    const cutoff = Date.now() - lifetime
    for (const [id, r] of candidates) {
      if (r.time && r.time < cutoff) candidates.delete(id)
    }
  }
  function remember(id: string, record: Record) {
    prune()
    if (candidates.size >= 256) {
      const oldest = candidates.entries().next().value
      if (oldest) {
        candidates.delete(oldest[0])
        evictedUntil[bucket(oldest[1].initial)] = Date.now() + lifetime
      }
    }
    candidates.set(id, record)
  }
  browser.webRequest.onBeforeRequest.addListener((d) => {
    if (candidates.has(d.requestId)) return
    const context = d as typeof d & { documentUrl?: string; originUrl?: string }
    const source = context.documentUrl ?? context.originUrl ?? d.initiator
    remember(d.requestId, {
      tabId: d.tabId,
      initial: d.url,
      final: d.url,
      time: 0,
      source,
      hops: [d.url],
      blocked:
        d.method !== 'GET' ||
        (d.tabId < 0 && !source?.match(/^https?:\/\//i)) ||
        !!source?.match(/^(chrome|moz|safari-web)-extension:/i),
    })
  }, filter)
  browser.webRequest.onBeforeRedirect.addListener((d) => {
    const r = candidates.get(d.requestId)
    if (r) {
      r.final = d.redirectUrl
      r.hops.push(d.redirectUrl)
    } else {
      // Joining a redirect mid-flight cannot establish its original method or source.
      remember(d.requestId, {
        tabId: d.tabId,
        initial: d.url,
        final: d.redirectUrl,
        time: 0,
        hops: [d.url, d.redirectUrl],
        blocked: true,
      })
    }
  }, filter)
  const completed = ({ requestId }: { requestId: string }) => {
    const r = candidates.get(requestId)
    if (r) r.time = Date.now()
  }
  browser.webRequest.onCompleted.addListener(completed, filter)
  browser.webRequest.onErrorOccurred.addListener(completed, filter)
  browser.webRequest.onHeadersReceived.addListener(
    (d) => {
      const r = candidates.get(d.requestId)
      if (!r) {
        // An evicted export can finish much later than the cache window.
        // Its DownloadItem must not borrow evidence from a newer same-URL GET.
        evictedUntil[bucket(d.url)] = Date.now() + lifetime
        return
      }
      if (r.final !== d.url || d.statusCode !== 200 || d.method !== 'GET')
        return
      const header = (name: string) =>
        d.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value
      const size = Number(header('content-length'))
      r.time = Date.now()
      r.response = {
        allowed: () =>
          !protectedUrl('source', r.source) &&
          r.hops.every((url) => !protectedUrl('resource', url)),
        ...(r.tabId >= 0 ? { tabId: r.tabId } : {}),
        url: r.initial,
        source: r.source,
        filename: contentDispositionFilename(
          d.responseHeaders,
          getBuildBrowser() === 'firefox'
        ),
        size: size > 0 ? size : undefined,
        mime: header('content-type'),
      }
      for (const notify of waiting.get(d.requestId) ?? []) notify()
    },
    filter,
    ['responseHeaders']
  )
  const lookup = (item: ReplayItem): ReplaySource | null => {
    prune()
    if (
      !item.requestId &&
      [item.url, item.finalUrl].some(
        (url) => url && (evictedUntil[bucket(url)] ?? 0) > Date.now()
      )
    )
      return null
    // A signed landing URL opened independently must not inherit a previous
    // navigation's replay permission. Firefox response events have a request ID;
    // DownloadItem events must match the original URL of the observed request.
    const matches = item.requestId
      ? [candidates.get(item.requestId)].filter((r) => r?.final === item.url)
      : [...candidates.values()].filter(
          (r) =>
            r.initial === item.url &&
            (r.downloadId === undefined || r.downloadId === item.id) &&
            (!item.finalUrl || r.final === item.finalUrl)
        )
    const [r] = matches
    if (
      matches.length !== 1 ||
      !r?.response ||
      r.blocked ||
      protectedUrl('source', item.referrer) ||
      !r.response.allowed()
    )
      return null
    // Keep live protection updates effective even after the request cache expires.
    if (item.id !== undefined) r.downloadId = item.id
    const response = r.response
    return {
      ...response,
      allowed: () =>
        response.allowed() && !protectedUrl('source', item.referrer),
    }
  }
  // Firefox can deliver onCreated between onBeforeRequest and onHeadersReceived.
  // Only wait for one already recognized request, without pausing or probing it.
  async function waitForResponse(
    item: ReplayItem
  ): Promise<ReplaySource | null> {
    const immediate = lookup(item)
    if (immediate) return immediate
    const matching = [...candidates].filter(
      ([, r]) =>
        r.initial === item.url &&
        (r.downloadId === undefined || r.downloadId === item.id) &&
        (!item.finalUrl || r.final === item.finalUrl)
    )
    const entry = matching[0]
    if (
      matching.length !== 1 ||
      !entry ||
      entry[1].blocked ||
      entry[1].response
    )
      return null
    const [id] = entry
    return new Promise((resolve) => {
      const set = waiting.get(id) ?? new Set()
      const finish = () => {
        clearTimeout(timer)
        set.delete(finish)
        if (!set.size) waiting.delete(id)
        resolve(lookup(item))
      }
      const timer = setTimeout(finish, 500)
      set.add(finish)
      waiting.set(id, set)
    })
  }
  return Object.assign(lookup, { waitForResponse })
}
