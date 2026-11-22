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
    redirect.addListener.mock.calls[0]?.[0]({ requestId: id, url, redirectUrl })
  const sendHeaders = (id: string, url: string, ...names: string[]) =>
    sent.addListener.mock.calls[0]?.[0]({
      requestId: id,
      url,
      requestHeaders: names.map((name) => ({ name, value: 'fixture' })),
    })
  const response = (
    id: string,
    url: string,
    responseHeaders: Record<string, string> = {},
    statusCode = 200
  ) =>
    headers.addListener.mock.calls[0]?.[0]({
      requestId: id,
      url,
      method: 'GET',
      type: 'main_frame',
      statusCode,
      responseHeaders: Object.entries(responseHeaders).map(([name, value]) => ({
        name,
        value,
      })),
    })
  return { lookup, request, hop, sendHeaders, response, protectedUrl }
}
it('submits the stable release URL and never lends its permission to a standalone signed URL', () => {
  const s = setup()
  s.request('1', stable)
  s.hop('1', stable, signed)
  s.response('1', signed)
  const source = s.lookup({ url: stable, finalUrl: signed })
  expect(source?.url).toBe(stable)
  s.request('standalone', signed)
  s.response('standalone', signed)
  expect(s.lookup({ url: signed })).toBeNull()
  expect(s.lookup({ requestId: '1', url: signed })?.url).toBe(stable)
  s.protectedUrl.mockReturnValue(true)
  expect(source?.allowed()).toBe(false)
})
it('leaves ambiguous, redirected-in and unknown downloads in the browser', () => {
  const s = setup()
  s.hop('external', signed, stable)
  s.request('external', stable)
  s.response('external', stable)
  expect(s.lookup({ url: stable })).toBeNull()
  s.request('ok', stable)
  s.response('ok', stable)
  s.request('post', stable, 'POST')
  expect(s.lookup({ url: stable })).toBeNull()
})

it('waits for late headers only for the already observed public request', async () => {
  const s = setup()
  expect(await s.lookup.waitForResponse({ url: signed })).toBeNull()
  s.request('late', stable)
  const evidence = s.lookup.waitForResponse({ url: stable })
  s.response('late', stable)
  expect((await evidence)?.url).toBe(stable)
})

it('recognizes an observed third-party GET with ordinary query parameters', () => {
  const s = setup()
  const url = 'https://downloads.example.org/export?id=42'
  s.request('third-party', url)
  s.sendHeaders('third-party', url, 'Cookie')
  s.response('third-party', url)
  expect(s.lookup({ url })?.url).toBe(url)
})

it('keeps the original download when its entry URL already served HTML in the same tab', async () => {
  const s = setup()
  const initial = 'https://downloads.example/file/?id=123'
  const final = 'https://cdn.example/file.zip'
  s.request('page', initial)
  s.response('page', initial, { 'Content-Type': 'Text/HTML; charset=utf-8' })
  s.request('reload', initial)
  s.hop('reload', initial, final)
  s.response('reload', final, { 'Content-Type': 'application/zip' })

  const item = { id: 1, url: initial, finalUrl: final }
  expect(s.lookup(item)).toBeNull()
  expect(await s.lookup.waitForResponse(item)).toBeNull()
  expect(s.lookup({ requestId: 'reload', url: final })).toBeNull()
})

it.each([
  { disposition: 'attachment; filename="page.html"', tabId: 4 },
  { disposition: 'inline', tabId: 9 },
])(
  'still allows redirected GETs after an HTML attachment or an HTML response in another tab',
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
  '?oneTimeToken=abcdef',
  '?ticket=abcdef',
])(
  'keeps an independently opened credential-bearing URL in the browser (%s)',
  (query) => {
    const s = setup()
    const url = `https://downloads.example/file.zip${query}`
    s.request('file', url)
    s.response('file', url)
    expect(s.lookup({ url })).toBeNull()
    expect(s.lookup({ requestId: 'file', url })).toBeNull()
  }
)

it.each([
  'https://cdn.example/file.zip',
  'https://downloads.example/private/file.zip',
])(
  'leaves a redirect with cookies outside the entry URL scope in the browser (%s)',
  (final) => {
    const s = setup()
    const initial = 'https://downloads.example/export'
    s.request('file', initial)
    s.sendHeaders('file', initial)
    s.hop('file', initial, final)
    s.sendHeaders('file', final, 'Cookie')
    s.response('file', final)
    expect(s.lookup({ url: initial, finalUrl: final })).toBeNull()
    expect(s.lookup({ requestId: 'file', url: final })).toBeNull()
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

it.each([
  'authorization header',
  'authentication challenge',
  'cookie-specific response',
])(
  'keeps a download with browser-only credentials in the browser (%s)',
  (signal) => {
    const s = setup()
    const url = 'https://downloads.example/file.zip'
    s.request('file', url)
    if (signal === 'authorization header')
      s.sendHeaders('file', url, 'Authorization')
    if (signal === 'authentication challenge') s.response('file', url, {}, 401)
    if (signal === 'cookie-specific response')
      s.sendHeaders('file', url, 'Cookie')
    s.response(
      'file',
      url,
      signal === 'cookie-specific response'
        ? { Vary: 'Accept-Encoding, Cookie' }
        : {}
    )
    expect(s.lookup({ url })).toBeNull()
    expect(s.lookup({ requestId: 'file', url })).toBeNull()
  }
)

it('keeps a POST export in the browser when redirected to a GET', () => {
  const s = setup()
  const initial = 'https://downloads.example/export'
  const final = 'https://downloads.example/file.zip'
  s.request('export', initial, 'POST')
  s.hop('export', initial, final)
  s.response('export', final)
  expect(s.lookup({ url: initial, finalUrl: final })).toBeNull()
  expect(s.lookup({ requestId: 'export', url: final })).toBeNull()
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
  for (let i = 0; i < 300; i++)
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
    for (let i = 0; i < 256; i++)
      s.request(String(i), `https://busy.example/${i}`)
    vi.advanceTimersByTime(45_000)
    s.request('new-get', stable)
    s.response('new-get', stable)
    s.response('export', stable)
    expect(s.lookup({ url: stable })).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})
