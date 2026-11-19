import type { DownloadSubmitParams } from '@motrix/mdxp'
import type { ConnectionManager } from '@/background/ConnectionManager'
import type {
  HandoffState,
  NativeHandoffPeer,
} from '@/background/interception/pausedHandoff'

type Command = 'Prepare' | 'Status' | 'Abort' | 'Commit'
type Reply = HandoffState & { instanceId: string; operationId: string }
export type CandidateSdk = {
  DownloadHandoffCapabilitySchema: {
    safeParse(
      value: unknown
    ):
      | { success: true; data: { instanceId: string; acceptingNew: boolean } }
      | { success: false }
  }
  canonicalDownloadHandoffPayload(value: unknown): string
  Methods: {
    [K in Command as `DownloadHandoff${K}`]: `download/handoff.${Lowercase<K>}`
  }
} & {
  [K in Command as `DownloadHandoff${K}ResultSchema`]: {
    parse(value: unknown): Reply
  }
}

export function candidateHandoffPeer(
  manager: ConnectionManager,
  sdk: CandidateSdk,
  build: (
    ...args: Parameters<NativeHandoffPeer['freeze']>
  ) => Promise<DownloadSubmitParams>
): NativeHandoffPeer | undefined {
  const channel = manager.getLocalHandoffChannel()
  if (!channel) return
  const cap = sdk.DownloadHandoffCapabilitySchema.safeParse(
    channel.advertisement
  )
  if (!cap.success) return
  const { instanceId, acceptingNew } = cap.data
  const bindingId = channel.bindingId
  async function call(name: Command, id: string, params: object = {}) {
    let active = manager.getLocalHandoffChannel()
    if (name !== 'Prepare') {
      // Only observe the manager's ordinary reconnect. Never start a new pairing
      // or issue a mutation against another authenticated host/installation.
      const until = Date.now() + 5000
      while (!active && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 80))
        active = manager.getLocalHandoffChannel()
      }
    }
    const live = sdk.DownloadHandoffCapabilitySchema.safeParse(
      active?.advertisement
    )
    if (
      !active ||
      active.bindingId !== bindingId ||
      !live.success ||
      live.data.instanceId !== instanceId
    )
      throw new Error('Handoff session changed')
    const result = sdk[`DownloadHandoff${name}ResultSchema`].parse(
      await active.request(sdk.Methods[`DownloadHandoff${name}`], {
        instanceId,
        operationId: id,
        ...params,
      })
    )
    if (result.instanceId !== instanceId || result.operationId !== id)
      throw new Error('Mismatched handoff response key')
    return result
  }
  return {
    instanceId,
    bindingId,
    acceptingNew,
    freeze: async (target, options) => {
      const download = await build(target, options)
      const bytes = new TextEncoder().encode(
        sdk.canonicalDownloadHandoffPayload(download)
      )
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        (b) => b.toString(16).padStart(2, '0')
      ).join('')
      return { hash, prepare: (id) => call('Prepare', id, { download }) }
    },
    status: (id) => call('Status', id),
    abort: (id) => call('Abort', id),
    commit: (id, hash) => call('Commit', id, { payloadHash: hash }),
  }
}
