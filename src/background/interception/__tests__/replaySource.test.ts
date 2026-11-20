import { expect, it, vi } from 'vitest'
import { observeReplaySources } from '@/background/interception/replaySource'
import { extensionBrowser as browser } from '@/shared/browser'
import { publicRelease } from '@/shared/releaseClick'

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
    },
  })
  const protectedUrl = vi.fn(() => false)
  const lookup = observeReplaySources(protectedUrl)
  const request = (id: string, url: string, method = 'GET') =>
    before.addListener.mock.calls[0]?.[0]({
      requestId: id,
      url,
      method,
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
  expect(publicRelease('https://drive.example/public/file.zip')).toBe(false)
  expect(publicRelease(`${stable}?token=secret`)).toBe(false)
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
