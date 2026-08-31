import { hostOf, type RawTarget, type TakeoverTarget } from '@/shared/takeover'

function basename(s: string): string {
  const noQuery = s.split(/[?#]/)[0] ?? s
  // Drop empty segments so a trailing slash (e.g. bilibili watch links of the
  // form /video/BVxxx/) yields the last real segment ("BVxxx") instead of ''.
  // An empty name falls through to a meaningless "(1)" filename downstream.
  const parts = noQuery.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

function nonEmpty(s: string | undefined): s is string {
  return typeof s === 'string' && s.length > 0
}

export function normalizeTarget(raw: RawTarget): TakeoverTarget {
  const url = nonEmpty(raw.finalUrl) ? raw.finalUrl : raw.url
  const pageUrl = nonEmpty(raw.referrer) ? raw.referrer : url
  const rawName = nonEmpty(raw.suggestedFilename)
    ? raw.suggestedFilename
    : basename(url)
  const suggestedFilename = basename(rawName).slice(0, 255)
  const pageTitle = (
    nonEmpty(raw.tabTitle) ? raw.tabTitle : suggestedFilename
  ).slice(0, 500)
  const sizeBytes =
    typeof raw.sizeBytes === 'number' && raw.sizeBytes > 0
      ? raw.sizeBytes
      : null
  return {
    url,
    pageUrl,
    pageTitle,
    suggestedFilename,
    mime: raw.mime ?? '',
    sizeBytes,
    siteHint: hostOf(pageUrl),
    origin: raw.origin,
  }
}
