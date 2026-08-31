import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandoffOps } from '@/background/handoff/runHandoff'
import { runHandoff } from '@/background/handoff/runHandoff'
import {
  type ChromiumInterceptionDeps,
  HOLD_DEADLINE_MS,
  registerChromiumInterception,
} from '@/background/interception/chromium'
import type { TakeoverConfig } from '@/shared/takeover'

vi.mock('@/background/handoff/runHandoff', () => ({
  runHandoff: vi.fn(async () => {}),
}))
vi.mock('@/background/capture/probeSize', () => ({
  probeSize: vi.fn(async () => 5 * 1024 * 1024), // 5 MiB
}))

const mockedRunHandoff = vi.mocked(runHandoff)

type Listener = (
  item: Record<string, unknown>,
  suggest: () => void
) => boolean | undefined

interface DownloadsStub {
  onDeterminingFilename: { addListener: ReturnType<typeof vi.fn> }
  cancel: ReturnType<typeof vi.fn>
  erase: ReturnType<typeof vi.fn>
  download: ReturnType<typeof vi.fn>
}

let listener: Listener | undefined
let downloads: DownloadsStub

function enabledConfig(
  overrides: Partial<TakeoverConfig> = {}
): TakeoverConfig {
  return {
    enabled: true,
    consentAckVersion: 1,
    defaultAction: 'motrix',
    rules: [],
    ...overrides,
  }
}

function makeDeps(cfg: TakeoverConfig): ChromiumInterceptionDeps {
  return {
    getConfig: vi.fn(async () => cfg),
    manager: {
      getState: () => 'connected',
      getLastError: () => null,
      clearGateAndStart: vi.fn(async () => {}),
      submitDownload: vi.fn(async () => ({ taskId: 't1' })),
    },
    isPaired: vi.fn(async () => true),
    gate: { shouldAutoConnect: vi.fn(async () => true) },
    nudge: { maybeNudge: vi.fn(async () => {}) },
    notify: vi.fn(),
    selfExtensionId: 'self-ext-id',
  } as unknown as ChromiumInterceptionDeps
}

function item(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 7,
    url: 'https://files.example/a.bin',
    totalBytes: 1024,
    referrer: 'https://page.example/',
    filename: 'a.bin',
    mime: 'application/octet-stream',
    ...overrides,
  }
}

beforeEach(() => {
  listener = undefined
  downloads = {
    onDeterminingFilename: {
      addListener: vi.fn((cb: Listener) => {
        listener = cb
      }),
    },
    cancel: vi.fn(async () => {}),
    erase: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
  }
  // setup.ts assigns the SAME stub object to globalThis.chrome and
  // globalThis.browser, so installing on both keeps that invariant explicit:
  // chromium.ts registers via chrome.*, operates via browser.*.
  ;(
    globalThis as Record<string, unknown> & { chrome: Record<string, unknown> }
  ).chrome.downloads = downloads
  ;(
    globalThis as Record<string, unknown> & { browser: Record<string, unknown> }
  ).browser.downloads = downloads
})

afterEach(() => {
  vi.useRealTimers()
})

function register(cfg: TakeoverConfig): ChromiumInterceptionDeps {
  const deps = makeDeps(cfg)
  registerChromiumInterception(deps)
  expect(listener).toBeDefined()
  return deps
}

describe('registerChromiumInterception', () => {
  it('no-ops when onDeterminingFilename is unavailable (Firefox)', () => {
    ;(
      globalThis as Record<string, unknown> & {
        chrome: Record<string, unknown>
      }
    ).chrome.downloads = {}
    expect(() =>
      registerChromiumInterception(makeDeps(enabledConfig()))
    ).not.toThrow()
    expect(listener).toBeUndefined()
  })

  it('declines our own re-issued downloads synchronously (no hold)', () => {
    register(enabledConfig())
    const suggest = vi.fn()
    const ret = listener?.(item({ byExtensionId: 'self-ext-id' }), suggest)
    expect(ret).toBeUndefined() // Chrome auto-suggests; we never hold
    expect(suggest).not.toHaveBeenCalled()
    expect(mockedRunHandoff).not.toHaveBeenCalled()
  })

  it('declines non-http downloads synchronously', () => {
    register(enabledConfig())
    const suggest = vi.fn()
    expect(listener?.(item({ url: 'blob:abc' }), suggest)).toBeUndefined()
    expect(suggest).not.toHaveBeenCalled()
  })

  it('holds eligible downloads by returning true', () => {
    register(enabledConfig())
    expect(listener?.(item(), vi.fn())).toBe(true)
  })

  it('releases (suggest once) when takeover is disabled', async () => {
    register(enabledConfig({ enabled: false }))
    const suggest = vi.fn()
    listener?.(item(), suggest)
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(1))
    expect(downloads.cancel).not.toHaveBeenCalled()
    expect(mockedRunHandoff).not.toHaveBeenCalled()
  })

  it('releases when the decision is chrome', async () => {
    register(enabledConfig({ defaultAction: 'chrome' }))
    const suggest = vi.fn()
    listener?.(item(), suggest)
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(1))
    expect(mockedRunHandoff).not.toHaveBeenCalled()
  })

  it('probes size while held, then releases when a size rule diverts to chrome', async () => {
    // minSizeMB matches KNOWN sizes BELOW the threshold; probe returns 5 MiB.
    register(
      enabledConfig({
        defaultAction: 'motrix',
        rules: [{ id: 'r1', match: { minSizeMB: 100 }, action: 'chrome' }],
      })
    )
    const suggest = vi.fn()
    listener?.(item({ totalBytes: -1 }), suggest)
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(1))
    const { probeSize } = await import('@/background/capture/probeSize')
    expect(vi.mocked(probeSize)).toHaveBeenCalledWith(
      'https://files.example/a.bin',
      expect.anything()
    )
    expect(mockedRunHandoff).not.toHaveBeenCalled()
  })

  it('commit path: handoff cancels via ops → cancel+erase, suggest never called', async () => {
    mockedRunHandoff.mockImplementationOnce(async (_t, ops: HandoffOps) => {
      await ops.cancelNative()
    })
    register(enabledConfig())
    const suggest = vi.fn()
    listener?.(item(), suggest)
    await vi.waitFor(() => expect(downloads.cancel).toHaveBeenCalledWith(7))
    expect(downloads.erase).toHaveBeenCalledWith({ id: 7 })
    // Give the finally-release a microtask turn, then assert it stayed silent.
    await Promise.resolve()
    expect(suggest).not.toHaveBeenCalled()
  })

  it('decline path: handoff returns without cancelling → suggest once', async () => {
    mockedRunHandoff.mockImplementationOnce(async () => {}) // e.g. not paired → nudge
    register(enabledConfig())
    const suggest = vi.fn()
    listener?.(item(), suggest)
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(1))
    expect(downloads.cancel).not.toHaveBeenCalled()
  })

  it('failure path: handoff throws → suggest once, native download survives', async () => {
    mockedRunHandoff.mockImplementationOnce(async () => {
      throw new Error('boom')
    })
    register(enabledConfig())
    const suggest = vi.fn()
    listener?.(item(), suggest)
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(1))
    expect(downloads.cancel).not.toHaveBeenCalled()
  })

  it('deadline: a hung handoff cannot commit after the guard released', async () => {
    vi.useFakeTimers()
    let heldOps: HandoffOps | undefined
    mockedRunHandoff.mockImplementationOnce(async (_t, ops: HandoffOps) => {
      heldOps = ops
      await new Promise(() => {}) // hang forever
    })
    register(enabledConfig())
    const suggest = vi.fn()
    listener?.(item(), suggest)
    await vi.advanceTimersByTimeAsync(HOLD_DEADLINE_MS)
    expect(suggest).toHaveBeenCalledTimes(1)
    await expect(heldOps?.cancelNative()).rejects.toThrow(
      'determination already released'
    )
    expect(downloads.cancel).not.toHaveBeenCalled()
  })
})
