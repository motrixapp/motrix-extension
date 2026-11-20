import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { zipSync } from 'fflate'
import { build } from 'vite'
import { waitForFirefoxFixture } from './fixtures/firefox-readiness.mjs'
import { createMdxpSimulator } from './fixtures/mdxp-simulator.mjs'
import {
  buildPairedFixture,
  pairedMode,
  runPairedBrowser,
} from './fixtures/paired-browser-driver.mjs'
import {
  buildClickScript,
  clickScript,
  verifyClickResult,
} from './fixtures/release-click-browser.mjs'
import { createTakeoverOrigin } from './fixtures/takeover-origin.mjs'
import {
  FIREFOX_CASES,
  verifyTakeoverReport,
} from './verify-takeover-report.mjs'

const binary =
  process.env.FIREFOX_BINARY ??
  '/Applications/Firefox.app/Contents/MacOS/firefox'
const app = process.env.FIREFOX_APP
const appLog = (directory) => join(directory, 'launch-services.log')
const root = resolve(import.meta.dirname, '..')
const reportDirectory = resolve(
  process.env.TAKEOVER_REPORT_DIR ??
    join(
      root,
      pairedMode
        ? '.cache/paired-handoff/firefox-runtime'
        : '.cache/firefox-takeover-report'
    )
)
const report = {
  schemaVersion: 1,
  suite: pairedMode ? 'paired-download-handoff' : 'firefox-browser-integration',
  backend: pairedMode ? 'MBP1 WebSocket + SQLite + aria2' : 'mdxp-simulator',
  revision: process.env.GITHUB_SHA ?? null,
  status: 'running',
  startedAt: new Date().toISOString(),
  cases: [],
}
let activeCase
let diagnostics = ''
await mkdir(reportDirectory, { recursive: true })
const saveReport = () =>
  writeFile(
    join(reportDirectory, 'report.json'),
    JSON.stringify(report, null, 2)
  )
await saveReport()
const temporary = await mkdtemp(
  join(resolve(process.env.TAKEOVER_TEMP_ROOT ?? tmpdir()), 'firefox-takeover-')
)
const extension = join(temporary, 'extension')
const profile = join(temporary, 'profile')
const uuid = 'bd2a973c-7f7b-468e-bd3d-03f8bc59336f'
const { requests, unicodeFilenames, transfers, server } = createTakeoverOrigin()
let firefox
let socket
let sequence = 0
const pending = new Map()
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const simulator = createMdxpSimulator(server)
const command = (method, params) =>
  new Promise((accept, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out`))
    }, 20_000)
    pending.set(id, {
      accept(value) {
        clearTimeout(timer)
        accept(value)
      },
      reject(error) {
        clearTimeout(timer)
        reject(error)
      },
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
try {
  await mkdir(extension)
  await mkdir(profile)
  if (pairedMode) await buildPairedFixture(root, extension, 'firefox')
  else
    await build({
      configFile: false,
      root,
      define: {
        'process.env.NODE_ENV': JSON.stringify('production'),
        __BROWSER__: JSON.stringify('firefox'),
      },
      logLevel: 'error',
      resolve: { alias: { '@': join(root, 'src') } },
      build: {
        outDir: extension,
        emptyOutDir: false,
        lib: {
          entry: join(root, 'scripts/fixtures/firefox-takeover.ts'),
          formats: ['iife'],
          name: 'fixture',
          fileName: () => 'fixture.js',
        },
      },
    })
  await buildClickScript(root, extension)
  await writeFile(
    join(extension, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      content_scripts: [clickScript],
      name: 'Motrix Firefox takeover regression fixture',
      version: '1.0',
      permissions: [
        'downloads',
        'cookies',
        'storage',
        'tabs',
        'webRequest',
        'webRequestBlocking',
      ],
      host_permissions: ['http://127.0.0.1/*'],
      browser_specific_settings: {
        gecko: {
          id: 'motrix-takeover-fixture@motrix.app',
          data_collection_permissions: { required: ['none'] },
        },
      },
      options_ui: { page: 'runner.html', open_in_tab: true },
      background: { scripts: ['bootstrap.js'] },
      content_security_policy: {
        extension_pages: "script-src 'self'; object-src 'self';",
      },
    })
  )
  await writeFile(
    join(extension, 'runner.html'),
    '<!doctype html><meta charset="utf-8"><script src="fixture.js"></script>'
  )
  await writeFile(
    join(extension, 'bootstrap.js'),
    'browser.runtime.openOptionsPage();'
  )
  await writeFile(
    join(profile, 'user.js'),
    [
      `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ 'motrix-takeover-fixture@motrix.app': uuid }))});`,
      'user_pref("browser.download.useDownloadDir", true);',
      'user_pref("browser.download.folderList", 2);',
      'user_pref("extensions.logging.enabled", true);',
      'user_pref("devtools.console.stdout.chrome", true);',
      `user_pref("browser.download.dir", ${JSON.stringify(temporary)});`,
    ].join('\n')
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  // Obtain a separate free port for Firefox's WebDriver BiDi endpoint.
  const portServer = createServer()
  portServer.listen(0, '127.0.0.1')
  await once(portServer, 'listening')
  const port = portServer.address().port
  await new Promise((r) => portServer.close(r))
  const browserArgs = [
    ...(process.env.FIREFOX_APPLICATION_INI
      ? ['-app', process.env.FIREFOX_APPLICATION_INI]
      : []),
    '--headless',
    '--no-remote',
    '--profile',
    profile,
    '--remote-debugging-port',
    String(port),
    '--remote-allow-system-access',
  ]
  firefox = spawn(
    app ? '/usr/bin/open' : binary,
    app
      ? [
          '-n',
          '-W',
          '-g',
          '-a',
          app,
          '--stdout',
          appLog(reportDirectory),
          '--stderr',
          appLog(reportDirectory),
          '--args',
          ...browserArgs,
        ]
      : browserArgs,
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Current Firefox gates privileged BiDi commands (including temporary
      // extension installation) on this variable. Scope it to the isolated
      // fixture browser; retain the command-line flag for older releases.
      env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
    }
  )
  firefox.on('error', (error) => process.stderr.write(`${error.message}\n`))
  firefox.stderr.on('data', (data) => {
    if (process.env.FIREFOX_DEBUG) process.stderr.write(data)
    diagnostics = (diagnostics + data).slice(-3000)
  })
  firefox.stdout.on('data', (data) => {
    if (process.env.FIREFOX_DEBUG) process.stderr.write(data)
    diagnostics = (diagnostics + data).slice(-3000)
  })
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && !socket) {
    const candidate = new WebSocket(`ws://127.0.0.1:${port}/session`)
    const opened = await new Promise((r) => {
      candidate.addEventListener('open', () => r(true), { once: true })
      candidate.addEventListener('error', () => r(false), { once: true })
    })
    if (opened) socket = candidate
    else await delay(100)
    if (app)
      diagnostics = await readFile(appLog(reportDirectory), 'utf8').catch(
        () => diagnostics
      )
    if (firefox.exitCode !== null) break
  }
  assert.ok(socket, `Firefox BiDi unavailable: ${diagnostics}`)
  socket.addEventListener('message', ({ data }) => {
    const response = JSON.parse(data)
    const request = pending.get(response.id)
    if (!request) return
    pending.delete(response.id)
    if (response.type === 'error')
      request.reject(new Error(`${response.error}: ${response.message}`))
    else request.accept(response.result)
  })
  const session = await command('session.new', {
    capabilities: { alwaysMatch: { browserName: 'firefox' } },
  })
  console.log(`Firefox ${session.capabilities.browserVersion}`)
  report.browserVersion = session.capabilities.browserVersion
  try {
    const archive = zipSync(
      Object.fromEntries(
        await Promise.all(
          [
            'manifest.json',
            'runner.html',
            'fixture.js',
            'bootstrap.js',
            'release-click.js',
          ].map(async (name) => [
            name,
            new Uint8Array(await readFile(join(extension, name))),
          ])
        )
      )
    )
    report.extensionSha256 = createHash('sha256').update(archive).digest('hex')
    // Firefox 143 content processes need the archive when they load a new tab.
    const archivePath = resolve(profile, 'takeover-fixture.xpi')
    await writeFile(archivePath, archive)
    await command('webExtension.install', {
      extensionData: {
        type: 'archivePath',
        path: archivePath,
      },
    })
  } catch (error) {
    console.error(diagnostics)
    throw error
  }
  const context = await waitForFirefoxFixture(
    command,
    `moz-extension://${uuid}/runner.html`,
    pairedMode
      ? { expression: 'typeof beginPairedHandoff==="function"' }
      : undefined
  )
  if (pairedMode) {
    async function evaluate(expression) {
      const result = await command('script.evaluate', {
        expression: `(async()=>JSON.stringify(await (${expression})))()`,
        target: { context },
        awaitPromise: true,
        resultOwnership: 'none',
      })
      if (result.type !== 'success')
        throw Error(result.exceptionDetails?.text ?? 'Firefox fixture error')
      return result.result.value ? JSON.parse(result.result.value) : undefined
    }
    const paired = await runPairedBrowser({
      browser: 'firefox',
      browserVersion: report.browserVersion,
      origin: baseUrl,
      requests,
      evaluate,
      clickDownload: async (name) => {
        let target
        const end = Date.now() + 5000
        while (!target && Date.now() < end) {
          const tree = await command('browsingContext.getTree', {})
          target = tree.contexts.find((t) =>
            t.url.startsWith(`${baseUrl}/start/${name}`)
          )?.context
          if (!target) await delay(30)
        }
        assert.ok(target, name)
        await command('script.evaluate', {
          expression: "document.querySelector('a').focus()",
          target: { context: target },
          awaitPromise: false,
          resultOwnership: 'none',
        })
        await command('input.performActions', {
          context: target,
          actions: [
            {
              type: 'key',
              id: 'keyboard',
              actions: [
                { type: 'keyDown', value: '\uE007' },
                { type: 'keyUp', value: '\uE007' },
              ],
            },
          ],
        })
      },
      enterCode: async (code) => {
        await evaluate(
          `(async()=>{const end=Date.now()+5000;while(!document.querySelector('#pair-code')&&Date.now()<end)await new Promise(r=>setTimeout(r,20));const input=document.querySelector('#pair-code');input.value=${JSON.stringify(code)};input.form.requestSubmit();return true})()`
        )
      },
    })
    Object.assign(report, paired, { suite: 'paired-download-handoff' })
  } else {
    const receiverResponse = await command('script.evaluate', {
      expression: `checkFetchReceiver(${JSON.stringify(baseUrl)}).then(JSON.stringify)`,
      target: { context },
      awaitPromise: true,
      resultOwnership: 'none',
    })
    assert.equal(
      receiverResponse.type,
      'success',
      JSON.stringify(receiverResponse)
    )
    const receiver = JSON.parse(receiverResponse.result.value)
    console.log(JSON.stringify({ fetchReceiver: receiver }))
    assert.match(
      receiver.unboundError,
      /Window|Illegal invocation|incompatible/
    )
    assert.equal(receiver.boundStatus, 404)
    report.fetchReceiver = 'passed'
  }
  for (const name of pairedMode ? [] : FIREFOX_CASES) {
    activeCase = { name, status: 'running' }
    report.cases.push(activeCase)
    await saveReport()
    const running = command('script.evaluate', {
      expression: `runCase(${JSON.stringify({ baseUrl, name })}).then(JSON.stringify)`,
      target: { context },
      awaitPromise: true,
      resultOwnership: 'none',
    })
    // A failed UI assertion can close the session before we await this command.
    void running.catch(() => {})
    if (name.startsWith('click-')) {
      let tab
      const until = Date.now() + 4000
      while (!tab && Date.now() < until) {
        const tree = await command('browsingContext.getTree', {})
        tab = tree.contexts.find((t) =>
          t.url.startsWith(`${baseUrl}/start/${name}`)
        )?.context
        if (!tab) await delay(30)
      }
      assert.ok(tab, name)
      const ready = await command('script.evaluate', {
        target: { context: tab },
        awaitPromise: true,
        expression: `(async()=>{document.querySelector('a').focus();const until=Date.now()+3000;while(!document.documentElement.dataset.fixtureReady && Date.now()<until)await new Promise(r=>setTimeout(r,20));return !!document.documentElement.dataset.fixtureReady})()`,
      })
      assert.equal(ready.result?.value, true, name)
      const keys = (type, value) => ({ type, value })
      const alt = '\uE00A'
      await command('input.performActions', {
        context: tab,
        actions: [
          {
            type: 'key',
            id: 'keyboard',
            actions: [
              ...(name === 'click-bypass' ? [keys('keyDown', alt)] : []),
              keys('keyDown', '\uE007'),
              keys('keyUp', '\uE007'),
              ...(name === 'click-bypass' ? [keys('keyUp', alt)] : []),
            ],
          },
        ],
      })
    }
    const response = await running
    assert.equal(response.type, 'success', JSON.stringify(response))
    const result = JSON.parse(response.result.value)
    result.requests = requests.get(name) ?? []
    result.mdxp = simulator.snapshot(name)
    activeCase.result = result
    console.log(JSON.stringify(result))
    if (name.startsWith('click-')) {
      verifyClickResult(name, result)
      activeCase.status = 'passed'
      await saveReport()
      continue
    }
    const expectedTasks = [
      'known',
      'probe-only',
      'unknown-motrix',
      'early-default',
      'early-direct',
      'early-no-type',
      'early-confirm-accept',
      'early-unknown',
      'early-kill',
      'early-invalid-result',
      'early-delayed',
    ].includes(name)
      ? 1
      : 0
    assert.equal(
      result.mdxp.taskCount,
      expectedTasks,
      `${name}: peer task count`
    )
    assert.equal(
      result.mdxp.submissions.length,
      expectedTasks ||
        [
          'early-failed',
          'early-confirm-rejected',
          'early-disconnect-before',
        ].includes(name)
        ? 1
        : 0,
      `${name}: peer submission count`
    )
    if (unicodeFilenames.has(name)) {
      assert.equal(
        result.mdxp.submissions[0]?.suggestedFilename,
        unicodeFilenames.get(name),
        `${name}: decoded filename reached MDXP peer`
      )
      if (name === 'early-confirm-accept') {
        assert.equal(
          result.observations.find((o) => o.event === 'confirmation-filename')
            ?.filename,
          unicodeFilenames.get(name),
          `${name}: confirmation draft filename`
        )
      }
    }
    if (name.startsWith('early-')) {
      if (name.startsWith('early-protected'))
        assert.equal(result.confirmations, 0, name)
      if (name === 'early-confirm-accept')
        assert.ok(
          result.observations.some((o) => o.event === 'quiet-hold' && o.stable),
          name
        )
      const accepted = [
        'early-default',
        'early-direct',
        'early-no-type',
        'early-confirm-accept',
        'early-unknown',
        'early-disconnect-before',
        'early-invalid-result',
        'early-delayed',
        'early-kill',
      ].includes(name)
      assert.equal(result.submits, accepted ? 1 : 0, `${name}: submits`)
      const replay = name === 'early-failed'
      const native =
        replay ||
        name.startsWith('early-confirm-') ||
        [
          'early-protected',
          'early-protected-direct',
          'early-small',
          'early-excluded',
          'early-off',
        ].includes(name)
      assert.equal(
        result.nativeCount,
        name === 'early-kill' ? 1 : native ? 1 : 0,
        `${name}: native downloads`
      )
      if (name !== 'early-kill') {
        assert.equal(
          result.requests.filter((r) => r.method === 'GET' && !r.range).length,
          replay ? 2 : 1,
          `${name}: GET requests`
        )
      }
      if (name.startsWith('early-confirm-')) {
        assert.equal(result.confirmations, 1)
        if (name !== 'early-confirm-unavailable')
          assert.ok(
            result.observations.some(
              (o) => o.event === 'form-click' && o.clicked
            ),
            name
          )
        if (name !== 'early-confirm-unavailable')
          assert.ok(
            result.observations.some(
              (o) =>
                o.event === 'confirmation-hold' &&
                o.nativeCount === 1 &&
                o.paused === true
            ),
            `${name}: browser streamed while confirming`
          )
      }
      if (
        name.startsWith('early-confirm-') ||
        name.startsWith('early-protected')
      ) {
        assert.ok(
          !result.observations.some((o) => o.outcome === 'cleanup'),
          JSON.stringify(result.observations)
        )
        if (name === 'early-confirm-browser')
          assert.ok(
            result.observations.some(
              (o) =>
                o.event === 'confirmation-settled' && o.action === 'browser'
            )
          )
        const stopped = [
          'early-confirm-accept',
          'early-confirm-cancel',
        ].includes(name)
        assert.equal(
          result.native[0]?.state,
          stopped ? 'interrupted' : 'complete',
          name
        )
        if (!stopped)
          assert.equal(
            createHash('sha256')
              .update(await readFile(result.native[0].filename))
              .digest('hex'),
            createHash('sha256')
              .update(Buffer.alloc(1024 * 1024))
              .digest('hex')
          )
      }
      activeCase.status = 'passed'
      await saveReport()
      continue
    }
    assert.ok(
      result.observations.some((x) => x.event === 'created'),
      `${name}: no native download`
    )
    assert.equal(
      result.submits,
      ['known', 'probe-only', 'unknown-motrix'].includes(name) ? 1 : 0,
      `${name}: submits`
    )
    assert.equal(result.confirmations, 0, `${name}: confirmations`)
    if (name === 'confirm') {
      assert.deepEqual(
        result.requests.map((x) => x.method),
        ['GET'],
        'confirmation must not probe a one-use URL'
      )
      assert.equal(result.native[0].state, 'complete')
    }
    if (name === 'small')
      assert.ok(
        ['in_progress', 'complete'].includes(result.native[0].state),
        'small download must remain native, even if it finishes before inspection'
      )
    if (name === 'unknown-chrome')
      assert.equal(result.native[0].state, 'in_progress')
    if (['known', 'probe-only', 'unknown-motrix'].includes(name))
      assert.deepEqual(result.native, [], 'cancelled history must be erased')
    if (name === 'known') {
      assert.ok(result.requests.some((request) => request.method === 'HEAD'))
      assert.ok(
        result.requests.some((request) => request.range === 'bytes=0-0')
      )
    }
    if (name === 'probe-only') {
      assert.ok(
        result.observations.some(
          (item) => item.event === 'probe' && item.outcome === 'head-length'
        )
      )
    }
    activeCase.status = 'passed'
    await saveReport()
  }
  if (!pairedMode) {
    report.status = 'passed'
    verifyTakeoverReport(report, {
      revision: process.env.GITHUB_SHA,
      browser: process.env.EXPECTED_FIREFOX_VERSION,
    })
    console.log('Firefox native takeover regression: PASS')
  }
} catch (error) {
  report.status = 'failed'
  report.error = error.stack ?? String(error)
  if (activeCase?.status === 'running') activeCase.status = 'failed'
  throw error
} finally {
  report.finishedAt = new Date().toISOString()
  await saveReport()
  await writeFile(join(reportDirectory, 'firefox.log'), diagnostics)
  for (const timer of transfers) clearInterval(timer)
  if (app && socket?.readyState === 1) {
    await command('browser.close', {}).catch(() => {})
  }
  socket?.close()
  for (const request of pending.values())
    request.reject(new Error('fixture closed'))
  if (firefox && firefox.exitCode === null) {
    if (app) {
      // LaunchServices owns Firefox, not the `open -W` child. Only stop a
      // browser whose argv names this run's unique, disposable profile.
      const processes = execFileSync('/bin/ps', ['-axo', 'pid=,args='], {
        encoding: 'utf8',
      })
      for (const line of processes.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(.*)$/)
        if (
          match?.[2].startsWith(`${app}/Contents/MacOS/firefox `) &&
          match[2].includes(`--profile ${profile} `)
        ) {
          try {
            process.kill(Number(match[1]), 'SIGTERM')
          } catch {}
        }
      }
    }
    firefox.kill('SIGTERM')
    await Promise.race([once(firefox, 'exit'), delay(3000)])
    if (firefox.exitCode === null && firefox.signalCode === null) {
      firefox.kill('SIGKILL')
      await once(firefox, 'exit')
    }
  }
  server.closeAllConnections()
  await simulator.close()
  await new Promise((r) => server.close(r))
  await rm(temporary, { recursive: true, force: true })
}
