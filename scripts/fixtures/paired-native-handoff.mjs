// Built only by local paired acceptance. This SDK resolves to a local candidate
// checkout; shipping bundles keep their published dependency and legacy path.

import * as sdk from 'virtual:paired-handoff-sdk'
import { Methods as installedMethods } from '@motrix/mdxp/browser'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { ConnectionManager } from '@/background/ConnectionManager'
import { buildSubmitParams } from '@/background/capture/buildSubmitParams'
import { DownloadConfirmationService } from '@/background/DownloadConfirmationService'
import { candidateHandoffPeer } from '@/background/interception/candidatePeer'
import { registerNativeConfirmation } from '@/background/interception/nativeConfirmation'
import { observeReplaySources } from '@/background/interception/replaySource'
import { DiscoveryService } from '@/background/mbp1/discovery-service'
import { PinStore } from '@/background/mbp1/pin-store'
import { DownloadConfirmationForm } from '@/popup/DownloadConfirmationDialog'
import { extensionBrowser as browser, nativeBrowser } from '@/shared/browser'
import { i18n } from '@/shared/i18n'
import { TAKEOVER_DEFAULT } from '@/shared/takeover'
import { applyTaskOptions } from '@/shared/taskOptions'

const chromium = !!nativeBrowser.downloads.onDeterminingFilename
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
let manager,
  origin,
  caseName = '',
  failure = '',
  events = [],
  nativeId,
  connected,
  stage
function peer() {
  const candidate = candidateHandoffPeer(
    manager,
    sdk,
    async (target, options) =>
      applyTaskOptions(buildSubmitParams(target, [], {}), options)
  )
  if (!candidate) return
  const observe = async (method) => {
    const [d] =
      nativeId === undefined
        ? []
        : await browser.downloads.search({ id: nativeId })
    events.push({
      method,
      id: d?.id,
      paused: d?.paused,
      canResume: d?.canResume,
      state: d?.state,
      error: d?.error,
    })
  }
  return {
    ...candidate,
    freeze: async (...args) => {
      const f = await candidate.freeze(...args)
      return {
        ...f,
        prepare: async (id) => {
          await observe('Prepare')
          return f.prepare(id)
        },
      }
    },
    status: async (id) => {
      await observe('Status')
      return candidate.status(id)
    },
    abort: async (id) => {
      await observe('Abort')
      return candidate.abort(id)
    },
    commit: async (id, h) => {
      await observe('Commit')
      return candidate.commit(id, h)
    },
  }
}
function promptCode({ timeoutMs }) {
  return new Promise((resolve, reject) => {
    const form = document.createElement('form'),
      field = document.createElement('input'),
      button = document.createElement('button')
    const timer = setTimeout(() => {
      field.value = ''
      form.remove()
      reject(new Error('Pairing form expired'))
    }, timeoutMs)
    field.id = 'pair-code'
    field.type = 'password'
    button.textContent = 'Pair'
    form.append(field, button)
    document.body.append(form)
    form.onsubmit = (e) => {
      e.preventDefault()
      clearTimeout(timer)
      const code = field.value
      field.value = ''
      form.remove()
      resolve(code)
    }
  })
}
window.beginPairedHandoff = (port, baseUrl) => {
  if (installedMethods.MotrixInitialize !== sdk.Methods.MotrixInitialize)
    throw Error('Incompatible initialize method')
  origin = baseUrl
  const pins = new PinStore()
  manager = new ConnectionManager({
    clientInfo: {
      kind: 'extension',
      name: 'Motrix local acceptance',
      version: '1.0.0',
      extensionId: browser.runtime.id,
      browser: chromium ? 'chromium' : 'firefox',
      browserVersion: navigator.userAgent,
      locale: 'en-US',
    },
    pinStore: pins,
    discoveryService: new DiscoveryService({ pins, candidatePorts: [port] }),
    pairingCodeSource: promptCode,
  })
  connected = manager
    .clearGateAndStart()
    .then(() => {
      const p = peer()
      if (!p?.acceptingNew)
        throw Error(
          'Capability not negotiated: ' +
            manager.getState() +
            ' ' +
            String(manager.getLastError?.() ?? '')
        )
      return p.instanceId
    })
    .catch((e) => {
      failure = e.message
      return null
    })
  const root = createRoot(
    document.body.appendChild(document.createElement('div'))
  )
  const service = new DownloadConfirmationService({
    supported: () => true,
    userAgent: () => navigator.userAgent,
    publish: (id, draft) =>
      root.render(
        draft
          ? createElement(DownloadConfirmationForm, {
              draft,
              onDismiss: () => service.close(id),
              onDecide: (d) => service.decide(id, draft.id, d),
            })
          : null
      ),
    open: async (id) => {
      try {
        const draft = service.get(id)
        const [before] = await browser.downloads.search({
          id: draft.target.pausedDownloadId,
        })
        await delay(400)
        const [held] = await browser.downloads.search({ id: before.id })
        if (
          !before.paused ||
          !held.paused ||
          before.bytesReceived !== held.bytesReceived
        )
          throw Error('Browser continued during confirmation')
        events.push({
          event: 'hold',
          id: before.id,
          bytes: before.bytesReceived,
        })
        const action =
          caseName === 'paired-cancel'
            ? 'popup.quickAdd.cancel'
            : caseName === 'paired-browser'
              ? 'popup.confirmDownload.keepBrowser'
              : 'popup.quickAdd.add'
        if (action === 'popup.quickAdd.add') {
          const headers = document.querySelector('textarea[id$="-headers"]')
          Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            'value'
          ).set.call(headers, 'X-Motrix-Fixture: paired')
          headers.dispatchEvent(new Event('input', { bubbles: true }))
          await delay(20)
        }
        const button = [...document.querySelectorAll('button')].find(
          (b) => b.textContent.trim() === i18n.t(action)
        )
        if (!button || button.disabled)
          throw Error('Confirmation action unavailable')
        button.click()
      } catch (e) {
        failure = e.message
        throw e
      }
    },
  })
  browser.downloads.onCreated.addListener((d) => {
    if (d.url === `${origin}/download/${caseName}`) {
      nativeId = d.id
      events.push({ event: 'created', state: d.state, size: d.totalBytes })
    }
  })
  for (const kind of ['onBeforeRequest', 'onHeadersReceived'])
    browser.webRequest[kind].addListener(
      (d) => {
        if (d.url === `${origin}/download/${caseName}`)
          events.push({
            event: kind,
            tabId: d.tabId,
            type: d.type,
            scheme: (d.documentUrl ?? d.originUrl ?? d.initiator)?.split(
              ':'
            )[0],
            status: d.statusCode,
          })
      },
      { urls: ['http://127.0.0.1/*'] }
    )
  browser.downloads.onChanged.addListener((d) => {
    if (d.id === nativeId)
      void browser.downloads.search({ id: d.id }).then(([x]) => {
        if (x)
          events.push({
            event: 'native',
            state: x.state,
            bytes: x.bytesReceived,
            paused: x.paused,
            canResume: x.canResume,
            error: x.error,
          })
      })
  })
  const replaySource = observeReplaySources(
    () => false,
    (url) => url === `${origin}/download/${caseName}`
  )
  registerNativeConfirmation({
    selfExtensionId: browser.runtime.id,
    getConfig: async () => ({
      ...TAKEOVER_DEFAULT,
      enabled: true,
      downloadMode: 'confirm',
      unknownSizeAction: 'motrix',
    }),
    captureGuard: async () => ({
      origin: 'auto',
      endpointId: 'paired-local',
      endpointRevision: 1,
      assertCurrent() {
        if (manager.getState() !== 'connected') throw Error('Disconnected')
      },
    }),
    replaySource,
    confirmation: {
      dismissPausedDownloads: (id) => service.dismissPausedDownloads(id),
      request: async (...args) => {
        const r = await service.request(...args)
        stage = r.action
        return r
      },
    },
    actions: () => ({
      submit: async () => {
        throw Error('Unexpected legacy submit')
      },
    }),
    onHandoffReady: (listener) =>
      manager.onStateChange((state) => {
        if (state === 'connected') listener()
      }),
    handoffPeer: peer,
    operations: async () => [],
    report: (outcome) => events.push({ event: 'report', outcome }),
  })
  return true
}
window.pairedState = () => ({
  state: manager.getState(),
  input: !!document.querySelector('#pair-code'),
  failure,
})
window.finishPairing = async () => {
  const id = await Promise.race([
    connected,
    delay(10000).then(() => {
      throw Error(`Pairing deadline ${manager.getState()} ${failure}`)
    }),
  ])
  if (!id) throw Error(failure || 'No paired ledger')
  const capability = sdk.DownloadHandoffCapabilitySchema.parse(
    manager.getLocalHandoffChannel().advertisement
  )
  return {
    instanceId: id,
    capability,
    runtime: manager.getServerIdentity().runtime,
  }
}
window.runPairedCase = async (name) => {
  caseName = name
  failure = ''
  events = []
  nativeId = undefined
  stage = undefined
  const tab = await browser.tabs.create({
    url: `${origin}/start/${name}?click=1`,
  })
  try {
    const until = Date.now() + 14000
    let item
    while (Date.now() < until && !failure) {
      if (nativeId !== undefined)
        [item] = await browser.downloads.search({ id: nativeId })
      const complete = name === 'paired-browser' || name === 'paired-rejected'
      if (
        stage &&
        (complete ? item?.state === 'complete' : item?.state === 'interrupted')
      )
        break
      await delay(40)
    }
    if (!stage || failure)
      throw Error(
        failure ||
          'Timed out waiting for native outcome: ' +
            JSON.stringify({
              events,
              state: item?.state,
              paused: item?.paused,
              nativeId,
              chromium,
              tab: tab.url?.split('/').at(-1),
            })
      )
    return {
      stage,
      events,
      id: nativeId,
      state: item?.state,
      filename: item?.filename,
    }
  } finally {
    if (tab.id !== undefined) await browser.tabs.remove(tab.id)
  }
}
