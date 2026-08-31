import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TakeoverConfigStore } from '@/background/TakeoverConfigStore'
import { TAKEOVER_DEFAULT } from '@/shared/takeover'

declare const browser: {
  storage: {
    local: {
      get: (k: string | string[]) => Promise<Record<string, unknown>>
      set: (items: Record<string, unknown>) => Promise<void>
    }
  }
}

beforeEach(() => {
  let backing: Record<string, unknown> = {}
  browser.storage.local.get = vi.fn(async (k: string | string[]) => {
    const key = Array.isArray(k) ? k[0] : k
    return key && key in backing ? { [key]: backing[key] } : {}
  })
  browser.storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
    backing = { ...backing, ...items }
  })
})

describe('TakeoverConfigStore', () => {
  it('returns the default when nothing is stored', async () => {
    expect(await new TakeoverConfigStore().get()).toEqual(TAKEOVER_DEFAULT)
  })

  it('round-trips a saved config', async () => {
    const store = new TakeoverConfigStore()
    const cfg = {
      enabled: true,
      consentAckVersion: 1,
      defaultAction: 'motrix' as const,
      rules: [
        {
          id: 'r1',
          match: { domains: ['ads.example.com'] },
          action: 'chrome' as const,
        },
      ],
    }
    await store.set(cfg)
    expect(await store.get()).toEqual(cfg)
  })

  it('falls back to the default on a malformed stored value', async () => {
    const _store = new TakeoverConfigStore()
    await browser.storage.local.set({ 'motrix.takeoverConfig': 'garbage' })
    expect(await new TakeoverConfigStore().get()).toEqual(TAKEOVER_DEFAULT)
  })

  it('falls back to default when a stored rule has an invalid action', async () => {
    const _store = new TakeoverConfigStore()
    await browser.storage.local.set({
      'motrix.takeoverConfig': {
        enabled: true,
        consentAckVersion: 1,
        defaultAction: 'motrix',
        rules: [{ id: 'r', match: {}, action: 'bogus' }],
      },
    })
    expect(await new TakeoverConfigStore().get()).toEqual(TAKEOVER_DEFAULT)
  })
})
