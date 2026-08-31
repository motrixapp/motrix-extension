import type { MdxpTask } from '@motrix/mdxp'
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  FileArchive,
  FileDown,
  FolderOpen,
  Inbox,
  type LucideIcon,
  Magnet,
  Pause,
  Play,
  Plus,
  Trash2,
} from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ConnectionState } from '@/background/ConnectionManager'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  CompactContentCard,
  CompactSectionToolbar,
} from '@/popup/CompactPopupLayout'
import { QuickAddTaskDialog } from '@/popup/QuickAddTaskDialog'
import type { ControlPanel as ControlPanelController } from '@/popup/useControlPanel'

type TaskView = 'active' | 'failed' | 'recent'

const TASK_VIEWS: readonly TaskView[] = ['active', 'failed', 'recent']
const RESUMABLE = new Set(['paused', 'error'])
const PAUSABLE = new Set([
  'downloading',
  'fetching_metadata',
  'seeding',
  'queued',
])

function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  const precision = index === 0 || value >= 100 ? 0 : 1
  return `${value.toFixed(precision)} ${units[index] ?? 'B'}`
}

function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

function taskTime(task: MdxpTask): number {
  return task.finishedAt ?? task.createdAt
}

function filterTasks(tasks: MdxpTask[], view: TaskView): MdxpTask[] {
  const filtered = tasks.filter((task) => {
    if (view === 'failed') return task.status === 'error'
    if (view === 'recent') return task.status === 'completed'
    return task.status !== 'error' && task.status !== 'completed'
  })
  return [...filtered].sort((a, b) => taskTime(b) - taskTime(a))
}

function taskIcon(task: MdxpTask): LucideIcon {
  if (task.status === 'error') return CircleAlert
  if (task.status === 'completed') return CircleCheck
  if (task.type === 'magnet') return Magnet
  if (task.type === 'bt') return FileArchive
  return FileDown
}

function taskIconClassName(task: MdxpTask): string {
  if (task.status === 'error') return 'bg-destructive/[0.08] text-destructive'
  if (task.status === 'completed') {
    return 'bg-connection-online/[0.08] text-connection-online'
  }
  if (task.status === 'paused') return 'bg-muted text-muted-foreground'
  return 'bg-speed-download/[0.07] text-speed-download'
}

function TaskRow({
  task,
  onPause,
  onResume,
  onReveal,
  onRemove,
  canRevealTask,
  revealing,
}: {
  task: MdxpTask
  onPause: (id: string) => void
  onResume: (id: string) => void
  onReveal: (id: string) => void
  onRemove: (id: string) => void
  canRevealTask: boolean
  revealing: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  const progress = Math.round(Math.min(1, Math.max(0, task.progress)) * 100)
  const total = task.bytesTotal
  const Icon = taskIcon(task)
  const status = t(`popup.tasks.status.${task.status}`)
  const bytes = t('popup.tasks.bytes', {
    done: formatBytes(task.bytesDone),
    total: total === null ? '—' : formatBytes(total),
  })
  const secondary = [
    status,
    task.status === 'error' ? task.error : bytes,
    task.speedBps > 0 ? formatSpeed(task.speedBps) : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
  const revealReady = canRevealTask && task.status !== 'fetching_metadata'
  const revealLabel = !canRevealTask
    ? t('popup.tasks.openFolderUnsupported')
    : task.status === 'fetching_metadata'
      ? t('popup.tasks.openFolderMetadataPending')
      : t('popup.tasks.openFolderTask', { name: task.name })
  const pauseLabel = t('popup.tasks.pauseTask', { name: task.name })
  const resumeLabel = t('popup.tasks.resumeTask', { name: task.name })
  const removeLabel = t('popup.tasks.removeTask', { name: task.name })
  const secondaryId = `task-secondary-${task.id}`
  const revealUnavailable = !revealReady || revealing
  const taskContent = (
    <>
      <span
        className={`absolute top-[17px] left-4 flex size-10 items-center justify-center rounded-[10px] ${taskIconClassName(task)}`}
      >
        <Icon className="size-5" strokeWidth={1.8} aria-hidden="true" />
      </span>
      <span
        className="absolute top-[9px] right-2 left-[72px] truncate text-[13px]/5 font-normal"
        title={task.name}
      >
        {task.name}
      </span>
      <span
        id={secondaryId}
        className="absolute top-[31px] right-2 left-[72px] truncate text-[11px]/4 text-muted-foreground"
        title={secondary}
      >
        {secondary}
      </span>
      {task.status !== 'error' && task.status !== 'completed' && (
        <Progress
          value={progress}
          aria-label={`${task.name} ${progress}%`}
          className={`absolute top-[55px] right-2 left-[72px] h-1 gap-0 [&_[data-slot=progress-track]]:h-1 [&_[data-slot=progress-track]]:bg-muted ${
            task.status === 'paused'
              ? '[&_[data-slot=progress-indicator]]:bg-muted-foreground'
              : '[&_[data-slot=progress-indicator]]:bg-speed-download'
          }`}
        />
      )}
    </>
  )

  return (
    <li
      data-testid={`task-row-${task.id}`}
      className="relative h-[74px] shrink-0 after:pointer-events-none after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-border"
    >
      {revealReady ? (
        <button
          type="button"
          data-testid={`task-main-${task.id}`}
          className="absolute inset-y-0 right-[108px] left-0 text-left transition-colors hover:bg-muted/30 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none"
          aria-label={t('popup.tasks.openFolderTask', { name: task.name })}
          aria-describedby={secondaryId}
          aria-busy={revealing || undefined}
          disabled={revealing}
          onClick={() => onReveal(task.id)}
        >
          {taskContent}
        </button>
      ) : (
        <div className="absolute inset-y-0 right-[108px] left-0">
          {taskContent}
        </div>
      )}
      <div
        data-testid={`task-actions-${task.id}`}
        className="absolute top-[23px] right-3 z-10 flex w-[88px] items-center justify-end gap-0.5"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-testid={`task-reveal-${task.id}`}
          className="size-7 text-muted-foreground aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          aria-label={revealLabel}
          aria-busy={revealing || undefined}
          aria-disabled={revealUnavailable || undefined}
          title={revealLabel}
          onClick={(event) => {
            event.stopPropagation()
            if (revealUnavailable) return
            onReveal(task.id)
          }}
        >
          <FolderOpen className="size-3.5" aria-hidden="true" />
        </Button>
        {PAUSABLE.has(task.status) && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-7 text-muted-foreground"
            aria-label={pauseLabel}
            title={pauseLabel}
            onClick={(event) => {
              event.stopPropagation()
              onPause(task.id)
            }}
          >
            <Pause className="size-3.5" aria-hidden="true" />
          </Button>
        )}
        {RESUMABLE.has(task.status) && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-7 text-muted-foreground"
            aria-label={resumeLabel}
            title={resumeLabel}
            onClick={(event) => {
              event.stopPropagation()
              onResume(task.id)
            }}
          >
            <Play className="size-3.5" aria-hidden="true" />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          aria-label={removeLabel}
          title={removeLabel}
          onClick={(event) => {
            event.stopPropagation()
            onRemove(task.id)
          }}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
    </li>
  )
}

function EmptyTasks({ view }: { view: TaskView }): React.ReactElement {
  const { t } = useTranslation()
  return (
    <Empty role="status" className="h-full px-4 py-6">
      <EmptyHeader className="gap-2.5">
        <EmptyMedia className="mb-0 text-muted-foreground/55">
          <Inbox className="size-7" strokeWidth={1.5} aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle className="text-sm leading-5 font-medium tracking-normal text-muted-foreground">
          {t(`popup.tasks.empty.${view}`)}
        </EmptyTitle>
      </EmptyHeader>
    </Empty>
  )
}

interface ControlPanelProps {
  connection: ConnectionState | null
  controller: ControlPanelController
  canRevealTask?: boolean
  onReconnect: () => void
  notice?: ReactNode
}

export function ControlPanel({
  connection,
  controller,
  canRevealTask = false,
  onReconnect,
  notice,
}: ControlPanelProps): React.ReactElement {
  const { t } = useTranslation()
  const [view, setView] = useState<TaskView>('active')
  const [quickAddOpen, setQuickAddOpen] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [revealingTaskIds, setRevealingTaskIds] = useState<Set<string>>(
    () => new Set()
  )
  const tasksByView = useMemo(
    () =>
      Object.fromEntries(
        TASK_VIEWS.map((candidate) => [
          candidate,
          filterTasks(controller.tasks, candidate),
        ])
      ) as Record<TaskView, MdxpTask[]>,
    [controller.tasks]
  )
  const connectionPending =
    connection === null ||
    connection === 'bootstrapping' ||
    connection === 'connecting' ||
    connection === 'handshaking' ||
    connection === 'awaiting-code'

  const runAction = async (action: () => Promise<void>): Promise<void> => {
    setActionError(null)
    try {
      await action()
    } catch (error) {
      setActionError((error as Error).message)
    }
  }

  const revealTask = async (taskId: string): Promise<void> => {
    setActionError(null)
    setRevealingTaskIds((current) => new Set(current).add(taskId))
    try {
      await controller.reveal(taskId)
    } catch {
      // RPC messages can contain implementation details or local paths.
      // The popup deliberately surfaces stable, localized copy instead.
      setActionError(t('popup.tasks.openFolderError'))
    } finally {
      setRevealingTaskIds((current) => {
        const next = new Set(current)
        next.delete(taskId)
        return next
      })
    }
  }

  const filter = (
    <TabsList className="h-8 w-40 gap-0 rounded-[10px] bg-tab-background p-0.5 group-data-horizontal/tabs:h-8">
      {TASK_VIEWS.map((candidate) => (
        <TabsTrigger
          key={candidate}
          value={candidate}
          disabled={controller.loading}
          className="h-7 w-[52px] flex-none rounded-[8px] border-0 px-0 py-0 text-[11px] font-normal shadow-none group-data-[variant=default]/tabs-list:data-active:shadow-xs"
        >
          {t(`popup.tasks.filters.${candidate}`)}
        </TabsTrigger>
      ))}
    </TabsList>
  )
  const quickAddAction =
    connection === 'connected' ? (
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        className="size-8 rounded-full"
        aria-label={t('popup.quickAdd.title')}
        title={t('popup.quickAdd.title')}
        disabled={controller.loading}
        onClick={() => setQuickAddOpen(true)}
      >
        <Plus className="size-[18px]" aria-hidden="true" />
      </Button>
    ) : undefined

  return (
    <>
      <Tabs
        value={view}
        onValueChange={(value) => setView(value as TaskView)}
        className="h-full min-h-0 gap-0"
      >
        <CompactSectionToolbar
          title={t('popup.tasks.title')}
          controls={connection === 'connected' ? filter : undefined}
          action={quickAddAction}
        />
        <CompactContentCard
          data-testid="task-card"
          className="flex min-h-0 flex-col"
        >
          {notice !== undefined && notice !== null ? (
            <div className="shrink-0">{notice}</div>
          ) : null}
          {(controller.error || actionError) && connection === 'connected' && (
            <Alert variant="destructive" className="mx-3 mt-3 shrink-0 py-2">
              <AlertDescription>
                {actionError ?? controller.error}
              </AlertDescription>
            </Alert>
          )}
          <div className="min-h-0 flex-1">
            {connectionPending ||
            (connection === 'connected' && controller.loading) ? (
              <Empty className="h-full p-4">
                <EmptyHeader className="gap-2.5">
                  <EmptyMedia className="mb-0 text-muted-foreground/60">
                    <Spinner
                      className="size-5"
                      aria-label={t(
                        connectionPending
                          ? 'popup.status.connecting'
                          : 'popup.tasks.loading'
                      )}
                    />
                  </EmptyMedia>
                  <EmptyTitle className="text-sm leading-5 font-medium tracking-normal text-muted-foreground">
                    {t(
                      connectionPending
                        ? 'popup.status.connecting'
                        : 'popup.tasks.loading'
                    )}
                  </EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : connection !== 'connected' ? (
              <Empty className="h-full gap-2 p-3">
                <EmptyHeader className="gap-1">
                  <EmptyTitle className="text-sm leading-5 font-medium tracking-normal">
                    {t('popup.tasks.disconnectedTitle')}
                  </EmptyTitle>
                </EmptyHeader>
                <EmptyContent className="gap-2">
                  <Button type="button" size="sm" onClick={onReconnect}>
                    {t('popup.reconnect')}
                  </Button>
                </EmptyContent>
              </Empty>
            ) : (
              TASK_VIEWS.map((candidate) => (
                <TabsContent
                  key={candidate}
                  value={candidate}
                  className="h-full min-h-0 overflow-hidden"
                >
                  {tasksByView[candidate].length === 0 ? (
                    <EmptyTasks view={candidate} />
                  ) : (
                    <ScrollArea className="h-full w-full">
                      <ul className="flex min-h-0 flex-col">
                        {tasksByView[candidate].map((task) => (
                          <TaskRow
                            key={task.id}
                            task={task}
                            onPause={(id) =>
                              void runAction(() => controller.pause(id))
                            }
                            onResume={(id) =>
                              void runAction(() => controller.resume(id))
                            }
                            onReveal={(id) => void revealTask(id)}
                            onRemove={(id) =>
                              void runAction(() => controller.remove(id))
                            }
                            canRevealTask={canRevealTask}
                            revealing={revealingTaskIds.has(task.id)}
                          />
                        ))}
                      </ul>
                    </ScrollArea>
                  )}
                </TabsContent>
              ))
            )}
          </div>
          {connection === 'connected' && (
            <button
              type="button"
              className="flex h-11 w-full shrink-0 items-center justify-between px-4 text-xs font-normal text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              aria-label={`${t('popup.tasks.filters.recent')} (${tasksByView.recent.length})`}
              aria-current={view === 'recent' ? 'page' : undefined}
              onClick={() => setView('recent')}
            >
              <span className="flex items-center gap-1.5">
                <span className="tabular-nums">
                  {tasksByView.recent.length}
                </span>
                <span>{t('popup.tasks.filters.recent')}</span>
              </span>
              <ChevronRight className="size-4" aria-hidden="true" />
            </button>
          )}
        </CompactContentCard>
      </Tabs>
      <QuickAddTaskDialog
        open={quickAddOpen}
        onOpenChange={setQuickAddOpen}
        onCreated={async () => {
          setView('active')
          await controller.refresh()
        }}
      />
    </>
  )
}
