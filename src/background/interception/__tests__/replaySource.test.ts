import { expect, it, vi } from 'vitest'
import { observeReplaySources } from '@/background/interception/replaySource'
import { extensionBrowser as browser } from '@/shared/browser'

const stable =
  'https://github.com/agalwood/Motrix/releases/download/v2.4.3/Motrix-2.4.3.dmg'
const signed = 'https://release-assets.githubusercontent.com/file?token=one-use'
function setup() {
  const before = { addListener: vi.fn() },
    redirect = { addListener: vi.fn() },
    sent = { addListener: vi.fn() },
    headers = { addListener: vi.fn() }
  Object.assign(browser, {
    webRequest: {
      onBeforeRequest: before,
      onBeforeRedirect: redirect,
      onSendHeaders: sent,
      onHeadersReceived: headers,
      onCompleted: { addListener: vi.fn() },
      onErrorOccurred: { addListener: vi.fn() },
    },
  })
  const protectedUrl = vi.fn(
    (_role: 'source' | 'resource', _url?: string) => false
  )
  const lookup = observeReplaySources(protectedUrl)
  const request = (
    id: string,
    url: string,
    method = 'GET',
    initiator?: string,
    tabId = 4
  ) =>
    before.addListener.mock.calls[0]?.[0]({
      requestId: id,
      url,
      method,
      initiator,
      type: 'main_frame',
      tabId,
    })
  const hop = (id: string, url: string, redirectUrl: string) =>
    redirect.addListener.mock.calls[0]?.[0]({
      requestId: id,
      url,
      redirectUrl,
      tabId: 4,
    })
  const sendHeaders = (
    id: string,
    url: string,
    ...headersList: (string | { name: string; value: string })[]
  ) =>
    sent.addListener.mock.calls[0]?.[0]({
      requestId: id,
      url,
      requestHeaders: headersList.map((entry) =>
        typeof entry === 'string' ? { name: entry, value: 'fixture' } : entry
      ),
    })
  const response = (
    id: string,
    url: string,
    responseHeaders: Record<string, string> = {},
    statusCode = 200,
    method = 'GET'
  ) =>
    headers.addListener.mock.calls[0]?.[0]({
      requestId: id,
      url,
      method,
      type: 'main_frame',
      statusCode,
      responseHeaders: Object.entries(responseHeaders).map(([name, value]) => ({
        name,
        value,
      })),
    })
  return { lookup, request, hop, sendHeaders, response, protectedUrl }
}

it('submits the stable release URL as early-safe and hands off standalone signed URLs via non-early replay', () => {
  const s = setup()
  s.request('1', stable)
  s.hop('1', stable, signed)
  s.response('1', signed)
  const source = s.lookup({ url: stable, finalUrl: signed })
  expect(source?.url).toBe(stable)
  expect(source?.earlySafe).toBe(true)

  s.request('standalone', signed)
  s.response('standalone', signed)
  const standalone = s.lookup({ url: signed })
  expect(standalone?.url).toBe(signed)
  expect(standalone?.earlySafe).toBe(false)
  expect(s.lookup({ requestId: '1', url: signed })?.url).toBe(stable)

  s.protectedUrl.mockReturnValue(true)
  expect(source?.allowed()).toBe(false)
})

it('leaves ambiguous concurrent requests and bare POST responses in the browser', () => {
  const s = setup()
  s.request('ok', stable)
  s.response('ok', stable)
  s.request('post', stable, 'POST')
  expect(s.lookup({ url: stable })).toBeNull()

  const postUrl = 'https://uupdump.net/get.php?id=abc'
  s.request('bare-post', postUrl, 'POST')
  s.response('bare-post', postUrl, {}, 200, 'POST')
  expect(s.lookup({ url: postUrl })).toBeNull()
})

it('waits for late headers and falls back cleanly when no webRequest record exists', async () => {
  const s = setup()
  const cold = await s.lookup.waitForResponse({
    url: 'https://cloud.example/cold.zip',
    finalUrl: 'https://cdn.cloud.example/cold.zip?signature=abc',
  })
  expect(cold?.url).toBe('https://cdn.cloud.example/cold.zip?signature=abc')
  expect(cold?.fallback).toBe(true)
  expect(cold?.earlySafe).toBe(false)

  s.request('late', stable)
  const evidence = s.lookup.waitForResponse({ url: stable })
  s.response('late', stable)
  expect((await evidence)?.url).toBe(stable)
})

it('recognizes an observed third-party GET with ordinary query parameters and captures Referer', () => {
  const s = setup()
  const url = 'https://downloads.example.org/export?id=42'
  s.request('third-party', url)
  s.sendHeaders('third-party', url, 'Cookie', {
    name: 'Referer',
    value: 'https://pan.example.org/share/123',
  })
  s.response('third-party', url)
  const source = s.lookup({ url })
  expect(source?.url).toBe(url)
  expect(source?.referer).toBe('https://pan.example.org/share/123')
  expect(source?.earlySafe).toBe(false)
})

it('uses the redirected final URL after an HTML page reloads in the same tab, but blocks same-URL HTML collisions', async () => {
  const s = setup()
  const initial = 'https://downloads.example/file/?id=123'
  const final = 'https://cdn.example/file.zip'
  s.request('page', initial)
  s.response('page', initial, { 'Content-Type': 'Text/HTML; charset=utf-8' })

  s.request('reload-redirect', initial)
  s.hop('reload-redirect', initial, final)
  s.response('reload-redirect', final, { 'Content-Type': 'application/zip' })
  const redirected = s.lookup({ id: 1, url: initial, finalUrl: final })
  expect(redirected?.url).toBe(final)
  expect(redirected?.earlySafe).toBe(false)

  const sameUrl = 'https://downloads.example/same-page'
  s.request('html', sameUrl)
  s.response('html', sameUrl, { 'Content-Type': 'text/html' })
  s.request('same-download', sameUrl)
  s.response('same-download', sameUrl, { 'Content-Type': 'application/zip' })
  expect(s.lookup({ id: 2, url: sameUrl })).toBeNull()
  expect(await s.lookup.waitForResponse({ id: 2, url: sameUrl })).toBeNull()
})

it.each([
  { disposition: 'attachment; filename="page.html"', tabId: 4 },
  { disposition: 'inline', tabId: 9 },
])(
  'still allows redirected GETs with stable initial URL after an HTML attachment or another tab',
  ({ disposition, tabId }) => {
    const s = setup()
    const initial = 'https://downloads.example/file/?id=123'
    const final = 'https://cdn.example/file.zip'
    s.request('page', initial, 'GET', undefined, tabId)
    s.response('page', initial, {
      'Content-Type': 'text/html',
      'Content-Disposition': disposition,
    })
    s.request('file', initial)
    s.hop('file', initial, final)
    s.response('file', final, { 'Content-Type': 'application/zip' })

    expect(s.lookup({ id: 1, url: initial, finalUrl: final })?.url).toBe(
      initial
    )
  }
)

it.each([
  '?X-Amz-Signature=abcdef',
  '?download_token=abcdef',
  '?signature=abcdef',
  '?ticket=abcdef',
  '?auth_key=1700000000-0-0-deadbeef',
  '?x-oss-signature=abcdef',
  '?q-signature=abcdef',
  '?sign=abcdef',
])('allows cloud-drive presigned URLs via non-early handoff (%s)', (query) => {
  const s = setup()
  const url = `https://downloads.example/file.zip${query}`
  s.request('file', url)
  s.response('file', url)
  const source = s.lookup({ url })
  expect(source?.url).toBe(url)
  expect(source?.earlySafe).toBe(false)
  expect(s.lookup({ requestId: 'file', url })?.earlySafe).toBe(false)
})

it.each([
  'https://downloads.example/file.zip?oneTimeToken=abcdef',
  'https://user:pass@downloads.example/file.zip',
])('still blocks explicit one-time or embedded-credential URLs (%s)', (url) => {
  const s = setup()
  s.request('file', url)
  s.response('file', url)
  expect(s.lookup({ url })).toBeNull()
  expect(s.lookup({ requestId: 'file', url })).toBeNull()
})

it.each([
  'https://cdn.example/file.zip',
  'https://downloads.example/private/file.zip',
])(
  'submits the final URL for redirects with cookies outside the entry URL scope (%s)',
  (final) => {
    const s = setup()
    const initial = 'https://downloads.example/export'
    s.request('file', initial)
    s.sendHeaders('file', initial)
    s.hop('file', initial, final)
    s.sendHeaders('file', final, 'Cookie')
    s.response('file', final)
    const source = s.lookup({ url: initial, finalUrl: final })
    expect(source?.url).toBe(final)
    expect(source?.earlySafe).toBe(false)
    expect(s.lookup({ requestId: 'file', url: final })?.url).toBe(final)
  }
)

it('keeps a redirect that only changes the query eligible with same-scope cookies', () => {
  const s = setup()
  const initial = 'https://downloads.example/export?id=42'
  const final = 'https://downloads.example/export?id=42&format=zip'
  s.request('file', initial)
  s.hop('file', initial, final)
  s.sendHeaders('file', final, 'Cookie')
  s.response('file', final)
  expect(s.lookup({ url: initial, finalUrl: final })?.url).toBe(initial)
})

it.each(['authorization header', 'authentication challenge'])(
  'keeps a download with browser-only auth in the browser (%s)',
  (signal) => {
    const s = setup()
    const url = 'https://downloads.example/file.zip'
    s.request('file', url)
    if (signal === 'authorization header')
      s.sendHeaders('file', url, 'Authorization')
    if (signal === 'authentication challenge') s.response('file', url, {}, 401)
    s.response('file', url)
    expect(s.lookup({ url })).toBeNull()
    expect(s.lookup({ requestId: 'file', url })).toBeNull()
  }
)

it('allows cookie-authenticated Vary: Cookie and 206 responses via non-early handoff', () => {
  const s = setup()
  const url = 'https://drive.example/file.zip'
  s.request('file', url)
  s.sendHeaders('file', url, 'Cookie')
  s.response('file', url, { Vary: 'Accept-Encoding, Cookie' }, 206)
  const source = s.lookup({ url })
  expect(source?.url).toBe(url)
  expect(source?.earlySafe).toBe(false)
})

it('hands off the final GET URL when a POST export redirects to GET, including intermediate 303 headers', () => {
  const s = setup()
  const initial = 'https://downloads.example/export'
  const final = 'https://cdn.example/file.zip?sig=xyz'
  s.request('export', initial, 'POST')
  s.response('export', initial, { Location: final }, 303, 'POST')
  s.hop('export', initial, final)
  s.response('export', final, {}, 200, 'GET')
  const source = s.lookup({ url: initial, finalUrl: final })
  expect(source?.url).toBe(final)
  expect(source?.earlySafe).toBe(false)
})

it('does not leak an earlier hop Referer when the final redirect omits Referer', () => {
  const s = setup()
  const initial = 'https://pan.example/api/download'
  const final = 'https://cdn.thirdparty.example/file.zip'
  s.request('ref', initial)
  s.sendHeaders('ref', initial, 'Cookie', {
    name: 'Referer',
    value: 'https://pan.example/private-secret-link',
  })
  s.hop('ref', initial, final)
  s.sendHeaders('ref', final, 'Cookie')
  s.response('ref', final)
  const source = s.lookup({ url: initial, finalUrl: final })
  expect(source?.url).toBe(final)
  expect(source?.referer).toBeUndefined()
  expect(source?.omitReferer).toBe(true)

  // A cached redirect hop that skips onSendHeaders must not inherit hop 1's Referer either.
  const tokenInitial = 'https://pan.example/api/download?token=abc'
  const cachedFinal = 'https://cdn.thirdparty.example/cached.zip'
  s.request('cached-ref', tokenInitial)
  s.sendHeaders('cached-ref', tokenInitial, 'Cookie', {
    name: 'Referer',
    value: 'https://pan.example/private-secret-link',
  })
  s.hop('cached-ref', tokenInitial, cachedFinal)
  s.response('cached-ref', cachedFinal)
  const cachedSource = s.lookup({ url: tokenInitial, finalUrl: cachedFinal })
  expect(cachedSource?.url).toBe(cachedFinal)
  expect(cachedSource?.referer).toBeUndefined()
  expect(cachedSource?.omitReferer).toBeUndefined()
})

it('does not borrow an unrelated redirect chain when Chromium supplies finalUrl (redirected or direct)', () => {
  const s = setup()
  const otherInitial = 'https://other.example/start'
  const sharedFinal = 'https://cdn.example/shared.zip'
  s.request('other', otherInitial)
  s.hop('other', otherInitial, sharedFinal)
  s.response('other', sharedFinal)
  const redirected = s.lookup({
    url: 'https://different.example/entry',
    finalUrl: sharedFinal,
  })
  expect(redirected?.url).toBe(sharedFinal)
  expect(redirected?.fallback).toBe(true)

  const direct = s.lookup({
    url: sharedFinal,
    finalUrl: sharedFinal,
  })
  expect(direct?.url).toBe(sharedFinal)
  expect(direct?.fallback).toBe(true)
})

it('strips URL fragments when matching and never falls back past an in-memory blocked request', () => {
  const s = setup()
  const base = 'https://downloads.example/archive.zip'
  s.request('auth', base)
  s.sendHeaders('auth', base, 'Authorization')
  s.response('auth', base)
  expect(s.lookup({ url: `${base}#download` })).toBeNull()

  // Even if finalUrl differs from the recorded hop, an in-memory blocked initial request blocks fallback.
  expect(
    s.lookup({
      url: `${base}#download`,
      finalUrl: 'https://cdn.example/other.zip',
    })
  ).toBeNull()

  const okUrl = 'https://downloads.example/public.zip'
  s.request('ok-frag', okUrl)
  s.sendHeaders('ok-frag', okUrl, {
    name: 'Referer',
    value: 'https://downloads.example/page',
  })
  s.response('ok-frag', okUrl, { 'Content-Length': '2048' })
  const matched = s.lookup({
    url: `${okUrl}#section`,
    finalUrl: `${okUrl}#section`,
  })
  expect(matched?.fallback).toBeUndefined()
  expect(matched?.referer).toBe('https://downloads.example/page')
  expect(matched?.size).toBe(2048)
})

it('checks all duplicate Vary response headers and ignores plain HTML page navigations', () => {
  const s = setup()
  const url = 'https://downloads.example/multi-vary.zip'
  s.request('vary', url)
  const headersListener = (
    browser.webRequest.onHeadersReceived.addListener as ReturnType<typeof vi.fn>
  ).mock.calls[0]?.[0]
  headersListener({
    requestId: 'vary',
    url,
    method: 'GET',
    type: 'main_frame',
    statusCode: 200,
    responseHeaders: [
      { name: 'Vary', value: 'Accept-Encoding' },
      { name: 'Vary', value: 'Authorization' },
    ],
  })
  expect(s.lookup({ url })).toBeNull()

  const pageUrl = 'https://downloads.example/landing'
  s.request('landing-page', pageUrl)
  s.response('landing-page', pageUrl, {
    'Content-Type': 'text/html',
    'Content-Length': '999',
  })
  const fallback = s.lookup({ url: pageUrl })
  expect(fallback?.fallback).toBe(true)
  expect(fallback?.size).toBeUndefined()
})

it('does not let an extension-initiated fallback or prior unbound safe GET poison a later retry of the same URL', async () => {
  const onCreated = { addListener: vi.fn() }
  Object.assign(browser, {
    runtime: {
      id: 'self-ext-id',
      getURL: (path: string) => `chrome-extension://self-ext-id/${path}`,
    },
    downloads: { onCreated },
  })
  const s = setup()
  const url = 'https://pan.example/retry.zip'

  // 1. Self-extension request with initiator is ignored.
  s.request('ext-1', url, 'GET', 'chrome-extension://self-ext-id', -1)
  s.response('ext-1', url)

  // 2. Self-extension request with omitted initiator is claimed via downloads.onCreated.
  s.request('ext-2', url, 'GET', undefined, -1)
  s.response('ext-2', url)
  onCreated.addListener.mock.calls[0]?.[0]({
    id: 101,
    url,
    byExtensionId: 'self-ext-id',
  })

  // 3. Prior safe GET whose downloadId was never claimed (e.g. takeover was off)
  //    followed by a fresh in-flight user GET of the same URL waits and picks the latest safe record.
  s.request('prior-safe', url, 'GET', 'https://pan.example/old', 4)
  s.sendHeaders('prior-safe', url, {
    name: 'Referer',
    value: 'https://pan.example/old',
  })
  s.response('prior-safe', url)

  s.request('fresh-user', url, 'GET', 'https://pan.example/new', 4)
  s.sendHeaders('fresh-user', url, {
    name: 'Referer',
    value: 'https://pan.example/new',
  })
  const pending = s.lookup.waitForResponse({ id: 102, url })
  s.response('fresh-user', url)

  const source = await pending
  expect(source?.url).toBe(url)
  expect(source?.fallback).toBeUndefined()
  expect(source?.referer).toBe('https://pan.example/new')

  // Another extension's background request (unclaimed) still blocks disambiguation.
  const otherUrl = 'https://pan.example/other-ext.zip'
  s.request('other-ext', otherUrl, 'GET', 'chrome-extension://other-ext-id', -1)
  s.response('other-ext', otherUrl)
  s.request('user-get', otherUrl, 'GET', 'https://pan.example/', 4)
  s.response('user-get', otherUrl)
  expect(s.lookup({ id: 103, url: otherUrl })).toBeNull()
})

it('checks the page and every redirect against current protection rules', () => {
  const s = setup()
  const initial = 'https://downloads.example/export'
  const hop = 'https://cdn.example/token'
  const final = 'https://files.example/file.zip'
  const page = 'https://share.example'
  s.request('1', initial, 'GET', page)
  s.hop('1', initial, hop)
  s.hop('1', hop, final)
  s.response('1', final)
  const item = { id: 1, url: initial, finalUrl: final }
  const source = s.lookup(item)
  expect(source?.url).toBe(initial)
  for (const blocked of [page, initial, hop, final]) {
    s.protectedUrl.mockImplementation((_role, url) => url === blocked)
    expect(s.lookup(item)).toBeNull()
    expect(source?.allowed()).toBe(false)
  }
})

it('lets a second download of the same ordinary URL claim its own request', () => {
  const s = setup()
  const url = 'https://updates.example/app.zip'
  s.request('first', url)
  s.response('first', url)
  expect(s.lookup({ id: 1, url })?.url).toBe(url)
  s.request('second', url)
  s.response('second', url)
  expect(s.lookup({ id: 2, url })?.url).toBe(url)
})

it('keeps unrelated downloads eligible when the request cache fills', () => {
  const s = setup()
  for (let i = 0; i < 600; i++)
    s.request(String(i), `https://busy.example/frame/${i}`)
  const url = 'https://another.example/download'
  s.request('file', url)
  s.response('file', url)
  expect(s.lookup({ url })?.url).toBe(url)
})

it('keeps a pending slow export while other sites navigate', () => {
  vi.useFakeTimers()
  try {
    const s = setup()
    s.request('slow', stable)
    vi.advanceTimersByTime(45000)
    s.request('next', 'https://other.example/')
    s.response('slow', stable)
    expect(s.lookup({ url: stable })?.url).toBe(stable)
  } finally {
    vi.useRealTimers()
  }
})

it('does not lend a new GET to a late POST response after eviction', () => {
  vi.useFakeTimers()
  try {
    const s = setup()
    s.request('export', stable, 'POST')
    for (let i = 0; i < 512; i++)
      s.request(String(i), `https://busy.example/${i}`)
    vi.advanceTimersByTime(65_000)
    s.request('new-get', stable)
    s.response('new-get', stable)
    s.response('export', stable, {}, 200, 'POST')
    expect(s.lookup({ url: stable })).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})
