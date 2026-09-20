import type { AutoOpenPopupService } from '@/background/AutoOpenPopupService'
import { downloadHttpInBrowser } from '@/background/contextMenu/register'
import type { HandoffGuard } from '@/background/handoff/guard'
import { makeOps, type OpsDeps } from '@/background/handoff/makeOps'
import { runHandoff } from '@/background/handoff/runHandoff'
import type { TakeoverTarget } from '@/shared/takeover'

type ContextMenuDownloadDeps = Pick<
  OpsDeps,
  'manager' | 'isPaired' | 'gate' | 'nudge' | 'notify'
> & {
  popup: Pick<AutoOpenPopupService, 'captureSubmission'>
  ready(): Promise<unknown>
  captureGuard(): Promise<HandoffGuard | null>
}

export function createContextMenuDownloadRunner(deps: ContextMenuDownloadDeps) {
  return async (target: TakeoverTarget): Promise<void> => {
    const present = deps.popup.captureSubmission()
    await deps.ready()
    const guard = await deps.captureGuard()
    if (guard === null) return
    const result = await runHandoff(
      target,
      makeOps({
        ...deps,
        guard,
        cancelNative: async () => {},
        fallbackToBrowser: () => downloadHttpInBrowser(target.url),
        // Sensitive sites continue in the browser until per-download consent exists.
        confirmSensitive: async () => false,
      })
    )
    if (result.kind === 'accepted') void present(result, guard).catch(() => {})
  }
}
