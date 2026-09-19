import { extensionBrowser } from '@/shared/browser'

/**
 * Native Messaging is available in desktop Firefox and Chromium browsers,
 * but Firefox for Android intentionally omits the API. Remote Motrix Server
 * connections do not depend on it and remain supported on Android.
 */
export function hasNativeMessagingSupport(): boolean {
  return typeof extensionBrowser.runtime?.connectNative === 'function'
}

/** Background calls cannot rely on a download event retaining user activation. */
export function supportsAutoOpenPopup(
  userAgent = navigator.userAgent
): boolean {
  if (typeof extensionBrowser.action?.openPopup !== 'function') return false
  const firefox = /Firefox\/(\d+)/.exec(userAgent)
  if (firefox) return Number(firefox[1]) >= 149
  const chromium = /(?:Chrome|Chromium)\/(\d+)/.exec(userAgent)
  return chromium !== null && Number(chromium[1]) >= 127
}
