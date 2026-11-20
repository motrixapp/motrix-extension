import { expect, it, vi } from 'vitest'
import { observeReplaySources } from '@/background/interception/replaySource'
import { extensionBrowser as browser } from '@/shared/browser'

const stable =
  'https://github.com/agalwood/Motrix/releases/download/v2.4.3/Motrix-2.4.3.dmg'
const signed = 'https://release-assets.githubusercontent.com/file?token=one-use'
function setup() {
  const before = { addListener: vi.fn() },
    redirect = { addListener: vi.fn() },
    headers = { addListener: vi.fn() }
  Object.assign(browser, {
    webRequest: {
      onBeforeRequest: before,
      onBeforeRedirect: redirect,
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
    initiator?: string
  ) =>
    before.addListener.mock.calls[0]?.[0]({
      requestId: id,
      url,
      method,
      initiator,
      type: 'main_frame',
      tabId: 4,
    })
  const hop = (id: string, url: string, redirectUrl: string) =>
    redirect.addListener.mock.calls[0]?.[0]({ requestId: id, url, redirectUrl })
  const response = (id: string, url: string) =>
    headers.addListener.mock.calls[0]?.[0]({
      requestId: id,
      url,
      method: 'GET',
      statusCode: 200,
    })
  return { lookup, request, hop, response, protectedUrl }
}
it('submits the stable release URL and never lends its permission to a standalone signed URL', () => {
  const s = setup()
  s.request('1', stable)
  s.hop('1', stable, signed)
  s.response('1', signed)
  const source = s.lookup({ url: stable, finalUrl: signed })
  expect(source?.url).toBe(stable)
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
  s.response('third-party', url)
  expect(s.lookup({ url })?.url).toBe(url)
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
