import type { TakeoverConfig, TakeoverRule } from '@/shared/takeover'

export interface TakeoverForm {
  enabled: boolean
  thresholdMB: string // '' = none
  denylist: string // newline-separated hosts
}

const THRESHOLD_RULE_ID = 'mvp.threshold'

export function configToForm(config: TakeoverConfig): TakeoverForm {
  const threshold = config.rules.find((r) => r.id === THRESHOLD_RULE_ID)?.match
    .minSizeMB
  const denylist = config.rules
    .filter(
      (r) =>
        r.id !== THRESHOLD_RULE_ID && r.action === 'chrome' && r.match.domains
    )
    .flatMap((r) => r.match.domains ?? [])
  return {
    enabled: config.enabled,
    thresholdMB: typeof threshold === 'number' ? String(threshold) : '',
    denylist: denylist.join('\n'),
  }
}

export function formToConfig(
  form: TakeoverForm,
  consentAckVersion: number
): TakeoverConfig {
  const rules: TakeoverRule[] = []
  const domains = form.denylist
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  for (const [i, domain] of domains.entries()) {
    rules.push({
      id: `mvp.deny.${i}`,
      match: { domains: [domain] },
      action: 'chrome',
    })
  }
  const mb = Number(form.thresholdMB)
  if (Number.isFinite(mb) && mb > 0) {
    rules.push({
      id: THRESHOLD_RULE_ID,
      match: { minSizeMB: mb },
      action: 'chrome',
    })
  }
  return {
    enabled: form.enabled,
    consentAckVersion,
    defaultAction: 'motrix',
    rules,
  }
}
