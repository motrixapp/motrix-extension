import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { zipSync } from 'fflate'
import { build } from 'vite'

const binary =
  process.env.FIREFOX_BINARY ??
  '/Applications/Firefox.app/Contents/MacOS/firefox'
const root = resolve(import.meta.dirname, '..')
await mkdir(join(root, '.cache'), { recursive: true })
const temporary = await mkdtemp(join(root, '.cache/firefox-takeover-'))
const extension = join(temporary, 'extension')
const profile = join(temporary, 'profile')
const uuid = 'bd2a973c-7f7b-468e-bd3d-03f8bc59336f'
const requests = new Map()
const transfers = new Set()
let firefox
let socket
let sequence = 0
const pending = new Map()
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost')
  const name = url.pathname.split('/').at(-1)
  if (url.pathname.startsWith('/start/')) {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(`<script>location.href='/download/${name}'</script>`)
    return
  }
  if (!url.pathname.startsWith('/download/')) {
    response.writeHead(404).end()
    return
  }
  const list = requests.get(name) ?? []
  list.push({ method: request.method, range: request.headers.range ?? null })
  requests.set(name, list)
  const size = name === 'small' ? 2 * 1024 * 1024 : 8 * 1024 * 1024
  // The browser's original response works, while HEAD fails and ranged GET
  // is forbidden. Size discovery must come from Firefox's live metadata.
  if (request.method === 'HEAD') {
    if (name === 'probe-only') {
      response
        .writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': size,
        })
        .end()
      return
    }
    request.socket.destroy()
    return
  }
  if (request.headers.range) {
    response.writeHead(403).end()
    return
  }
  response.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${name}.zip"`,
    ...(!name.startsWith('unknown-') && name !== 'probe-only'
      ? { 'Content-Length': size }
      : {}),
  })
  response.flushHeaders()
  let sent = 0
  const timer = setInterval(() => {
    const count = Math.min(64 * 1024, size - sent)
    response.write(Buffer.alloc(count))
    sent += count
    if (sent >= size) response.end()
  }, 100)
  transfers.add(timer)
  response.on('close', () => {
    clearInterval(timer)
    transfers.delete(timer)
  })
})
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
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
  await build({
    configFile: false,
    root,
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
  await writeFile(
    join(extension, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Motrix Firefox takeover regression fixture',
      version: '1.0',
      permissions: ['downloads', 'cookies', 'storage', 'tabs'],
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
    '<script src="fixture.js"></script>'
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
  firefox = spawn(
    binary,
    [
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
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  firefox.on('error', (error) => process.stderr.write(`${error.message}\n`))
  let diagnostics = ''
  firefox.stderr.on('data', (data) => {
    diagnostics = (diagnostics + data).slice(-3000)
  })
  firefox.stdout.on('data', (data) => {
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
  try {
    const archive = zipSync(
      Object.fromEntries(
        await Promise.all(
          ['manifest.json', 'runner.html', 'fixture.js', 'bootstrap.js'].map(
            async (name) => [
              name,
              new Uint8Array(await readFile(join(extension, name))),
            ]
          )
        )
      )
    )
    await command('webExtension.install', {
      extensionData: {
        type: 'base64',
        value: Buffer.from(archive).toString('base64'),
      },
    })
  } catch (error) {
    console.error(diagnostics)
    throw error
  }
  let context
  const pageDeadline = Date.now() + 10000
  while (!context && Date.now() < pageDeadline) {
    const tree = await command('browsingContext.getTree', {})
    context = tree.contexts.find((page) =>
      page.url?.endsWith('/runner.html')
    )?.context
    if (!context) await delay(100)
  }
  assert.ok(context, `Firefox did not open the fixture: ${diagnostics}`)
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
  assert.match(receiver.unboundError, /Window|Illegal invocation|incompatible/)
  assert.equal(receiver.boundStatus, 404)
  for (const name of [
    'known',
    'probe-only',
    'confirm',
    'small',
    'unknown-chrome',
    'unknown-motrix',
  ]) {
    const response = await command('script.evaluate', {
      expression: `runCase(${JSON.stringify({ baseUrl, name })}).then(JSON.stringify)`,
      target: { context },
      awaitPromise: true,
      resultOwnership: 'none',
    })
    assert.equal(response.type, 'success', JSON.stringify(response))
    const result = JSON.parse(response.result.value)
    result.requests = requests.get(name) ?? []
    console.log(JSON.stringify(result))
    assert.ok(
      result.observations.some((x) => x.event === 'created'),
      `${name}: no native download`
    )
    assert.equal(
      result.submits,
      ['known', 'probe-only', 'unknown-motrix'].includes(name) ? 1 : 0,
      `${name}: submits`
    )
    assert.equal(
      result.confirmations,
      name === 'confirm' ? 1 : 0,
      `${name}: confirmations`
    )
    if (name === 'confirm') {
      assert.deepEqual(
        result.requests.map((x) => x.method),
        ['GET'],
        'confirmation must not probe a one-use URL'
      )
      assert.equal(result.native[0].state, 'in_progress')
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
  }
  console.log('Firefox native takeover regression: PASS')
} finally {
  for (const timer of transfers) clearInterval(timer)
  socket?.close()
  for (const request of pending.values())
    request.reject(new Error('fixture closed'))
  if (firefox && firefox.exitCode === null) {
    firefox.kill('SIGTERM')
    await Promise.race([once(firefox, 'exit'), delay(3000)])
  }
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
  await rm(temporary, { recursive: true, force: true })
}
