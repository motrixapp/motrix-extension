import { extensionBrowser as browser } from '@/shared/browser'
import {
  publicRelease,
  RELEASE_CLICK_PORT,
  releasePage,
} from '@/shared/releaseClick'

/** Preflight only the installer under the pointer or keyboard focus. Until a
 * live background port arms this exact link, its original click is untouched. */
export function installReleaseClick(
  trustedPage = releasePage,
  trustedFile = publicRelease,
  connect = () => browser.runtime.connect({ name: RELEASE_CLICK_PORT })
) {
  if (window.top !== window || !trustedPage(location.href)) return
  let active = true
  let prepared: ReturnType<typeof prepare> | undefined
  function candidate(event: Event) {
    const anchor = event
      .composedPath()
      .find((node) => node instanceof HTMLAnchorElement)
    if (
      !(anchor instanceof HTMLAnchorElement) ||
      anchor.target ||
      anchor.hasAttribute('onclick') ||
      anchor.hasAttribute('ping') ||
      anchor.hasAttribute('download')
    )
      return
    const size = Number(anchor.dataset.dlBytes)
    if (
      !anchor.dataset.dlFile ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      !trustedFile(anchor.href)
    )
      return
    if (
      new URL(anchor.href).pathname.split('/').pop() !== anchor.dataset.dlFile
    )
      return
    return { anchor, url: anchor.href, size }
  }
  function prepare(link: NonNullable<ReturnType<typeof candidate>>) {
    const port = connect()
    const state = {
      ...link,
      port,
      ready: false,
      clicked: false,
      delegated: false,
    }
    port.onMessage.addListener((m) => {
      if (m === 'ready') state.ready = true
      else if (m === 'take' && state.clicked && !state.delegated) {
        try {
          port.postMessage('ack')
          state.delegated = true
        } catch {
          /* Still page-owned until disconnect. */
        }
      }
    })
    port.onDisconnect.addListener(() => {
      if (prepared === state) prepared = undefined
      // No submit or browser API call is permitted before our acknowledgement.
      if (
        active &&
        state.clicked &&
        !state.delegated &&
        link.anchor.isConnected &&
        link.anchor.href === link.url
      )
        link.anchor.click()
    })
    port.postMessage({ url: link.url, size: link.size })
    return state
  }
  function warm(event: Event) {
    if (!event.isTrusted) return
    const link = candidate(event)
    if (
      !link ||
      (prepared?.anchor === link.anchor &&
        prepared.url === link.url &&
        prepared.size === link.size)
    )
      return
    prepared?.port.disconnect()
    prepared = undefined
    try {
      prepared = prepare(link)
    } catch {
      /* Extension was reloaded. */
    }
  }
  document.addEventListener('pointerover', warm, true)
  document.addEventListener('focusin', warm, true)
  document.addEventListener(
    'click',
    (event) => {
      const state = prepared
      if (
        !state?.ready ||
        !event.isTrusted ||
        event.defaultPrevented ||
        !event.cancelable ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey
      )
        return
      const link = candidate(event)
      if (
        !link ||
        link.anchor !== state.anchor ||
        link.url !== state.url ||
        link.size !== state.size
      )
        return
      try {
        state.port.postMessage(event.altKey ? 'browser' : 'choose')
      } catch {
        return
      }
      state.clicked = true
      prepared = undefined
      event.preventDefault()
    },
    true
  )
  window.addEventListener('pageshow', () => {
    active = true
  })
  window.addEventListener('pagehide', () => {
    active = false
    prepared?.port.disconnect()
    prepared = undefined
  })
}
