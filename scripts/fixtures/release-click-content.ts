// Loopback-only UI driver for the desktop repository's explicit pre-request
// handoff fixture. Production browser downloads use the native download event.
import { extensionBrowser as browser } from '@/shared/browser'

if (
  location.hostname === '127.0.0.1' &&
  location.pathname === '/start/click-live'
) {
  document.addEventListener('focusin', () => {
    document.documentElement.dataset.fixtureReady = 'true'
  })
  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element && event.target.closest('a')
    const url = new URL('/download/click-live', location.origin).href
    if (!event.isTrusted || !link || link.href !== url) return
    event.preventDefault()
    void browser.runtime.sendMessage({ kind: 'fixture.confirm', url })
  })
}
