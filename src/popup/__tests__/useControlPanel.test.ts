import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useControlPanel } from '@/popup/useControlPanel'

declare const browser: {
  runtime: { sendMessage: (msg: unknown) => Promise<unknown> }
}

type Envelope = { kind: string; payload: unknown }

function mockBus(): { sent: Envelope[] } {
  const sent: Envelope[] = []
  browser.runtime.sendMessage = vi.fn(async (msg: unknown) => {
    const env = msg as Envelope
    sent.push(env)
    if (env.kind === 'bg.taskList')
      return {
        tasks: [
          {
            id: 't1',
            type: 'http',
            name: 'a.bin',
            status: 'downloading',
            progress: 0.5,
            bytesDone: 5,
            bytesTotal: 10,
            speedBps: 100,
            etaSec: 1,
            saveDir: '/d',
            error: null,
            createdAt: 0,
            finishedAt: null,
            finalPath: null,
          },
        ],
        total: 1,
      }
    if (env.kind === 'bg.statsGet')
      return {
        totalDownloadSpeed: 100,
        totalUploadSpeed: 0,
        activeTasks: 1,
        waitingTasks: 0,
        stoppedTasks: 0,
      }
    if (env.kind === 'bg.engineStatus')
      return { state: 'ready', featureReport: null }
    return { ok: true }
  })
  return { sent }
}

describe('useControlPanel', () => {
  beforeEach(() => vi.useRealTimers())

  it('loads tasks, stats and engine status', async () => {
    mockBus()
    const { result } = renderHook(() => useControlPanel(true))
    await waitFor(() => expect(result.current.tasks).toHaveLength(1))
    expect(result.current.tasks[0]?.name).toBe('a.bin')
    expect(result.current.stats?.activeTasks).toBe(1)
    expect(result.current.engine?.state).toBe('ready')
  })

  it('pause() dispatches bg.taskPause then refreshes', async () => {
    const { sent } = mockBus()
    const { result } = renderHook(() => useControlPanel(true))
    await waitFor(() => expect(result.current.tasks).toHaveLength(1))
    await act(async () => {
      await result.current.pause('t1')
    })
    expect(sent.map((e) => e.kind)).toContain('bg.taskPause')
  })

  it('reveal() dispatches bg.taskReveal without refreshing the task list', async () => {
    const { sent } = mockBus()
    const { result } = renderHook(() => useControlPanel(true))
    await waitFor(() => expect(result.current.tasks).toHaveLength(1))
    const readsBefore = sent.filter(({ kind }) => kind === 'bg.taskList').length

    await act(async () => {
      await result.current.reveal('t1')
    })

    expect(sent).toContainEqual({
      kind: 'bg.taskReveal',
      payload: { taskId: 't1' },
    })
    expect(sent.filter(({ kind }) => kind === 'bg.taskList')).toHaveLength(
      readsBefore
    )
  })

  it('clears cached tasks and stats while a new backend scope loads', async () => {
    let remote = false
    let resolveRemoteTasks!: (value: { tasks: []; total: 0 }) => void
    const remoteTasks = new Promise<{ tasks: []; total: 0 }>((resolve) => {
      resolveRemoteTasks = resolve
    })

    browser.runtime.sendMessage = vi.fn(async (msg: unknown) => {
      const env = msg as Envelope
      if (remote && env.kind === 'bg.taskList') return remoteTasks
      if (env.kind === 'bg.taskList') {
        return {
          tasks: [
            {
              id: 'local-task',
              type: 'http',
              name: 'local.bin',
              status: 'downloading',
              progress: 0.5,
              bytesDone: 5,
              bytesTotal: 10,
              speedBps: 100,
              etaSec: 1,
              saveDir: '/d',
              error: null,
              createdAt: 0,
              finishedAt: null,
              finalPath: null,
            },
          ],
          total: 1,
        }
      }
      if (env.kind === 'bg.statsGet') {
        return {
          totalDownloadSpeed: remote ? 200 : 100,
          totalUploadSpeed: 0,
          activeTasks: remote ? 0 : 1,
          waitingTasks: 0,
          stoppedTasks: 0,
        }
      }
      if (env.kind === 'bg.engineStatus') {
        return { state: 'ready', featureReport: null }
      }
      return { ok: true }
    })

    const { result, rerender } = renderHook(
      ({ scopeKey }) => useControlPanel(true, scopeKey),
      { initialProps: { scopeKey: 'local' } }
    )
    await waitFor(() => expect(result.current.tasks).toHaveLength(1))
    expect(result.current.stats?.totalDownloadSpeed).toBe(100)

    remote = true
    rerender({ scopeKey: 'remote' })

    expect(result.current.tasks).toEqual([])
    expect(result.current.stats).toBeNull()
    expect(result.current.loading).toBe(true)

    resolveRemoteTasks({ tasks: [], total: 0 })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.stats?.totalDownloadSpeed).toBe(200)
  })
})
