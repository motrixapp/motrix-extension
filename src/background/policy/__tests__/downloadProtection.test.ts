import { afterEach, expect, it, vi } from 'vitest'
import { startDownloadProtection } from '@/background/policy/downloadProtection'
import { extensionBrowser as browser } from '@/shared/browser'
import { isProtectedDownload, listSchema } from '@/shared/downloadProtection'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('matches the role, DNS label and path segment', () => {
  const list = listSchema.parse({
    schemaVersion: 1,
    revision: 1,
    rules: [
      {
        host: 'drive.example',
        matchOn: 'source',
        includeSubdomains: true,
        pathPrefix: '/share/',
      },
    ],
  })
  expect(
    isProtectedDownload(list, 'source', 'https://a.drive.example/share/file')
  ).toBe(true)
  for (const url of [
    'https://notdrive.example/share/file',
    'https://drive.example/shared',
    'https://drive.example.evil/share/file',
  ])
    expect(isProtectedDownload(list, 'source', url)).toBe(false)
  expect(
    isProtectedDownload(list, 'resource', 'https://drive.example/share/file')
  ).toBe(false)
})
it('uses the cached ETag, updates only from valid snapshots, and matches locally', async () => {
  const rule = { host: 'drive.example', matchOn: 'source' }
  const list = { schemaVersion: 1, revision: 2, rules: [rule] }
  const get = vi.fn(async () => ({
      'motrix.downloadProtection.v1': { etag: '"old"', list },
    })),
    set = vi.fn(async () => {})
  const addListener = vi.fn()
  Object.assign(browser, {
    storage: { ...browser.storage, local: { get, set } },
    alarms: { get: vi.fn(async () => ({})), onAlarm: { addListener } },
  })
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        { ...list, revision: 3, rules: [{ ...rule, host: 'new.example' }] },
        { headers: { etag: '"new"' } }
      )
    )
    .mockResolvedValueOnce(Response.json({ ...list, schemaVersion: 2 }))
  vi.stubGlobal('fetch', fetch)
  const protectedUrl = startDownloadProtection()
  await vi.waitFor(() =>
    expect(protectedUrl('source', 'https://unlisted.example/')).toBe(false)
  )
  expect(protectedUrl('source', 'https://drive.example/file')).toBe(true)
  expect(fetch).not.toHaveBeenCalled()
  const refresh = addListener.mock.calls[0]?.[0]
  refresh({ name: 'motrix.downloadProtection.v1' })
  await vi.waitFor(() =>
    expect(protectedUrl('source', 'https://new.example')).toBe(true)
  )
  expect(fetch).toHaveBeenCalledWith(
    'https://motrix.app/rules/download-protection/v1.json',
    expect.objectContaining({
      credentials: 'omit',
      headers: { 'If-None-Match': '"old"' },
    })
  )
  refresh({ name: 'motrix.downloadProtection.v1' })
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  expect(set).toHaveBeenCalledTimes(1)
  expect(protectedUrl('source', 'https://new.example')).toBe(true)
})

it('combines live personal edits with the official list, including during cold start', async () => {
  const change = vi.fn()
  let resolve!: (value: Record<string, unknown>) => void
  const config = (domain: string) => ({
    enabled: true,
    consentAckVersion: 1,
    defaultAction: 'motrix',
    rules: [{ id: 'personal', action: 'chrome', match: { domains: [domain] } }],
  })
  const key = 'motrix.takeoverConfig'
  Object.assign(browser, {
    storage: {
      ...browser.storage,
      onChanged: { addListener: change },
      local: {
        get: () =>
          new Promise((r) => {
            resolve = r
          }),
      },
    },
    alarms: { get: async () => ({}), onAlarm: { addListener: vi.fn() } },
  })
  const protects = startDownloadProtection()
  const changed = change.mock.calls[0]?.[0]
  changed({ [key]: { newValue: config('drive.example') } }, 'local')
  resolve({ [key]: config('old.example') })
  await vi.waitFor(() =>
    expect(protects('resource', 'https://old.example')).toBe(false)
  )
  expect(protects('source', 'https://files.drive.example./share')).toBe(true)
  expect(protects('resource', 'https://notdrive.example/download')).toBe(false)
  changed({ [key]: { newValue: config('cdn.example') } }, 'local')
  expect(protects('resource', 'https://drive.example/file')).toBe(false)
  expect(protects('resource', 'https://cdn.example/file')).toBe(true)
  changed({ [key]: {} }, 'local')
  expect(protects('resource', 'https://cdn.example/file')).toBe(false)
  expect(protects('source', 'https://www.123684.com/s/fixture')).toBe(true)
})

it('applies the published snapshot to share pages and download nodes at domain and path boundaries', async () => {
  const { default: json } = await import(
    '@/background/policy/download-protection.json'
  )
  const list = listSchema.parse(json)
  for (const [role, url, expected] of [
    ['source', 'https://demo.lanzouw.com/i123', true],
    ['source', 'https://demo.lanzouw.com.example/i123', false],
    ['resource', 'https://down-load.lanrar.com/file/?ticket=fixture', true],
    ['resource', 'https://www.123865.com/s/fixture', true],
    ['source', 'https://www.123865.com/settings', false],
    ['resource', 'https://vip.123pan.cn/id/file', true],
    ['source', 'https://anxia.com/s/fixture', true],
    ['source', 'https://share.115.com/fixture', true],
    ['resource', 'https://123912.com/s/fixture', true],
    ['resource', 'https://cdnfhnfile.115.com/file', true],
    ['resource', 'https://anxia.com/signup', false],
    ['source', 'https://cloud.189.cn/t/fixture', true],
    [
      'resource',
      'https://download.cloud.189.cn/file/downloadFile.action',
      true,
    ],
    ['resource', 'https://www.189.cn/file', false],
    ['resource', 'https://1drv.ms/u/fixture', true],
  ] as const)
    expect(isProtectedDownload(list, role, url), url).toBe(expected)
})
