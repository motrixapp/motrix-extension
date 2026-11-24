import { contentDispositionFilename } from '@/background/capture/contentDisposition'
import { isHtmlType } from '@/background/capture/replayFidelity'
import { type Browser, extensionBrowser as browser } from '@/shared/browser'
import { getBuildBrowser } from '@/shared/browserKind'

type Protected = ((role: 'source' | 'resource', url?: string) => boolean) & {
  ready?: Promise<void>
}
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
  referer?: string | undefined
  /** True when onSendHeaders observed the selected hop without a Referer header. */
  omitReferer?: boolean | undefined
  filename?: string | undefined
  size?: number | undefined
  mime?: string | undefined
  /** Safe to cancel in Firefox onHeadersReceived before probing. */
  earlySafe?: boolean | undefined
  /** Synthesized from DownloadItem when no webRequest record is in memory. */
  fallback?: boolean | undefined
  allowed: () => boolean
}

export type ReplayLookup = ((item: ReplayItem) => ReplaySource | null) & {
  ready?: Promise<void>
  waitForResponse?: (item: ReplayItem) => Promise<ReplaySource | null>
}

const oneTimeParameters = new Set(['onetimetoken'])
const dynamicCredentialParameters = new Set([
  'accesstoken',
  'authkey',
  'authtoken',
  'downloadtoken',
  'ossaccesskeyid',
  'qsignature',
  'securitytoken',
  'sig',
  'sign',
  'signature',
  'tempurlsig',
  'ticket',
  'token',
  'xamzcredential',
  'xamzsecuritytoken',
  'xamzsignature',
  'xcossignature',
  'xgoogsignature',
  'xobssignature',
  'xosssecuritytoken',
  'xosssignature',
])

function normalizeParam(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, '')
}

function hasHardBlockedCredentials(address: string): boolean {
  try {
    const url = new URL(address)
    if (url.username || url.password) return true
    for (const [name, value] of url.searchParams) {
      if (value && oneTimeParameters.has(normalizeParam(name))) return true
    }
    return false
  } catch {
    return true
  }
}

function hasDynamicCredentials(address: string): boolean {
  try {
    const url = new URL(address)
    for (const [name, value] of url.searchParams) {
      if (value && dynamicCredentialParameters.has(normalizeParam(name)))
        return true
    }
    return false
  } catch {
    return false
  }
}

function sameCookieScope(initial: string, current: string): boolean {
  try {
    const source = new URL(initial)
    const hop = new URL(current)
    return source.origin === hop.origin && source.pathname === hop.pathname
  } catch {
    return false
  }
}

function stripHash(url: string): string {
  const hash = url.indexOf('#')
  return hash === -1 ? url : url.slice(0, hash)
}

// A URL-only DownloadItem cannot disambiguate an evicted blocked request.
// Remember its hash bucket briefly so late responses cannot borrow a newer GET.
function bucket(url: string) {
  let hash = 0
  for (let i = 0; i < url.length; i++)
    hash = (Math.imul(hash, 31) + url.charCodeAt(i)) | 0
  return hash & 2047
}

export function observeReplaySources(protectedUrl: Protected): ReplayLookup {
  type Record = {
    tabId: number
    initialMethod: string
    initial: string
    final: string
    source?: string | undefined
    initialReferer?: string | undefined
    initialRefererObserved?: boolean
    finalReferer?: string | undefined
    finalRefererObserved?: boolean
    time: number
    response?: ReplaySource
    htmlDocument?: boolean
    reloadedFromHtml?: boolean
    sentCookie?: boolean
    crossScopeCookie?: boolean
    cookieSpecific?: boolean
    hasDynamicCredentials?: boolean
    blocked: boolean
    hops: string[]
    downloadId?: number
  }
  const waiting = new Map<string, Set<() => void>>()
  const candidates = new Map<string, Record>()
  const evictedBlockedUntil = new Float64Array(2048)
  const lifetime = 60_000
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
    if (!record.blocked && record.tabId >= 0) {
      for (const previous of candidates.values()) {
        if (
          previous.htmlDocument &&
          previous.tabId === record.tabId &&
          previous.final === record.initial
        ) {
          record.reloadedFromHtml = true
          break
        }
      }
    }
    if (candidates.size >= 512) {
      const oldest = candidates.entries().next().value
      if (oldest) {
        candidates.delete(oldest[0])
        if (
          oldest[1].blocked ||
          (!oldest[1].response && oldest[1].initialMethod !== 'GET')
        ) {
          evictedBlockedUntil[bucket(oldest[1].initial)] = Date.now() + lifetime
          evictedBlockedUntil[bucket(oldest[1].final)] = Date.now() + lifetime
        }
      }
    }
    candidates.set(id, record)
  }
  const notifyWaiting = (requestId: string) => {
    for (const notify of waiting.get(requestId) ?? []) notify()
  }
  const selfExtensionId = (() => {
    try {
      return browser.runtime?.id || undefined
    } catch {
      return undefined
    }
  })()
  const extensionOrigin = (value: string | undefined): string | undefined => {
    if (!value) return undefined
    try {
      const parsed = new URL(value)
      if (
        !/^(chrome|moz|safari-web)-extension:$/i.test(parsed.protocol) ||
        !parsed.host
      )
        return undefined
      return `${parsed.protocol}//${parsed.host}`.toLowerCase()
    } catch {
      return undefined
    }
  }
  const selfExtensionOrigin = (() => {
    try {
      return extensionOrigin(browser.runtime?.getURL?.(''))
    } catch {
      return undefined
    }
  })()
  const isSelfExtensionSource = (source: string | undefined): boolean => {
    if (!selfExtensionOrigin) return false
    const origin = extensionOrigin(source)
    return origin !== undefined && origin === selfExtensionOrigin
  }
  const requestSource = (d: {
    initiator?: string | undefined
    documentUrl?: string | undefined
    originUrl?: string | undefined
  }) => d.documentUrl ?? d.originUrl ?? d.initiator
  browser.webRequest.onBeforeRequest.addListener((d) => {
    if (candidates.has(d.requestId)) return
    const url = stripHash(d.url)
    const source = requestSource(
      d as typeof d & { documentUrl?: string; originUrl?: string }
    )
    // Ignore our own extension-initiated requests (e.g. fallback/browser-choice
    // downloads); isEligibleDownload already excludes their DownloadItems, and
    // keeping them in candidates would poison a user's retry of the same URL.
    if (isSelfExtensionSource(source)) return
    remember(d.requestId, {
      tabId: d.tabId,
      initialMethod: d.method,
      initial: url,
      final: url,
      time: 0,
      source,
      hops: [url],
      hasDynamicCredentials: hasDynamicCredentials(url),
      blocked:
        hasHardBlockedCredentials(url) ||
        (d.tabId < 0 && !source?.match(/^https?:\/\//i)) ||
        !!source?.match(/^(chrome|moz|safari-web)-extension:/i),
    })
  }, filter)
  const browserKind = getBuildBrowser()
  browser.webRequest.onSendHeaders.addListener(
    (d) => {
      const record = candidates.get(d.requestId)
      if (!record || record.blocked) return
      let sentCookie = false
      let sentReferer: string | undefined
      for (const { name, value } of d.requestHeaders ?? []) {
        switch (name.toLowerCase()) {
          case 'authorization':
            record.blocked = true
            notifyWaiting(d.requestId)
            return
          case 'cookie':
            sentCookie = true
            break
          case 'referer':
            if (value) sentReferer = value
            break
        }
      }
      // Track Referer per hop so no-referrer redirects never leak an earlier hop's Referer.
      if (record.hops.length === 1) {
        record.initialReferer = sentReferer
        record.initialRefererObserved = true
      }
      record.finalReferer = sentReferer
      record.finalRefererObserved = true
      if (sentCookie) {
        record.sentCookie = true
        if (!sameCookieScope(record.initial, stripHash(d.url)))
          record.crossScopeCookie = true
      }
    },
    filter,
    browserKind === 'chromium'
      ? ['requestHeaders', 'extraHeaders']
      : ['requestHeaders']
  )
  browser.webRequest.onBeforeRedirect.addListener((d) => {
    const r = candidates.get(d.requestId)
    const fromUrl = stripHash(d.url)
    const redirectUrl = stripHash(d.redirectUrl)
    if (r) {
      r.final = redirectUrl
      r.hops.push(redirectUrl)
      // Clear previous hop's Referer so a cached next hop cannot inherit it.
      r.finalReferer = undefined
      r.finalRefererObserved = false
      if (hasHardBlockedCredentials(redirectUrl)) r.blocked = true
    } else {
      // Joining a redirect mid-flight cannot establish its original method.
      const source = requestSource(
        d as typeof d & { documentUrl?: string; originUrl?: string }
      )
      if (isSelfExtensionSource(source)) return
      remember(d.requestId, {
        tabId: d.tabId,
        initialMethod: 'UNKNOWN',
        initial: fromUrl,
        final: redirectUrl,
        time: 0,
        source,
        hops: [fromUrl, redirectUrl],
        blocked:
          hasHardBlockedCredentials(fromUrl) ||
          hasHardBlockedCredentials(redirectUrl) ||
          (d.tabId < 0 && !source?.match(/^https?:\/\//i)) ||
          !!source?.match(/^(chrome|moz|safari-web)-extension:/i),
      })
    }
  }, filter)
  const completed = ({ requestId }: { requestId: string }) => {
    const r = candidates.get(requestId)
    if (r) r.time = Date.now()
    notifyWaiting(requestId)
  }
  browser.webRequest.onCompleted.addListener(completed, filter)
  browser.webRequest.onErrorOccurred.addListener(completed, filter)
  // Claim background requests generated by our own downloads.download() calls
  // (Chromium may omit initiator on them) so they cannot poison later retries.
  if (selfExtensionId) {
    browser.downloads?.onCreated?.addListener((item) => {
      if (item.byExtensionId !== selfExtensionId) return
      const itemUrl = stripHash(item.url)
      const itemFinalUrl = item.finalUrl ? stripHash(item.finalUrl) : undefined
      for (const r of candidates.values()) {
        if (
          r.blocked &&
          r.downloadId === undefined &&
          r.tabId < 0 &&
          !r.source?.match(/^https?:\/\//i) &&
          (r.initial === itemUrl ||
            r.final === itemUrl ||
            (itemFinalUrl !== undefined && r.final === itemFinalUrl))
        ) {
          r.downloadId = item.id
          break
        }
      }
    })
  }
  browser.webRequest.onHeadersReceived.addListener(
    (d) => {
      const url = stripHash(d.url)
      const r = candidates.get(d.requestId)
      if (!r) {
        if (d.method !== 'GET')
          evictedBlockedUntil[bucket(url)] = Date.now() + lifetime
        return
      }
      if (r.final !== url) return
      if (r.blocked) {
        notifyWaiting(d.requestId)
        return
      }
      // Chromium does not always expose the Authorization request header.
      if (d.statusCode === 401 || d.statusCode === 407) {
        r.blocked = true
        notifyWaiting(d.requestId)
        return
      }
      const header = (name: string) =>
        d.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value
      const vary = (d.responseHeaders ?? [])
        .filter((h) => h.name.toLowerCase() === 'vary')
        .flatMap((h) => (h.value ?? '').toLowerCase().split(','))
        .map((name) => name.trim())
      if (vary.includes('authorization')) {
        r.blocked = true
        notifyWaiting(d.requestId)
        return
      }
      if (r.sentCookie && vary.includes('cookie')) r.cookieSpecific = true
      // Ignore intermediate 1xx/3xx responses before checking the final response method,
      // so POST -> 302/303 -> GET redirects are not prematurely blocked on hop 1.
      if (d.statusCode !== 200 && d.statusCode !== 206) {
        if (d.statusCode >= 400) notifyWaiting(d.requestId)
        return
      }
      if (d.method !== 'GET') {
        r.blocked = true
        notifyWaiting(d.requestId)
        return
      }
      const size = Number(header('content-length'))
      const mime = header('content-type')
      r.time = Date.now()
      if (
        (d.type === 'main_frame' || d.type === 'sub_frame') &&
        mime &&
        isHtmlType(mime)
      ) {
        const disposition = header('content-disposition')
          ?.split(';')[0]
          ?.trim()
          .toLowerCase()
        r.htmlDocument = !disposition || disposition === 'inline'
      }
      // If the same URL already served an HTML page in this tab and did not
      // redirect to a separate file URL, replaying it as GET is unsafe.
      if (r.reloadedFromHtml && r.final === r.initial) {
        r.blocked = true
        notifyWaiting(d.requestId)
        return
      }
      // Submit the stable entry URL only when it is a clean, self-contained GET.
      // Otherwise submit the post-redirect file URL so Motrix receives the
      // actual signed/CDN URL along with cookies scoped to that final host/path.
      const useInitial =
        r.initialMethod === 'GET' &&
        !r.crossScopeCookie &&
        !r.reloadedFromHtml &&
        !r.hasDynamicCredentials
      const targetUrl = useInitial ? r.initial : r.final
      const referer = useInitial ? r.initialReferer : r.finalReferer
      const refererObserved = useInitial
        ? r.initialRefererObserved
        : r.finalRefererObserved
      const earlySafe =
        useInitial && !r.cookieSpecific && !r.sentCookie && d.statusCode === 200
      r.response = {
        allowed: () =>
          !r.blocked &&
          !protectedUrl('source', r.source) &&
          r.hops.every((hopUrl) => !protectedUrl('resource', hopUrl)),
        ...(r.tabId >= 0 ? { tabId: r.tabId } : {}),
        url: targetUrl,
        source: r.source,
        referer,
        ...(refererObserved && !referer ? { omitReferer: true } : {}),
        filename: contentDispositionFilename(
          d.responseHeaders,
          browserKind === 'firefox'
        ),
        size: size > 0 ? size : undefined,
        mime,
        earlySafe,
      }
      notifyWaiting(d.requestId)
    },
    filter,
    ['responseHeaders']
  )

  const resolveItemUrl = (item: ReplayItem): string =>
    stripHash(
      item.finalUrl && item.finalUrl.length > 0 ? item.finalUrl : item.url
    )

  const isEvictedBlocked = (item: ReplayItem): boolean =>
    !item.requestId &&
    [item.url, item.finalUrl].some(
      (url) =>
        url && (evictedBlockedUntil[bucket(stripHash(url))] ?? 0) > Date.now()
    )

  const hasBlockedCandidate = (
    itemUrl: string,
    itemFinalUrl?: string,
    itemId?: number
  ): boolean => {
    for (const r of candidates.values()) {
      if (!r.blocked) continue
      if (r.downloadId !== undefined && r.downloadId !== itemId) continue
      if (
        r.initial === itemUrl ||
        r.final === itemUrl ||
        (itemFinalUrl !== undefined &&
          (r.initial === itemFinalUrl || r.final === itemFinalUrl))
      )
        return true
    }
    return false
  }

  const matchItem = (item: ReplayItem): [string, Record][] => {
    const itemUrl = stripHash(item.url)
    const itemFinalUrl = item.finalUrl ? stripHash(item.finalUrl) : undefined
    if (item.requestId) {
      const r = candidates.get(item.requestId)
      return r && r.final === itemUrl ? [[item.requestId, r]] : []
    }
    const direct = [...candidates].filter(
      ([, r]) =>
        !r.htmlDocument &&
        r.initial === itemUrl &&
        (r.downloadId === undefined || r.downloadId === item.id) &&
        (!itemFinalUrl || r.final === itemFinalUrl)
    )
    if (direct.length > 0) return direct
    // Firefox DownloadItems expose only the post-redirect URL (no finalUrl field).
    // Never borrow an unrelated redirect chain when Chromium already supplied finalUrl.
    if (itemFinalUrl) return []
    return [...candidates].filter(
      ([, r]) =>
        !r.htmlDocument &&
        r.final === itemUrl &&
        (r.downloadId === undefined || r.downloadId === item.id)
    )
  }

  const fallbackSource = (item: ReplayItem): ReplaySource | null => {
    const url = resolveItemUrl(item)
    if (
      hasHardBlockedCredentials(item.url) ||
      hasHardBlockedCredentials(url) ||
      protectedUrl('source', item.referrer) ||
      protectedUrl('resource', item.url) ||
      (item.finalUrl && protectedUrl('resource', item.finalUrl))
    )
      return null
    return {
      url,
      source: item.referrer || undefined,
      earlySafe: false,
      fallback: true,
      allowed: () =>
        !protectedUrl('source', item.referrer) &&
        !protectedUrl('resource', item.url) &&
        (!item.finalUrl || !protectedUrl('resource', item.finalUrl)),
    }
  }

  const selectMatch = (
    matches: [string, Record][]
  ): [string, Record] | null => {
    if (matches.length === 1) return matches[0] ?? null
    if (matches.length === 0) return null
    // Multiple records for the same URL are safe to disambiguate only when
    // every candidate is a completed, non-blocked response agreeing on the
    // exact target URL (e.g. a user retrying a link downloaded while takeover
    // was off or after early cancellation). Any blocked or in-flight request
    // keeps the lookup conservatively ambiguous.
    const latest = matches[matches.length - 1]
    const targetUrl = latest?.[1].response?.url
    if (!latest || !targetUrl) return null
    for (const [, r] of matches) {
      if (
        r.blocked ||
        !r.response ||
        r.response.url !== targetUrl ||
        !r.response.allowed()
      )
        return null
    }
    return latest
  }

  const lookup = (item: ReplayItem): ReplaySource | null => {
    prune()
    if (isEvictedBlocked(item)) return null
    const matches = matchItem(item)
    if (matches.length === 0) {
      if (item.requestId) return null
      const itemUrl = stripHash(item.url)
      const itemFinalUrl = item.finalUrl ? stripHash(item.finalUrl) : undefined
      if (hasBlockedCandidate(itemUrl, itemFinalUrl, item.id)) return null
      return fallbackSource(item)
    }
    const match = selectMatch(matches)
    if (!match) return null
    const [, r] = match
    if (
      r.blocked ||
      !r.response ||
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

  // Firefox (and occasionally Chromium) can deliver onCreated before
  // onHeadersReceived settles. Wait briefly for a matching in-flight request.
  async function waitForResponse(
    item: ReplayItem
  ): Promise<ReplaySource | null> {
    if (protectedUrl.ready) await protectedUrl.ready
    const immediate = lookup(item)
    if (immediate) return immediate
    if (isEvictedBlocked(item)) return null
    const matching = matchItem(item)
    if (matching.some(([, r]) => r.blocked)) return null
    const pending = matching.filter(([, r]) => !r.response)
    const entry = pending[0]
    if (pending.length !== 1 || !entry) return null
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
  return Object.assign(lookup, {
    ...(protectedUrl.ready ? { ready: protectedUrl.ready } : {}),
    waitForResponse,
  })
}
