import { expect, it, vi } from 'vitest'
import { DownloadOutcomeUnknownError } from '@/background/download-errors'
import {
  type NativeHandoffPeer,
  type PendingHandoff,
  reconcileHandoff,
  submitPausedHandoff,
} from '@/background/interception/pausedHandoff'

const taskId = 'reserved',
  hash = 'a'.repeat(64)
function setup() {
  const prepare = vi.fn(async () => ({
    state: 'prepared' as const,
    expiresAt: Date.now() + 30_000,
    taskId,
    payloadHash: hash,
  }))
  const committed = { state: 'committed' as const, taskId, payloadHash: hash }
  const peer = {
    instanceId: crypto.randomUUID(),
    bindingId: 'installation',
    acceptingNew: true,
    freeze: async () => ({ hash, prepare }),
    abort: vi.fn(async () => ({ state: 'aborted' as const })),
    commit: vi.fn(async () => committed),
    status: vi.fn(async () => committed),
  } satisfies NativeHandoffPeer
  const phases: string[] = []
  const input = {
    peer,
    target: {} as never,
    options: {} as never,
    check: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    save: vi.fn(async (r: PendingHandoff) => {
      phases.push(r.phase)
    }),
  }
  return { input, peer, prepare, phases }
}
it('persists the verified native stop before commit and reuses the original key', async () => {
  const { input, peer, prepare, phases } = setup()
  peer.commit.mockRejectedValueOnce(Error('disconnected'))
  expect(await submitPausedHandoff(input)).toEqual({ taskId })
  expect(phases).toEqual(['preparing', 'stopping', 'stopped'])
  expect(input.stop).toHaveBeenCalledTimes(1)
  expect(peer.status.mock.calls[0]).toEqual(prepare.mock.calls[0])
  expect(peer.commit).toHaveBeenCalledTimes(1)
})
it.each(['stop', 'persist-stop'] as const)(
  'fences %s failure without sending commit',
  async (reason) => {
    const { input, peer } = setup()
    if (reason === 'stop') input.stop.mockRejectedValue(Error('busy'))
    else
      input.save.mockImplementation(async (r) => {
        if (r.phase === 'stopped') throw Error('storage full')
      })
    await expect(submitPausedHandoff(input)).rejects.toThrow()
    expect(peer.abort).toHaveBeenCalledTimes(1)
    expect(peer.commit).not.toHaveBeenCalled()
    expect(peer.status).not.toHaveBeenCalled()
  }
)
it('keeps the original paused if abort acknowledgement is uncertain', async () => {
  const { input, prepare, peer } = setup()
  prepare.mockRejectedValue(Error('offline'))
  peer.abort.mockRejectedValue(Error('offline'))
  await expect(submitPausedHandoff(input)).rejects.toBeInstanceOf(
    DownloadOutcomeUnknownError
  )
  expect(input.stop).not.toHaveBeenCalled()
})
it('never transfers a pending key to another principal or ledger, and a missing outcome cannot release the browser', async () => {
  const { peer } = setup()
  const record: PendingHandoff = {
    instanceId: peer.instanceId,
    bindingId: peer.bindingId,
    id: crypto.randomUUID(),
    taskId,
    hash,
    phase: 'stopped',
  }
  expect(await reconcileHandoff({ ...record, bindingId: 'other' }, peer)).toBe(
    'unknown'
  )
  expect(
    await reconcileHandoff({ ...record, instanceId: crypto.randomUUID() }, peer)
  ).toBe('unknown')
  expect(peer.status).not.toHaveBeenCalled()
  const missing = vi.fn(async () => ({ state: 'not-found' as const }))
  expect(await reconcileHandoff(record, { ...peer, status: missing })).toBe(
    'unknown'
  )
  expect(peer.commit).not.toHaveBeenCalled()
})

it('leaves an expired reservation with the browser and never cancels its download ID', async () => {
  const { input, peer, prepare } = setup()
  prepare.mockResolvedValue({
    state: 'prepared',
    taskId,
    payloadHash: hash,
    expiresAt: Date.now() - 1,
  })
  await expect(submitPausedHandoff(input)).rejects.toThrow()
  expect(input.stop).not.toHaveBeenCalled()
  expect(peer.abort).toHaveBeenCalledOnce()
  expect(peer.commit).not.toHaveBeenCalled()
})
it('may finish a confirmed durable stop only with the same prepared task and hash', async () => {
  const { peer } = setup()
  const rec: PendingHandoff = {
    id: crypto.randomUUID(),
    instanceId: peer.instanceId,
    bindingId: peer.bindingId,
    hash,
    taskId,
    phase: 'stopped',
  }
  const status = vi.fn(async () => ({
    state: 'prepared' as const,
    taskId,
    payloadHash: hash,
  }))
  expect(await reconcileHandoff(rec, { ...peer, status })).toEqual({ taskId })
  expect(peer.commit).toHaveBeenCalledExactlyOnceWith(rec.id, hash)
  expect(
    await reconcileHandoff({ ...rec, taskId: 'different' }, { ...peer, status })
  ).toBe('unknown')
  expect(peer.commit).toHaveBeenCalledOnce()
})

it('fences a still-prepared operation when the browser was resumed during recovery', async () => {
  const { peer } = setup()
  const record: PendingHandoff = {
    id: crypto.randomUUID(),
    instanceId: peer.instanceId,
    bindingId: peer.bindingId,
    hash,
    taskId,
    phase: 'stopped',
  }
  const status = async () => ({
    state: 'prepared' as const,
    taskId,
    payloadHash: hash,
  })
  await reconcileHandoff(record, { ...peer, status }, async () => false)
  expect(peer.abort).toHaveBeenCalledExactlyOnceWith(record.id)
  expect(peer.commit).not.toHaveBeenCalled()
})
