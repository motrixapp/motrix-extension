export const RELEASE_CLICK_PORT = 'motrix.release-click.v1'

export function releasePage(address: string) {
  try {
    const url = new URL(address)
    return (
      url.origin === 'https://motrix.app' &&
      /^\/(?:zh\/)?download\/?$/.test(url.pathname)
    )
  } catch {
    return false
  }
}

// Only immutable public release routes controlled by this project. A signed
// CDN landing URL must never become the URL submitted to the download engine.
export function publicRelease(address: string) {
  let u: URL
  try {
    u = new URL(address)
  } catch {
    return false
  }
  if (u.search || u.hash || u.username || u.password) return false
  return (
    (u.origin === 'https://dl.motrix.app' &&
      /^\/releases?\/Motrix[-_][\w.-]+$/i.test(u.pathname)) ||
    (u.origin === 'https://github.com' &&
      /^\/agalwood\/motrix\/releases\/download\/v[\w.-]+\/Motrix[-_][\w.-]+$/i.test(
        u.pathname
      ))
  )
}
