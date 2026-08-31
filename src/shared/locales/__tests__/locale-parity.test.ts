import { describe, expect, it } from 'vitest'
import en from '@/shared/locales/en-US.json'
import zh from '@/shared/locales/zh-CN.json'

function keys(o: unknown, prefix = ''): string[] {
  if (o === null || typeof o !== 'object') return [prefix]
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
    keys(v, prefix ? `${prefix}.${k}` : k)
  )
}

describe('locale parity', () => {
  it('en-US and zh-CN have identical key sets', () => {
    expect(new Set(keys(en))).toEqual(new Set(keys(zh)))
  })
  it('has the new options.tabs keys', () => {
    const k = new Set(keys(en))
    for (const t of [
      'options.tabs.general',
      'options.tabs.appearance',
      'options.tabs.integration',
      'options.tabs.help',
      'options.common.apply',
      'options.appearance.theme.label',
      'options.help.title',
      'options.about.website',
      'options.notifications.title',
      'options.notifications.masterLabel',
      'options.notifications.confirmLabel',
      'options.notifications.errorLabel',
      'options.notifications.reminderLabel',
      'notify.pairRevokedTitle',
      'notify.pairRevokedBody',
      'badge.tooltip.connected',
      'badge.tooltip.disconnected',
      'badge.tooltip.connecting',
      'badge.tooltip.downloading',
      'badge.tooltip.denied',
      'badge.tooltip.error',
    ]) {
      expect(k.has(t)).toBe(true)
    }
  })
})
