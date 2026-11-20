import type {
  DownloadMode,
  TakeoverRule,
  TakeoverSettings,
} from '@/shared/takeover'

/** Pasted links become hostnames before settings are persisted. */
export function personalDomain(input: string): string | null {
  const value = input.trim()
  if (!value || /\s/.test(value)) return null
  const isLink = /^https?:\/\//i.test(value)
  const host = value.replace(/^(?:\*\.|\.)/, '')
  if (!isLink && /[/?#@%\\*]/.test(host)) return null
  try {
    const url = new URL(isLink ? value : `https://${host}`)
    if (url.username || url.password || (!isLink && url.port)) return null
    const domain = url.hostname.toLowerCase().replace(/\.$/, '')
    if (
      !domain.startsWith('[') &&
      !domain
        .split('.')
        .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    )
      return null
    return domain
  } catch {
    return null
  }
}

export interface TakeoverForm {
  releaseClick?: boolean | undefined
  downloadMode: DownloadMode
  enabled: boolean
  thresholdMB: string // '' = none
  unknownSizeAction: TakeoverSettings['unknownSizeAction']
  denylist: string // newline-separated hosts
}

const THRESHOLD_RULE_ID = 'mvp.threshold'

export function configToForm(config: TakeoverSettings): TakeoverForm {
  const threshold = config.rules.find((r) => r.id === THRESHOLD_RULE_ID)?.match
    .minSizeMB
  const denylist = config.rules
    .filter(
      (r) =>
        r.id !== THRESHOLD_RULE_ID && r.action === 'chrome' && r.match.domains
    )
    .flatMap((r) => r.match.domains ?? [])
  return {
    downloadMode: config.downloadMode ?? 'direct',
    enabled: config.enabled,
    ...(config.releaseClick ? { releaseClick: true } : {}),
    thresholdMB: typeof threshold === 'number' ? String(threshold) : '',
    unknownSizeAction: config.unknownSizeAction ?? 'chrome',
    denylist: denylist.join('\n'),
  }
}

export function formToConfig(
  form: TakeoverForm,
  consentAckVersion: number
): TakeoverSettings {
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
    downloadMode: form.downloadMode ?? 'direct',
    enabled: form.enabled,
    ...(form.releaseClick === undefined
      ? {}
      : { releaseClick: form.releaseClick }),
    consentAckVersion,
    defaultAction: 'motrix',
    unknownSizeAction: form.unknownSizeAction,
    rules,
  }
}
