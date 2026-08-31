// MUST be first: the polyfill makes `browser.*` available in Chromium.
import browserPolyfill from 'webextension-polyfill'
;(globalThis as unknown as { browser?: unknown }).browser ??= browserPolyfill

import { ContentRuntime } from '@/content/ContentRuntime'

const rt = new ContentRuntime(location.href)
if (rt.adapterId !== null) {
  void rt.bootstrap()
  rt.attach()
  console.log(`[motrix-ext][content] adapter ${rt.adapterId} attached`)
}
