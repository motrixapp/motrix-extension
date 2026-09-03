import browserPolyfill from 'webextension-polyfill'

// Chromium exposes `chrome.*`, while Firefox exposes `browser.*` natively.
// Install the promise-based polyfill before any shared module reads the
// ambient `browser` global during module evaluation.
const extensionGlobals = globalThis as unknown as {
  browser?: typeof browserPolyfill
}

extensionGlobals.browser ??= browserPolyfill

export const extensionBrowser = extensionGlobals.browser
