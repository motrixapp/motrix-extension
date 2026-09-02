interface BrowserWithOptionalNativeMessaging {
  runtime?: {
    connectNative?: unknown
  }
}

/**
 * Native Messaging is available in desktop Firefox and Chromium browsers,
 * but Firefox for Android intentionally omits the API. Remote Motrix Server
 * connections do not depend on it and remain supported on Android.
 */
export function hasNativeMessagingSupport(): boolean {
  const extensionBrowser = (
    globalThis as typeof globalThis & {
      browser?: BrowserWithOptionalNativeMessaging
    }
  ).browser
  return typeof extensionBrowser?.runtime?.connectNative === 'function'
}
