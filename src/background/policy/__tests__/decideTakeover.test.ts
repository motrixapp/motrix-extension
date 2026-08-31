import { describe, expect, it } from 'vitest'
import { decideTakeover } from '@/background/policy/decideTakeover'
import type { TakeoverConfig, TakeoverTarget } from '@/shared/takeover'

function target(over: Partial<TakeoverTarget> = {}): TakeoverTarget {
  return {
    url: 'https://cdn.example.com/big.zip',
    pageUrl: 'https://example.com/page',
    pageTitle: 'Page',
    suggestedFilename: 'big.zip',
    mime: 'application/zip',
    sizeBytes: 50 * 1024 * 1024,
    siteHint: 'cdn.example.com',
    origin: 'auto',
    ...over,
  }
}

function cfg(over: Partial<TakeoverConfig> = {}): TakeoverConfig {
  return {
    enabled: true,
    consentAckVersion: 1,
    defaultAction: 'motrix',
    rules: [],
    ...over,
  }
}

describe('decideTakeover', () => {
  it('returns chrome when disabled', () => {
    expect(decideTakeover(cfg({ enabled: false }), target())).toBe('chrome')
  })

  it('always routes an explicit context-menu pick to motrix even when disabled', () => {
    // A right-click "Download with Motrix" is explicit user intent, not a
    // candidate for the auto-interception opt-in. It must hand off regardless
    // of config.enabled — otherwise the right-click silently does nothing
    // whenever "Send eligible downloads to Motrix" is off.
    expect(
      decideTakeover(
        cfg({ enabled: false }),
        target({ origin: 'context-menu' })
      )
    ).toBe('motrix')
  })

  it('routes a context-menu pick to motrix even when a rule would send it to chrome', () => {
    // Auto-interception rules decide which browser-initiated downloads to
    // grab; they are irrelevant to an explicit pick. The user chose Motrix.
    const c = cfg({
      rules: [
        { id: 'd', match: { domains: ['example.com'] }, action: 'chrome' },
      ],
    })
    expect(
      decideTakeover(
        c,
        target({
          origin: 'context-menu',
          url: 'https://cdn.example.com/big.zip',
        })
      )
    ).toBe('motrix')
  })

  it('defaults to motrix when enabled and no rule matches', () => {
    expect(decideTakeover(cfg(), target())).toBe('motrix')
  })

  it('denylist host-suffix match routes to chrome (first match wins)', () => {
    const c = cfg({
      rules: [
        { id: 'd', match: { domains: ['example.com'] }, action: 'chrome' },
      ],
    })
    expect(
      decideTakeover(c, target({ url: 'https://cdn.example.com/big.zip' }))
    ).toBe('chrome')
  })

  it('below-threshold rule routes small files to chrome; large stay motrix', () => {
    const c = cfg({
      rules: [{ id: 't', match: { minSizeMB: 10 }, action: 'chrome' }],
    })
    expect(decideTakeover(c, target({ sizeBytes: 1 * 1024 * 1024 }))).toBe(
      'chrome'
    )
    expect(decideTakeover(c, target({ sizeBytes: 50 * 1024 * 1024 }))).toBe(
      'motrix'
    )
  })

  it('unknown size never matches the below-threshold rule -> defaultAction', () => {
    const c = cfg({
      rules: [{ id: 't', match: { minSizeMB: 10 }, action: 'chrome' }],
    })
    expect(decideTakeover(c, target({ sizeBytes: null }))).toBe('motrix')
  })

  it("treats the model's 'ask' action as chrome in the MVP", () => {
    const c = cfg({ rules: [{ id: 'a', match: {}, action: 'ask' }] })
    expect(decideTakeover(c, target())).toBe('chrome')
  })
})
