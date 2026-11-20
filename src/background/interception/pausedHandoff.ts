import { DownloadOutcomeUnknownError } from '@/background/download-errors'
import type { TakeoverTarget } from '@/shared/takeover'
import type { TaskOptions } from '@/shared/taskOptions'

export class FencedHandoffError extends Error {
  constructor(readonly stopAttempted: boolean) {
    super('Handoff fenced without a committed task')
  }
}

export interface HandoffState {
  state: 'prepared' | 'committed' | 'aborted' | 'expired' | 'not-found'
  taskId?: string
  expiresAt?: number
  payloadHash?: string
}
export interface NativeHandoffPeer {
  instanceId: string
  bindingId: string
  acceptingNew: boolean
  freeze(
    target: TakeoverTarget,
    options: TaskOptions
  ): Promise<{ hash: string; prepare(id: string): Promise<HandoffState> }>
  status(id: string): Promise<HandoffState>
  abort(id: string): Promise<HandoffState>
  commit(id: string, hash: string): Promise<HandoffState>
}
export interface PendingHandoff {
  instanceId: string
  bindingId: string
  id: string
  hash: string
  taskId?: string | undefined
  phase: 'preparing' | 'stopping' | 'stopped'
}
type Settlement = 'browser' | 'stopped' | 'unknown' | { taskId: string }
function committed(
  result: HandoffState,
  hash: string
): { taskId: string } | undefined {
  if (
    result.state === 'committed' &&
    result.taskId &&
    result.payloadHash === hash
  )
    return { taskId: result.taskId }
}
/** Before verified cancellation, fence even a delayed prepare with abort. After it,
 * query the same operation, and only repeat commit on affirmative prepared status. */
export async function reconcileHandoff(
  record: PendingHandoff,
  peer: NativeHandoffPeer | undefined,
  stillStopped: () => Promise<boolean> = async () => true
): Promise<Settlement> {
  if (
    !peer ||
    peer.instanceId !== record.instanceId ||
    peer.bindingId !== record.bindingId
  )
    return 'unknown'
  try {
    const stopped = record.phase === 'stopped'
    let result = stopped
      ? await peer.status(record.id)
      : await peer.abort(record.id)
    if (
      stopped &&
      result.state === 'prepared' &&
      result.taskId === record.taskId &&
      result.payloadHash === record.hash
    )
      result = (await stillStopped())
        ? await peer.commit(record.id, record.hash)
        : await peer.abort(record.id)
    if (result.state === 'aborted' || result.state === 'expired')
      return stopped ? 'stopped' : 'browser'
    return stopped && record.taskId === result.taskId
      ? (committed(result, record.hash) ?? 'unknown')
      : 'unknown'
  } catch {
    return 'unknown'
  }
}
export async function submitPausedHandoff(input: {
  peer: NativeHandoffPeer
  target: TakeoverTarget
  options: TaskOptions
  save: (record: PendingHandoff) => Promise<void>
  check: () => Promise<void>
  stop: () => Promise<void>
}) {
  const { peer } = input
  const frozen = await peer.freeze(input.target, input.options)
  await input.check()
  const record: PendingHandoff = {
    instanceId: peer.instanceId,
    bindingId: peer.bindingId,
    id: crypto.randomUUID(),
    hash: frozen.hash,
    phase: 'preparing',
  }
  await input.save({ ...record })
  try {
    const prepared = await frozen.prepare(record.id)
    if (
      prepared.state !== 'prepared' ||
      prepared.payloadHash !== record.hash ||
      !prepared.taskId ||
      !prepared.expiresAt ||
      prepared.expiresAt <= Date.now()
    )
      throw new Error('handoff was not prepared')
    await input.check()
    record.taskId = prepared.taskId
    await input.save({ ...record, phase: 'stopping' })
    record.phase = 'stopping'
    await input.check()
    if (prepared.expiresAt <= Date.now())
      throw new Error('Handoff preparation expired')
    await input.stop()
    await input.save({ ...record, phase: 'stopped' })
    record.phase = 'stopped'
    const result = committed(
      await peer.commit(record.id, record.hash),
      record.hash
    )
    if (result && result.taskId === record.taskId) return result
  } catch {
    // The mutation may have succeeded before a disconnect. Reconcile below.
  }
  const result = await reconcileHandoff(record, peer)
  if (typeof result === 'object') return result
  if (result === 'browser' || result === 'stopped')
    throw new FencedHandoffError(record.phase !== 'preparing')
  // An already cancelled native request cannot be resumed or recreated implicitly.
  throw new DownloadOutcomeUnknownError()
}
