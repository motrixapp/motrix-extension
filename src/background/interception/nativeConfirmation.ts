import { z } from 'zod'
import type {
  ConfirmationActions,
  DownloadConfirmationService,
} from '@/background/DownloadConfirmationService'
import { DownloadOutcomeUnknownError } from '@/background/download-errors'
import type { HandoffGuard } from '@/background/handoff/guard'
import type { ChromiumInterceptionDeps } from '@/background/interception/chromium'
import { confirmInterceptedDownload } from '@/background/interception/confirmDownload'
import { isEligibleDownload } from '@/background/interception/eligibility'
import type {
  ReplayItem,
  ReplaySource,
} from '@/background/interception/replaySource'
import { decideTakeover } from '@/background/policy/decideTakeover'
import { type Browser, extensionBrowser as browser } from '@/shared/browser'
import type { DownloadOperation } from '@/shared/integration'
import type { TakeoverTarget } from '@/shared/takeover'

const PREFIX = 'motrix.pausedDownload.'
const leaseSchema = z.object({
  id: z.number().int(),
  startTime: z.string(),
  phase: z.enum(['editing', 'submitting', 'accepted']),
  endpointId: z.string(),
  revision: z.number(),
  operationId: z.string().optional(),
})
type Lease = z.infer<typeof leaseSchema>
type Store = Pick<typeof browser.storage.local, 'get' | 'set' | 'remove'>
type NativeDeps = Pick<
  ChromiumInterceptionDeps,
  'popup' | 'getConfig' | 'captureGuard' | 'selfExtensionId'
> & {
  replaySource(item: ReplayItem): ReplaySource | null
  confirmation: Pick<
    DownloadConfirmationService,
    'request' | 'dismissPausedDownloads'
  >
  actions(
    target: TakeoverTarget,
    guard: HandoffGuard,
    beforeSend: () => Promise<void>
  ): ConfirmationActions
  operations(endpointId: string, revision: number): Promise<DownloadOperation[]>
  report(outcome: 'resumed' | 'unknown' | 'cleanup'): void
}

async function live(lease: Lease) {
  const [item] = await browser.downloads.search({ id: lease.id })
  return item?.startTime === lease.startTime ? item : undefined
}

async function release(lease: Lease, store: Store, cancel: boolean) {
  const item = await live(lease)
  if (item?.paused && item.state !== 'complete') {
    if (cancel) {
      await browser.downloads.cancel(lease.id)
      const stopped = await live(lease)
      if (
        stopped &&
        ((stopped.paused && stopped.canResume) ||
          stopped.state !== 'interrupted' ||
          stopped.error !== 'USER_CANCELED')
      )
        throw new Error('native cancellation unconfirmed')
    } else {
      await browser.downloads.resume(lease.id)
      // Firefox resolves resume() while the DownloadItem may still expose
      // its paused/interrupted snapshot. Observe the transition on this ID.
      const deadline = Date.now() + 2000
      while (true) {
        // Firefox updates startTime when resuming a DownloadItem. Its numeric
        // ID still identifies the operation we just resumed.
        const [resumed] = await browser.downloads.search({ id: lease.id })
        if (resumed && !resumed.paused && resumed.state !== 'interrupted') break
        if (!resumed || Date.now() >= deadline)
          throw new Error('native resume unconfirmed')
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
    }
  } else if (cancel && item && item.state !== 'interrupted') {
    throw new Error('original download no longer held')
  }
  await store.remove(PREFIX + lease.id)
}

async function recover(store: Store, deps: NativeDeps) {
  for (const [key, value] of Object.entries(await store.get(null))) {
    if (!key.startsWith(PREFIX)) continue
    const parsed = leaseSchema.safeParse(value)
    if (!parsed.success || key !== PREFIX + parsed.data.id) continue
    const lease = parsed.data
    try {
      const item = await live(lease)
      if (!item || item.state === 'complete' || !item.paused) {
        await store.remove(key)
        continue
      }
      if (lease.phase === 'submitting') {
        const record = (
          await deps.operations(lease.endpointId, lease.revision)
        ).find((r) => r.id === lease.operationId)
        if (record?.state === 'accepted') lease.phase = 'accepted'
        else if (record?.state === 'failed') lease.phase = 'editing'
        else {
          deps.report('unknown')
          continue
        }
      }
      await release(lease, store, lease.phase === 'accepted')
    } catch {
      deps.report('unknown')
    }
  }
}

export function registerNativeConfirmation(deps: NativeDeps) {
  browser.downloads.onChanged.addListener((delta) => {
    if (delta.paused?.current === false || delta.state?.current === 'complete')
      deps.confirmation.dismissPausedDownloads(delta.id)
  })
  browser.storage.onChanged.addListener((changes, area) => {
    if (
      area === 'local' &&
      (changes['motrix.takeoverConfig'] ||
        changes['motrix.downloadProtection.v1'])
    )
      deps.confirmation.dismissPausedDownloads()
  })
  const ready = Promise.all([
    recover(browser.storage.local, deps),
    recover(browser.storage.session, deps),
  ])
  void ready.catch(() => deps.report('unknown'))
  browser.downloads.onCreated.addListener((item) => {
    if (!isEligibleDownload(item, deps.selfExtensionId)) return
    const window = deps.popup?.captureWindow()
    void ready
      .then(() => handle(item, window, deps))
      .catch(() => deps.report('cleanup'))
  })
}

async function handle(
  item: Browser.downloads.DownloadItem,
  window: Promise<number | null> | undefined,
  deps: NativeDeps
) {
  const cfg = await deps.getConfig()
  if (!cfg.enabled || cfg.downloadMode !== 'confirm') return
  const source = deps.replaySource(item)
  if (!source) return
  await confirmInterceptedDownload(
    {
      url: source.url,
      referrer: item.referrer || source.source || '',
      filename: item.filename || source.filename || '',
      mime: item.mime || source.mime || '',
      totalBytes: item.totalBytes > 0 ? item.totalBytes : (source.size ?? -1),
    },
    cfg,
    source.tabId === undefined
      ? window
      : source.tabId >= 0
        ? browser.tabs
            .get(source.tabId)
            .then((tab) => tab.windowId)
            .catch(() => null)
        : Promise.resolve(null),
    {
      captureGuard: deps.captureGuard,
      confirm: async (target, windowId, guard) => {
        if (windowId !== undefined && guard.endpointId)
          await holdForDecision(
            item,
            { ...target, pausedDownloadId: item.id },
            windowId,
            guard,
            guard.endpointId,
            source,
            deps
          )
      },
    }
  )
}
async function holdForDecision(
  item: Browser.downloads.DownloadItem,
  target: TakeoverTarget,
  windowId: number,
  guard: HandoffGuard,
  endpointId: string,
  source: ReplaySource,
  deps: NativeDeps
) {
  const lease: Lease = {
    id: item.id,
    startTime: item.startTime,
    endpointId,
    revision: guard.endpointRevision ?? 0,
    phase: 'editing',
  }
  const store = item.incognito ? browser.storage.session : browser.storage.local
  const save = () => store.set({ [PREFIX + item.id]: { ...lease } })
  const before = await live(lease)
  if (before?.state !== 'in_progress' || before.paused) return
  const current = async () => {
    const next = await deps.getConfig()
    guard.assertCurrent()
    if (
      next.downloadMode !== 'confirm' ||
      decideTakeover(next, target) !== 'motrix' ||
      !source.allowed()
    )
      throw new Error('download policy changed')
  }
  await current()
  await save()
  let actionStarted = false
  const finish = async (cancel: boolean) => {
    actionStarted = true
    try {
      await release(lease, store, cancel)
    } catch (error) {
      deps.report('cleanup')
      throw error
    }
  }
  try {
    const active = await live(lease)
    if (active?.state !== 'in_progress' || active.paused) {
      actionStarted = true
      await store.remove(PREFIX + lease.id)
      return
    }
    await browser.downloads.pause(item.id)
    const assertPaused = async () => {
      const now = await live(lease)
      if (!now?.paused || now.state === 'complete')
        throw new Error('original download no longer paused')
    }
    await assertPaused()
    await current()
    const beforeSend = async () => {
      await current()
      await assertPaused()
    }
    const base = deps.actions(target, guard, beforeSend)
    await deps.confirmation.request(
      target,
      windowId,
      {
        browser: () => finish(false),
        cancel: () => finish(true),
        submit: async (options, id) => {
          actionStarted = true
          try {
            await beforeSend()
            lease.phase = 'submitting'
            lease.operationId = id
            await save()
            const accepted = await base.submit(options, id)
            lease.phase = 'accepted'
            // The peer already owns this task. Cleanup cannot turn it into a retry.
            try {
              await save()
              await release(lease, store, true)
            } catch {
              deps.report('cleanup')
            }
            return accepted
          } catch (error) {
            if (error instanceof DownloadOutcomeUnknownError) {
              deps.report('unknown')
              throw new DownloadOutcomeUnknownError()
            }
            lease.phase = 'editing'
            await finish(false)
            deps.report('resumed')
            throw error
          }
        },
      },
      { endpointId: lease.endpointId, endpointRevision: lease.revision }
    )
  } finally {
    if (!actionStarted && lease.phase === 'editing') await finish(false)
  }
}
