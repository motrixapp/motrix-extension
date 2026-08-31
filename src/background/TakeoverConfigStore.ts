import {
  TAKEOVER_DEFAULT,
  type TakeoverConfig,
  type TakeoverRule,
} from '@/shared/takeover'

const STORAGE_KEY = 'motrix.takeoverConfig'

function isRule(v: unknown): v is TakeoverRule {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return (
    typeof r.id === 'string' &&
    typeof r.match === 'object' &&
    r.match !== null &&
    (r.action === 'motrix' || r.action === 'chrome' || r.action === 'ask')
  )
}

export class TakeoverConfigStore {
  async get(): Promise<TakeoverConfig> {
    const obj = await browser.storage.local.get(STORAGE_KEY)
    const v = (obj as Record<string, unknown>)[STORAGE_KEY]
    if (!v || typeof v !== 'object') return TAKEOVER_DEFAULT
    const c = v as Partial<TakeoverConfig>
    if (
      typeof c.enabled !== 'boolean' ||
      typeof c.consentAckVersion !== 'number'
    )
      return TAKEOVER_DEFAULT
    if (c.defaultAction !== 'motrix' && c.defaultAction !== 'chrome')
      return TAKEOVER_DEFAULT
    if (!Array.isArray(c.rules) || !c.rules.every(isRule))
      return TAKEOVER_DEFAULT
    return {
      enabled: c.enabled,
      consentAckVersion: c.consentAckVersion,
      defaultAction: c.defaultAction,
      rules: c.rules,
    }
  }

  async set(config: TakeoverConfig): Promise<void> {
    await browser.storage.local.set({ [STORAGE_KEY]: config })
  }
}
