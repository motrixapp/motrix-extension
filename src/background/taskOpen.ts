import type { TaskRevealParams } from '@motrix/mdxp'

/**
 * Minimal shape this module needs from the desktop App's initialize result.
 * `getServerCapabilities()` is typed by MDXP 0.8.x, which has no `taskOpen`,
 * so the optional flag is read through a widening helper instead of a cast at
 * every call site.
 */
export function advertisedTaskOpen(capabilities: unknown): boolean {
  if (typeof capabilities !== 'object' || capabilities === null) return false
  return (capabilities as { taskOpen?: unknown }).taskOpen === true
}

type TaskOpenBridge = {
  getServerCapabilities: () => unknown
  // The transport is method-keyed by MDXP's request map. `task/open` is a
  // proposed addition outside that map, so it is issued through a narrow
  // structural signature and validated by the peer, not by the type.
  request: (method: string, params: unknown) => Promise<unknown>
}

/**
 * MDXP 0.8.x has no `task/open`. A newer desktop App may advertise the
 * optional `taskOpen` capability and answer the method over the same paired
 * session; older hosts advertise nothing and must degrade to a disabled
 * control rather than a dead click. An unknown method is a protocol-level
 * rejection, never a side effect, so probing optimistically is safe.
 */
const TASK_OPEN_METHOD = 'task/open'

/** Whether the paired desktop App advertises opening a finished download. */
export function supportsTaskOpen(capabilities: unknown): boolean {
  return advertisedTaskOpen(capabilities)
}

export async function requestTaskOpen(
  manager: TaskOpenBridge,
  params: TaskRevealParams
): Promise<{ ok: true }> {
  if (!supportsTaskOpen(manager.getServerCapabilities())) {
    throw new Error('connected Motrix does not support task/open')
  }
  await manager.request(TASK_OPEN_METHOD, { taskId: params.taskId })
  return { ok: true }
}
