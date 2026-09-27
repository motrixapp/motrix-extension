export interface ProbeDeps {
  fetch: typeof fetch
  /** Budget for the whole probe, HEAD and fallback together. */
  timeoutMs?: number
  now?: () => number
}

export interface ProbeResult {
  /** Content-Length (or the Content-Range total), or null when unknown. */
  sizeBytes: number | null
  /** Raw Content-Type header of the probed response, or null when unknown. */
  contentType: string | null
}

const EMPTY: ProbeResult = { sizeBytes: null, contentType: null }

function parseLen(value: string | null): number | null {
  if (value === null) return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Rehearse the request Motrix would make: one HEAD, falling back to a 1-byte
 * ranged GET when HEAD is unsupported or carries no length. Reports both the
 * size (for the config's minSizeMB rules) and the Content-Type (for the
 * replay-fidelity check in `replayFidelity.ts`).
 */
export async function probeTarget(
  url: string,
  deps: ProbeDeps
): Promise<ProbeResult> {
  const timeout = deps.timeoutMs ?? 3000
  const now = deps.now ?? Date.now
  // One deadline for both requests: the takeover hold budgets the probe at
  // 3 s in total, so the fallback only gets what the HEAD left over.
  const deadline = now() + timeout
  let contentType: string | null = null
  try {
    const head = await deps.fetch(url, {
      method: 'HEAD',
      credentials: 'include',
      signal: AbortSignal.timeout(timeout),
    })
    if (head.ok) {
      contentType = head.headers.get('content-type')
      const len = parseLen(head.headers.get('content-length'))
      if (len !== null) return { sizeBytes: len, contentType }
    }
  } catch {
    return EMPTY
  }
  // HEAD unsupported or no length: try a 1-byte ranged GET.
  const remaining = deadline - now()
  if (remaining <= 0) return { sizeBytes: null, contentType }
  try {
    const ranged = await deps.fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(remaining),
    })
    try {
      if (!ranged.ok) return { sizeBytes: null, contentType }
      contentType = ranged.headers.get('content-type') ?? contentType
      // A 206 Content-Length describes just the requested slice. A server
      // that ignores Range returns 200, whose Content-Length is the full size.
      const length =
        ranged.status === 206
          ? (ranged.headers.get('content-range')?.split('/')[1] ?? null)
          : ranged.headers.get('content-length')
      return { sizeBytes: parseLen(length), contentType }
    } finally {
      // Only the headers are needed, especially if Range was ignored and
      // the server started sending the whole file.
      await ranged.body?.cancel().catch(() => {})
    }
  } catch {
    return { sizeBytes: null, contentType }
  }
}
