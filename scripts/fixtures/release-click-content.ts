import { installReleaseClick } from '@/content/releaseClick'
import { extensionBrowser as browser } from '@/shared/browser'
import { RELEASE_CLICK_PORT } from '@/shared/releaseClick'

installReleaseClick(
  (url) => new URL(url).pathname.startsWith('/start/click-'),
  (url) => new URL(url).pathname.startsWith('/download/click-'),
  () => {
    const port = browser.runtime.connect({ name: RELEASE_CLICK_PORT })
    port.onMessage.addListener((value) => {
      if (value === 'ready')
        document.documentElement.dataset.fixtureReady = 'true'
    })
    return port
  }
)
