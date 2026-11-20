import bundled from '@/background/policy/download-protection.json'
import { personalDomain } from '@/options/takeoverForm'
import { hostSuffixMatch } from '@/shared/takeover'

const hosts = [...new Set(bundled.rules.map((rule) => rule.host))].sort()

export function previewCloudDriveImport(draft: string) {
  const lines = draft
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  // Keep invalid edits visible for field validation rather than losing user input.
  const merged = new Set(lines.map((line) => personalDomain(line) ?? line))
  const existing = lines
    .map(personalDomain)
    .filter((host): host is string => !!host)
  const added: string[] = []
  const covered: string[] = []
  for (const host of hosts) {
    const alreadyCovered =
      existing.some((domain) => hostSuffixMatch(host, domain)) ||
      hosts.some((domain) => host !== domain && hostSuffixMatch(host, domain))
    if (alreadyCovered) covered.push(host)
    else added.push(host)
  }
  return { added, covered, merged: [...merged, ...added].join('\n') }
}
