/**
 * Why a browser download was left to the browser instead of Motrix.
 *
 * These codes are surfaced in the popup so "some files were not taken over"
 * is an explainable outcome rather than a silent one. Every early-exit path in
 * the interception path must classify itself with one of them.
 */
export const TAKEOVER_DECLINE = {
  /** Not an attachment, inline-renderable, or a known binary document type. */
  notADownload: 'not-a-download',
  /** The request was started by this extension (fallback replay, confirmed
   *  browser choice); re-intercepting it would loop forever. */
  selfInitiated: 'self-initiated',
  /** The master "send eligible downloads to Motrix" switch is off. */
  takeoverDisabled: 'takeover-disabled',
  /** The selected backend cannot take over automatic downloads. */
  endpointUnsupported: 'endpoint-unsupported',
  /** Banking/government/medical hosts are excluded from cookie forwarding. */
  sensitiveHost: 'sensitive-host',
  /** A site exclusion or size/MIME rule routed this download to the browser. */
  policyDeclined: 'policy-declined',
  /** The size stayed unknown and the unknown-size policy prefers the browser. */
  unknownSize: 'unknown-size',
  /** The blocking preflight did not finish inside its budget. */
  preflightTimeout: 'preflight-timeout',
  /** The preflight threw, or the response could not be read at all. */
  preflightUnavailable: 'preflight-unavailable',
  /** A GET replay would not reproduce what the browser negotiated. */
  unfaithfulReplay: 'unfaithful-replay',
  /** The native download finished or was paused before takeover could commit. */
  nativeGone: 'native-gone',
  /** The handoff ran but Motrix refused or never answered. */
  handoffFailed: 'handoff-failed',
} as const

export type TakeoverDecline =
  (typeof TAKEOVER_DECLINE)[keyof typeof TAKEOVER_DECLINE]

export interface TakeoverDeclineRecord {
  at: number
  code: TakeoverDecline
  /** Host only — never a full URL, path, or query string. */
  host: string
  /** Whether the browser had already started writing the file. */
  nativeCancelled: boolean
}

/** Bounded so a long-lived worker cannot grow this without limit. */
const MAX_RECORDS = 50
const records: TakeoverDeclineRecord[] = []

/** Records why one download stayed browser-owned. Session-only by design:
 *  a persisted trail would outlive the tab and leak browsing history. */
export function recordTakeoverDecline(
  code: TakeoverDecline,
  host: string,
  nativeCancelled = false
): void {
  records.unshift({ at: Date.now(), code, host, nativeCancelled })
  if (records.length > MAX_RECORDS) records.length = MAX_RECORDS
}

export function listTakeoverDeclines(): TakeoverDeclineRecord[] {
  return [...records]
}

export function clearTakeoverDeclines(): void {
  records.length = 0
}
