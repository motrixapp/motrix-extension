import { z } from 'zod'
import { normalizeTarget } from '@/background/capture/normalizeTarget'
import type {
  ConfirmationActions,
  DownloadConfirmationService,
} from '@/background/DownloadConfirmationService'
import { DownloadOutcomeUnknownError } from '@/background/download-errors'
import type { HandoffGuard } from '@/background/handoff/guard'
import type { ChromiumInterceptionDeps } from '@/background/interception/chromium'
import { confirmInterceptedDownload } from '@/background/interception/confirmDownload'
import { isEligibleDownload } from '@/background/interception/eligibility'
import {
  FencedHandoffError,
  type NativeHandoffPeer,
  reconcileHandoff,
  submitPausedHandoff,
} from '@/background/interception/pausedHandoff'
import type { ReplaySource } from '@/background/interception/replaySource'
import { decideTakeover } from '@/background/policy/decideTakeover'
import { type Browser, extensionBrowser as browser } from '@/shared/browser'
import { getBuildBrowser } from '@/shared/browserKind'
import type { DownloadOperation } from '@/shared/integration'
import {
  parseTakeoverConfig,
  TAKEOVER_CONFIG_KEY,
  type TakeoverConfig,
  type TakeoverTarget,
} from '@/shared/takeover'

const PREFIX = 'motrix.pausedDownload.'
const leaseSchema = z.object({
  id: z.number().int(),
  startTime: z.string(),
  phase: z.enum(['editing', 'submitting', 'accepted']),
  handoff: z
    .object({
      instanceId: z.uuid(),
      bindingId: z.string(),
      taskId: z.string().optional(),
      id: z.uuid(),
      hash: z.string().regex(/^[0-9a-f]{64}$/),
      phase: z.enum(['preparing', 'stopping', 'stopped']),
    })
    .optional(),
  endpointId: z.string(),
  revision: z.number(),
  operationId: z.string().optional(),
})
type Lease = z.infer<typeof leaseSchema>
type Store = Pick<typeof browser.storage.local, 'get' | 'set' | 'remove'>
type NativeDeps = Pick<
  ChromiumInterceptionDeps,
  'popup' | 'getConfig' | 'captureGuard' | 'selfExtensionId' | 'replaySource'
> & {
  onHandoffReady?: (listener: () => void) => void
  handoffPeer?: (
    endpointId: string,
    revision: number
  ) => NativeHandoffPeer | undefined
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

function held(item: Awaited<ReturnType<typeof live>>) {
  return (
    item?.paused &&
    (item.state === 'in_progress' ||
      (item.state === 'interrupted' && item.canResume))
  )
}

async function release(
  lease: Lease,
  store: Store,
  cancel: boolean,
  retainLease = false
) {
  const item = await live(lease)
  if (held(item)) {
    if (cancel) {
      await browser.downloads.cancel(lease.id)
      const stopped = await live(lease)
      if (
        (retainLease && !stopped) ||
        (stopped &&
          ((stopped.paused && stopped.canResume) ||
            stopped.state !== 'interrupted' ||
            stopped.error !== 'USER_CANCELED'))
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
  } else if (
    cancel &&
    (retainLease || (item && item.state !== 'interrupted'))
  ) {
    throw new Error('original download no longer held')
  }
  if (!retainLease) await store.remove(PREFIX + lease.id)
}

async function recover(
  store: Store,
  deps: NativeDeps,
  retry?: ReadonlySet<number>
) {
  for (const [key, value] of Object.entries(await store.get(null))) {
    if (!key.startsWith(PREFIX)) continue
    const parsed = leaseSchema.safeParse(value)
    if (!parsed.success || key !== PREFIX + parsed.data.id) continue
    const lease = parsed.data
    if (retry && (!lease.handoff || retry.has(lease.id))) continue
    try {
      if (lease.handoff) {
        const settlement = await reconcileHandoff(
          lease.handoff,
          deps.handoffPeer?.(lease.endpointId, lease.revision),
          async () => {
            const item = await live(lease)
            return (
              !item ||
              (item.state === 'interrupted' &&
                item.error === 'USER_CANCELED' &&
                !held(item))
            )
          }
        )
        if (settlement === 'unknown') {
          deps.report('unknown')
          continue
        }
        if (settlement === 'browser') {
          const original = await live(lease)
          if (
            lease.handoff.phase === 'stopping' &&
            original?.state === 'interrupted' &&
            !original.canResume
          ) {
            deps.report('cleanup')
            await store.remove(key)
          } else await release(lease, store, false)
        } else {
          if (settlement === 'stopped') deps.report('cleanup')
          await store.remove(key)
        }
        continue
      }
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
  let cachedConfig: TakeoverConfig | undefined
  void Promise.resolve(browser.storage.local.get(TAKEOVER_CONFIG_KEY))
    .then((saved) => {
      if (cachedConfig === undefined && TAKEOVER_CONFIG_KEY in saved)
        cachedConfig = parseTakeoverConfig(saved[TAKEOVER_CONFIG_KEY])
    })
    .catch(() => {})
  browser.downloads.onChanged.addListener((delta) => {
    if (
      delta.paused?.current === false ||
      delta.state?.current === 'complete' ||
      delta.error?.current === 'USER_CANCELED'
    )
      deps.confirmation.dismissPausedDownloads(delta.id)
  })
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && TAKEOVER_CONFIG_KEY in changes) {
      cachedConfig = parseTakeoverConfig(changes[TAKEOVER_CONFIG_KEY]?.newValue)
      deps.confirmation.dismissPausedDownloads()
    }
  })
  const ready = Promise.all([
    recover(browser.storage.local, deps),
    recover(browser.storage.session, deps),
  ])
  const active = new Set<number>()
  let recovery = ready
  deps.onHandoffReady?.(() => {
    recovery = recovery
      .catch(() => [])
      .then(() =>
        Promise.all([
          recover(browser.storage.local, deps, active),
          recover(browser.storage.session, deps, active),
        ])
      )
    void recovery.catch(() => deps.report('unknown'))
  })
  void ready.catch(() => deps.report('unknown'))
  browser.downloads.onCreated.addListener((item) => {
    if (!isEligibleDownload(item, deps.selfExtensionId)) return
    const window = deps.popup?.captureWindow()
    if (active.has(item.id)) return
    active.add(item.id)
    // On Chromium, freeze qualifying confirm-mode downloads immediately before
    // async recovery/IPC finishes so fast transfers cannot complete ahead of the
    // confirmation dialog. Only pre-pause when cached policy already says motrix.
    const prePause = maybePrePauseChromium(item, cachedConfig, deps)
    void handle(item, window, prePause, recovery, deps)
      .finally(() => active.delete(item.id))
      .catch(() => deps.report('cleanup'))
  })
}

function maybePrePauseChromium(
  item: Browser.downloads.DownloadItem,
  cachedConfig: TakeoverConfig | undefined,
  deps: NativeDeps
): Promise<boolean> {
  if (
    getBuildBrowser() !== 'chromium' ||
    item.state !== 'in_progress' ||
    item.paused ||
    !cachedConfig?.enabled ||
    cachedConfig.downloadMode !== 'confirm'
  )
    return Promise.resolve(false)
  const source = deps.replaySource(item)
  if (!source || source.fallback || !source.allowed())
    return Promise.resolve(false)
  const sizeBytes =
    item.totalBytes > 0 ? item.totalBytes : (source.size ?? null)
  const referrer = source.referer || item.referrer || source.source
  const filename = item.filename || source.filename
  const mime = item.mime || source.mime
  const preliminary = normalizeTarget({
    url: source.url,
    ...(referrer ? { referrer } : {}),
    ...(source.omitReferer ? { omitReferer: true } : {}),
    ...(filename ? { suggestedFilename: filename } : {}),
    ...(mime ? { mime } : {}),
    sizeBytes,
    origin: 'auto',
  })
  if (decideTakeover(cachedConfig, preliminary) !== 'motrix')
    return Promise.resolve(false)
  return Promise.resolve(browser.downloads.pause(item.id))
    .then(() => true)
    .catch(() => false)
}

async function handle(
  item: Browser.downloads.DownloadItem,
  window: Promise<number | null> | undefined,
  prePause: Promise<boolean>,
  recovery: Promise<unknown>,
  deps: NativeDeps
) {
  let handedToHold = false
  try {
    await recovery
    const cfg = await deps.getConfig()
    const prePaused = await prePause
    if (!cfg.enabled || cfg.downloadMode !== 'confirm') return
    const source = deps.replaySource.waitForResponse
      ? await deps.replaySource.waitForResponse(item)
      : deps.replaySource(item)
    if (!source) return
    const effectiveReferrer =
      source.referer || item.referrer || source.source || ''
    await confirmInterceptedDownload(
      {
        url: source.url,
        referrer: effectiveReferrer,
        ...(source.omitReferer ? { omitReferer: true } : {}),
        filename: item.filename || source.filename || '',
        mime: item.mime || source.mime || '',
        totalBytes: item.totalBytes > 0 ? item.totalBytes : (source.size ?? -1),
      },
      cfg,
      source.tabId !== undefined && source.tabId >= 0
        ? browser.tabs
            .get(source.tabId)
            .then((tab) => tab.windowId)
            .catch(() => window ?? null)
        : window,
      {
        captureGuard: deps.captureGuard,
        confirm: async (target, windowId, guard) => {
          if (windowId !== undefined && guard.endpointId) {
            await holdForDecision(
              item,
              { ...target, pausedDownloadId: item.id },
              windowId,
              guard,
              guard.endpointId,
              source,
              prePaused,
              () => {
                handedToHold = true
              },
              deps
            )
          }
        },
      }
    )
  } finally {
    if (!handedToHold && (await prePause)) {
      await browser.downloads.resume(item.id).catch(() => {})
    }
  }
}
async function holdForDecision(
  item: Browser.downloads.DownloadItem,
  target: TakeoverTarget,
  windowId: number,
  guard: HandoffGuard,
  endpointId: string,
  source: ReplaySource,
  prePaused: boolean,
  onTakeOver: () => void,
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
  let before = await live(lease)
  let alreadyPaused = prePaused && Boolean(held(before))
  if (!alreadyPaused && getBuildBrowser() === 'firefox') {
    // Firefox implements pause by interrupting the transfer. Before the
    // first bytes arrive it may have no partial data to retain or resume.
    const deadline = Date.now() + 4000
    while (
      before?.state === 'in_progress' &&
      !before.paused &&
      !(before.bytesReceived > 0)
    ) {
      if (Date.now() >= deadline) return
      await new Promise((r) => setTimeout(r, 40))
      before = await live(lease)
    }
  }
  if (!alreadyPaused && (before?.state !== 'in_progress' || before.paused))
    return
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
  onTakeOver()
  try {
    await current()
    await save()
    if (!alreadyPaused) {
      const active = await live(lease)
      if (prePaused && held(active)) {
        // Our own prePause became visible while saving the lease.
        alreadyPaused = true
      } else if (active?.state !== 'in_progress' || active.paused) {
        actionStarted = true
        await store.remove(PREFIX + lease.id)
        return
      } else {
        await browser.downloads.pause(item.id)
        alreadyPaused = true
      }
    }
    const assertPaused = async () => {
      const now = await live(lease)
      if (!held(now)) throw new Error('original download no longer paused')
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
            const peer = deps.handoffPeer?.(lease.endpointId, lease.revision)
            if (peer?.acceptingNew) {
              const result = await submitPausedHandoff({
                peer,
                target,
                options,
                check: beforeSend,
                save: async (record) => {
                  lease.handoff = record
                  await save()
                },
                stop: () => release(lease, store, true, true),
              })
              try {
                await store.remove(PREFIX + item.id)
              } catch {
                deps.report('cleanup')
              }
              return result
            }
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
            if (error instanceof FencedHandoffError && error.stopAttempted) {
              const original = await live(lease)
              if (
                !original ||
                (original.state === 'interrupted' && !original.canResume)
              ) {
                await store.remove(PREFIX + item.id)
                deps.report('cleanup')
                throw error
              }
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
