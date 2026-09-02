import type { EngineStatusResult, MdxpTask, StatsResult } from '@motrix/mdxp'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { send } from '@/background/MessageBus'
import { snapshotEqual } from '@/popup/snapshotEqual'
import { isControlPanelActivityEvent } from '@/shared/controlPanelEvents'
import { isErrorResponse } from '@/shared/messages'

const ACTIVE_POLL_MS = 1500
const IDLE_POLL_MS = 10_000
const ENGINE_POLL_MS = 30_000

const ACTIVE_TASK_STATUSES = new Set<MdxpTask['status']>([
  'queued',
  'fetching_metadata',
  'downloading',
  'seeding',
  'finalizing',
])

export interface ControlPanelState {
  tasks: MdxpTask[]
  stats: StatsResult | null
  engine: EngineStatusResult | null
  loading: boolean
  error: string | null
}

export interface ControlPanel extends ControlPanelState {
  refresh: () => Promise<void>
  pause: (taskId: string) => Promise<void>
  resume: (taskId: string) => Promise<void>
  reveal: (taskId: string) => Promise<void>
  remove: (taskId: string, deleteFiles?: boolean) => Promise<void>
}

export type TaskControlPanel = Pick<
  ControlPanel,
  | 'tasks'
  | 'loading'
  | 'error'
  | 'refresh'
  | 'pause'
  | 'resume'
  | 'reveal'
  | 'remove'
>

interface ScopedControlPanelState extends ControlPanelState {
  scopeKey: string
  activityError: string | null
  engineError: string | null
}

function emptyState(
  scopeKey: string,
  active: boolean
): ScopedControlPanelState {
  return {
    tasks: [],
    stats: null,
    engine: null,
    loading: active,
    error: null,
    scopeKey,
    activityError: null,
    engineError: null,
  }
}

function retainEqualTasks(
  current: MdxpTask[],
  incoming: MdxpTask[]
): MdxpTask[] {
  if (snapshotEqual(current, incoming)) return current
  const currentById = new Map(current.map((task) => [task.id, task]))
  return incoming.map((task) => {
    const previous = currentById.get(task.id)
    return previous && snapshotEqual(previous, task) ? previous : task
  })
}

function hasActiveTasks(tasks: readonly MdxpTask[]): boolean {
  return tasks.some((task) => ACTIVE_TASK_STATUSES.has(task.status))
}

/**
 * Reconciles the bridge control-plane while `active`.
 *
 * Task + stats refresh quickly only while work can change on screen, then
 * back off when idle. Engine status has its own slow loop. Activity pushes
 * from the paired session wake the task loop immediately, while an idle poll
 * remains as the source of truth for tasks added directly in Motrix.
 */
export function useControlPanel(
  active: boolean,
  scopeKey = 'default'
): ControlPanel {
  const [state, setState] = useState<ScopedControlPanelState>(() =>
    emptyState(scopeKey, active)
  )
  const activeRef = useRef(active)
  const scopeRef = useRef(scopeKey)
  activeRef.current = active
  scopeRef.current = scopeKey

  const refreshActivitySnapshot = useCallback(
    async (requestScope: string): Promise<boolean | null> => {
      if (!activeRef.current) return null
      try {
        const [list, stats] = await Promise.all([
          send('bg.taskList', {}),
          send('bg.statsGet', {}),
        ])
        if (isErrorResponse(list)) throw new Error(list.error)
        if (isErrorResponse(stats)) throw new Error(stats.error)
        if (!activeRef.current || scopeRef.current !== requestScope) return null
        const nextHasActiveTasks = hasActiveTasks(list.tasks)
        setState((current) => {
          const scopedCurrent =
            current.scopeKey === requestScope
              ? current
              : emptyState(requestScope, true)
          const tasks = retainEqualTasks(scopedCurrent.tasks, list.tasks)
          const nextStats = snapshotEqual(scopedCurrent.stats, stats)
            ? scopedCurrent.stats
            : stats
          if (
            scopedCurrent.tasks === tasks &&
            scopedCurrent.stats === nextStats &&
            !scopedCurrent.loading &&
            scopedCurrent.activityError === null
          ) {
            return scopedCurrent
          }
          return {
            ...scopedCurrent,
            activityError: null,
            error: scopedCurrent.engineError,
            loading: false,
            stats: nextStats,
            tasks,
          }
        })
        return nextHasActiveTasks
      } catch (e) {
        if (!activeRef.current || scopeRef.current !== requestScope) return null
        setState((current) => {
          const error = (e as Error).message
          const scopedCurrent =
            current.scopeKey === requestScope
              ? current
              : emptyState(requestScope, true)
          if (!scopedCurrent.loading && scopedCurrent.activityError === error) {
            return scopedCurrent
          }
          return {
            ...scopedCurrent,
            activityError: error,
            loading: false,
            error,
          }
        })
        return null
      }
    },
    []
  )

  const refreshEngineSnapshot = useCallback(
    async (requestScope: string): Promise<void> => {
      if (!activeRef.current) return
      try {
        const engine = await send('bg.engineStatus', {})
        if (isErrorResponse(engine)) throw new Error(engine.error)
        if (!activeRef.current || scopeRef.current !== requestScope) return
        setState((current) => {
          const scopedCurrent =
            current.scopeKey === requestScope
              ? current
              : emptyState(requestScope, true)
          const nextEngine = snapshotEqual(scopedCurrent.engine, engine)
            ? scopedCurrent.engine
            : engine
          if (
            scopedCurrent.engine === nextEngine &&
            scopedCurrent.engineError === null
          ) {
            return scopedCurrent
          }
          return {
            ...scopedCurrent,
            engine: nextEngine,
            engineError: null,
            error: scopedCurrent.activityError,
          }
        })
      } catch (e) {
        if (!activeRef.current || scopeRef.current !== requestScope) return
        setState((current) => {
          const error = (e as Error).message
          const scopedCurrent =
            current.scopeKey === requestScope
              ? current
              : emptyState(requestScope, true)
          if (scopedCurrent.engineError === error) return scopedCurrent
          return {
            ...scopedCurrent,
            engineError: error,
            error: scopedCurrent.activityError ?? error,
          }
        })
      }
    },
    []
  )

  const requestActivityRefreshRef = useRef<() => Promise<void>>(
    async () => undefined
  )
  const refresh = useCallback(
    (): Promise<void> => requestActivityRefreshRef.current(),
    []
  )

  useEffect(() => {
    setState(emptyState(scopeKey, active))
    if (!active) {
      requestActivityRefreshRef.current = async () => undefined
      return
    }

    let disposed = false
    let fastPolling = false
    let activityTimer: ReturnType<typeof setTimeout> | null = null
    let engineTimer: ReturnType<typeof setTimeout> | null = null
    let activityRequested = false
    let activityRunner: Promise<void> | null = null

    const clearActivityTimer = (): void => {
      if (activityTimer !== null) clearTimeout(activityTimer)
      activityTimer = null
    }

    const scheduleActivityRefresh = (): void => {
      clearActivityTimer()
      if (disposed) return
      activityTimer = setTimeout(
        () => void requestActivityRefresh(),
        fastPolling ? ACTIVE_POLL_MS : IDLE_POLL_MS
      )
    }

    const requestActivityRefresh = async (): Promise<void> => {
      if (disposed) return
      activityRequested = true
      clearActivityTimer()
      if (activityRunner === null) {
        activityRunner = (async () => {
          while (activityRequested && !disposed) {
            activityRequested = false
            const nextFastPolling = await refreshActivitySnapshot(scopeKey)
            if (nextFastPolling !== null) {
              fastPolling = nextFastPolling
            }
          }
        })().finally(() => {
          activityRunner = null
          scheduleActivityRefresh()
        })
      }
      await activityRunner
      // A wake-up can land after the runner's final loop check but before its
      // `finally` clears the promise. Ensure that request receives a fresh run.
      if (activityRequested && !disposed) await requestActivityRefresh()
    }

    const pollEngine = async (): Promise<void> => {
      await refreshEngineSnapshot(scopeKey)
      if (disposed) return
      engineTimer = setTimeout(() => void pollEngine(), ENGINE_POLL_MS)
    }

    const handleRuntimeMessage = (message: unknown): void => {
      if (isControlPanelActivityEvent(message)) {
        void requestActivityRefresh()
      }
    }

    requestActivityRefreshRef.current = requestActivityRefresh
    browser.runtime.onMessage.addListener(handleRuntimeMessage)
    void requestActivityRefresh()
    void pollEngine()

    return () => {
      disposed = true
      clearActivityTimer()
      if (engineTimer !== null) clearTimeout(engineTimer)
      browser.runtime.onMessage.removeListener(handleRuntimeMessage)
      if (requestActivityRefreshRef.current === requestActivityRefresh) {
        requestActivityRefreshRef.current = async () => undefined
      }
    }
  }, [active, refreshActivitySnapshot, refreshEngineSnapshot, scopeKey])

  const action = useCallback(
    async (
      kind: 'bg.taskPause' | 'bg.taskResume' | 'bg.taskRemove',
      taskId: string,
      deleteFiles?: boolean
    ): Promise<void> => {
      const payload =
        kind === 'bg.taskRemove' ? { taskId, deleteFiles } : { taskId }
      const res = await send(kind, payload as never)
      if (isErrorResponse(res)) throw new Error(res.error)
      await refresh()
    },
    [refresh]
  )

  const pause = useCallback(
    (taskId: string) => action('bg.taskPause', taskId),
    [action]
  )
  const resume = useCallback(
    (taskId: string) => action('bg.taskResume', taskId),
    [action]
  )
  const reveal = useCallback(async (taskId: string): Promise<void> => {
    const response = await send('bg.taskReveal', { taskId })
    if (isErrorResponse(response)) throw new Error(response.error)
  }, [])
  const remove = useCallback(
    (taskId: string, deleteFiles?: boolean) =>
      action('bg.taskRemove', taskId, deleteFiles),
    [action]
  )
  const inactiveState = useMemo(
    () => emptyState(scopeKey, active),
    [active, scopeKey]
  )
  const visibleState =
    active && state.scopeKey === scopeKey ? state : inactiveState

  return useMemo(
    () => ({
      ...visibleState,
      refresh,
      pause,
      resume,
      reveal,
      remove,
    }),
    [pause, refresh, remove, resume, reveal, visibleState]
  )
}
