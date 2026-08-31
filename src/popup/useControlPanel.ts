import type { EngineStatusResult, MdxpTask, StatsResult } from '@motrix/mdxp'
import { useCallback, useEffect, useRef, useState } from 'react'
import { send } from '@/background/MessageBus'
import { isErrorResponse } from '@/shared/messages'

const POLL_MS = 1500

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

interface ScopedControlPanelState extends ControlPanelState {
  scopeKey: string
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
  }
}

/** Polls the bridge control-plane (via the background proxy) while `active`. */
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

  const refresh = useCallback(async (): Promise<void> => {
    if (!activeRef.current) return
    const requestScope = scopeRef.current
    try {
      const [list, stats, engine] = await Promise.all([
        send('bg.taskList', {}),
        send('bg.statsGet', {}),
        send('bg.engineStatus', {}),
      ])
      if (isErrorResponse(list)) throw new Error(list.error)
      if (isErrorResponse(stats)) throw new Error(stats.error)
      if (isErrorResponse(engine)) throw new Error(engine.error)
      if (!activeRef.current || scopeRef.current !== requestScope) return
      setState({
        tasks: list.tasks,
        stats,
        engine,
        loading: false,
        error: null,
        scopeKey: requestScope,
      })
    } catch (e) {
      if (!activeRef.current || scopeRef.current !== requestScope) return
      setState((s) => ({
        ...s,
        loading: false,
        error: (e as Error).message,
        scopeKey: requestScope,
      }))
    }
  }, [])

  useEffect(() => {
    setState(emptyState(scopeKey, active))
    if (!active) return
    void refresh()
    const t = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(t)
  }, [active, refresh, scopeKey])

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

  const visibleState =
    active && state.scopeKey === scopeKey ? state : emptyState(scopeKey, active)

  return {
    ...visibleState,
    refresh,
    pause: (taskId) => action('bg.taskPause', taskId),
    resume: (taskId) => action('bg.taskResume', taskId),
    reveal: async (taskId) => {
      const response = await send('bg.taskReveal', { taskId })
      if (isErrorResponse(response)) throw new Error(response.error)
    },
    remove: (taskId, deleteFiles) =>
      action('bg.taskRemove', taskId, deleteFiles),
  }
}
