export interface ProbeDeps {
  fetch: typeof fetch
  timeoutMs?: number
}

function parseLen(value: string | null): number | null {
  if (value === null) return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

export async function probeSize(
  url: string,
  deps: ProbeDeps
): Promise<number | null> {
  const timeout = deps.timeoutMs ?? 3000
  try {
    const head = await deps.fetch(url, {
      method: 'HEAD',
      credentials: 'include',
      signal: AbortSignal.timeout(timeout),
    })
    if (head.ok) {
      const len = parseLen(head.headers.get('content-length'))
      if (len !== null) return len
    }
  } catch {
    return null
  }
  // HEAD unsupported or no length: try a 1-byte ranged GET and read Content-Range total.
  try {
    const ranged = await deps.fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(timeout),
    })
    if (!ranged.ok && ranged.status !== 206) return null
    const cr = ranged.headers.get('content-range') // e.g. "bytes 0-0/12345"
    const total = cr?.split('/')[1]
    return parseLen(total ?? null)
  } catch {
    return null
  }
}
