import { contentDispositionFilename } from '@/background/capture/contentDisposition'
import { extensionBrowser as browser } from '@/shared/browser'
import { getBuildBrowser } from '@/shared/browserKind'
import { publicRelease } from '@/shared/releaseClick'

type Protected = (role: 'source' | 'resource', url?: string) => boolean
export interface ReplayItem {
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

export function observeReplaySources(
  protectedUrl: Protected,
  trusted = publicRelease
) {
  type Record = {
    tabId: number
    initial: string
    final: string
    source?: string | undefined
    time: number
    response?: ReplaySource
    blocked: boolean
  }
  const waiting = new Map<string, Set<() => void>>()
  const candidates = new Map<string, Record>()
  const redirected = new Map<string, number>()
  let ambiguousUntil = 0
  const filter = { urls: ['http://*/*', 'https://*/*'] }
  const prune = () => {
    const cutoff = Date.now() - 30_000
    for (const [id, r] of candidates) if (r.time < cutoff) candidates.delete(id)
    for (const [id, t] of redirected) if (t < cutoff) redirected.delete(id)
  }
  browser.webRequest.onBeforeRequest.addListener((d) => {
    if (!trusted(d.url) || candidates.has(d.requestId)) return
    prune()
    if (candidates.size >= 256) {
      ambiguousUntil = Date.now() + 30_000
      return
    }
    const unsuitable =
      redirected.has(d.requestId) ||
      d.method !== 'GET' ||
      !['main_frame', 'sub_frame', 'other'].includes(d.type)
    const context = d as typeof d & { documentUrl?: string; originUrl?: string }
    const source = context.documentUrl ?? context.originUrl ?? d.initiator
    candidates.set(d.requestId, {
      tabId: d.tabId,
      initial: d.url,
      final: d.url,
      time: Date.now(),
      source,
      blocked:
        unsuitable ||
        d.tabId < 0 ||
        !!source?.startsWith('chrome-extension://') ||
        !!source?.startsWith('moz-extension://') ||
        protectedUrl('source', source) ||
        protectedUrl('resource', d.url),
    })
  }, filter)
  browser.webRequest.onBeforeRedirect.addListener((d) => {
    const r = candidates.get(d.requestId)
    if (r) {
      r.final = d.redirectUrl
      r.blocked ||= protectedUrl('resource', d.redirectUrl)
    } else if (trusted(d.redirectUrl)) {
      prune()
      if (redirected.size >= 256) {
        ambiguousUntil = Date.now() + 30_000
        return
      }
      redirected.set(d.requestId, Date.now())
    }
  }, filter)
  browser.webRequest.onHeadersReceived.addListener(
    (d) => {
      const r = candidates.get(d.requestId)
      if (!r || r.final !== d.url || d.statusCode !== 200 || d.method !== 'GET')
        return
      const header = (name: string) =>
        d.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value
      const size = Number(header('content-length'))
      r.response = {
        allowed: () =>
          !protectedUrl('source', r.source) &&
          !protectedUrl('resource', r.initial) &&
          !protectedUrl('resource', r.final),
        tabId: r.tabId,
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
    if (Date.now() < ambiguousUntil) return null
    // A signed landing URL opened independently must not inherit a previous
    // navigation's replay permission. Firefox response events have a request ID;
    // DownloadItem events may claim only the original public URL.
    const matches = item.requestId
      ? [candidates.get(item.requestId)].filter((r) => r?.final === item.url)
      : [...candidates.values()].filter(
          (r) =>
            r.initial === item.url &&
            (!item.finalUrl || r.final === item.finalUrl)
        )
    const [r] = matches
    if (
      matches.length !== 1 ||
      !r?.response ||
      r.blocked ||
      protectedUrl('source', item.referrer) ||
      protectedUrl('source', r.source) ||
      protectedUrl('resource', r.initial) ||
      protectedUrl('resource', r.final)
    )
      return null
    // Keep live protection updates effective even after the request cache expires.
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
        r.initial === item.url && (!item.finalUrl || r.final === item.finalUrl)
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
