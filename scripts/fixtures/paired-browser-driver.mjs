import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'vite'

export const pairedMode = process.argv.includes('--paired-handoff')
export async function buildPairedFixture(root, outDir, browser) {
  if (!process.env.MOTRIX_HOST_DIR)
    throw new Error('Set MOTRIX_HOST_DIR to the Motrix checkout')
  await build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'error',
    define: {
      __BROWSER__: JSON.stringify(browser),
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    resolve: {
      alias: { '@': path.join(root, 'src') },
    },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, 'scripts/fixtures/paired-native-handoff.mjs'),
        name: 'pairedFixture',
        formats: ['iife'],
        fileName: () => 'fixture.js',
      },
    },
  })
}
export async function runPairedBrowser({
  browser,
  browserVersion,
  origin,
  requests,
  evaluate,
  enterCode,
  clickDownload,
}) {
  const repo = path.resolve(process.env.MOTRIX_HOST_DIR)
  const child = fork(path.join(repo, 'scripts/paired-handoff-host.mjs'), [], {
    cwd: repo,
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      MOTRIX_FIXTURE_ORIGIN: origin,
    },
  })
  const exited = once(child, 'exit')
  const queue = [],
    waiters = new Set()
  child.on('message', (m) => {
    queue.push(m)
    for (const notify of waiters) notify()
  })
  async function receive(event) {
    const end = Date.now() + 15000
    while (Date.now() < end && child.exitCode === null) {
      const i = queue.findIndex(
        (m) => m.event === event || m.event === 'failure'
      )
      if (i >= 0) {
        const [m] = queue.splice(i, 1)
        if (m.event === 'failure') throw Error(m.message)
        return m
      }
      await new Promise((r) => {
        const done = () => {
          clearTimeout(t)
          waiters.delete(done)
          r()
        }
        const t = setTimeout(done, 100)
        waiters.add(done)
      })
    }
    throw Error(`Missing local host event: ${event}`)
  }
  const revision = (cwd) =>
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
  const report = {
    browser,
    browserVersion,
    backend: 'MBP1 WebSocket + SQLite + aria2',
    extensionRevision: revision(process.cwd()),
    hostRevision: revision(repo),
    sdkVersion: JSON.parse(
      await readFile(
        new URL('../package.json', import.meta.resolve('@motrix/mdxp')),
        'utf8'
      )
    ).version,
    status: 'running',
    cases: [],
  }
  try {
    const { port, instanceId } = await receive('ready')
    await evaluate(`beginPairedHandoff(${port},${JSON.stringify(origin)})`)
    let prompt
    try {
      prompt = await receive('pairing-prompt')
    } catch {
      throw Error(
        `No operator prompt: ${JSON.stringify(await evaluate('pairedState()'))}`
      )
    }
    console.log(browser, 'operator prompt received')
    try {
      await enterCode(prompt.code)
    } catch {
      throw Error('Pairing code entry failed')
    } finally {
      delete prompt.code
    }
    console.log(browser, 'pairing code entered')
    const negotiated = await evaluate('finishPairing()')
    assert.equal(negotiated.instanceId, instanceId)
    console.log(browser, 'paired and capability negotiated')
    assert.equal(negotiated.capability.version, 1)
    assert.equal(negotiated.capability.acceptingNew, true)
    assert.equal(negotiated.runtime, 'electron')
    report.negotiated = negotiated.capability
    report.runtime = negotiated.runtime
    report.instanceId = instanceId
    let originalSessions
    for (const name of [
      'paired-accept',
      'paired-browser',
      'paired-cancel',
      'paired-rejected',
      'paired-lost',
    ]) {
      console.log(browser, 'starting', name)
      const pending = evaluate(`runPairedCase(${JSON.stringify(name)})`)
      if (clickDownload) await clickDownload(name)
      const r = await pending
      child.send({ action: 'snapshot', name })
      const ledger = await receive('snapshot')
      assert.ok(ledger.authenticated > 0)
      originalSessions ??= ledger.authenticated
      if (name === 'paired-lost')
        assert.ok(
          ledger.authenticated > originalSessions,
          'lost reply must reconnect with the retained credential'
        )
      assert.equal(
        ledger.pairPrompts,
        1,
        'only the initial session needs a code'
      )
      assert.ok(
        r.events.some((e) => e.event === 'hold' && e.id === r.id),
        name
      )
      const accepted = ['paired-accept', 'paired-lost'].includes(name)
      const methods = ledger.history.map((e) => e.method)
      assert.deepEqual(
        methods,
        accepted
          ? name === 'paired-lost'
            ? ['Prepare', 'Commit', 'Status']
            : ['Prepare', 'Commit']
          : name === 'paired-rejected'
            ? ['Prepare', 'Abort']
            : [],
        name
      )
      if (methods.length)
        assert.equal(new Set(ledger.history.map((e) => e.id)).size, 1)
      const prepare = r.events.find((e) => e.method === 'Prepare')
      assert.equal(
        r.events.filter((e) => e.event === 'created').length,
        1,
        name
      )
      if (prepare) {
        assert.equal(prepare.paused, true)
        assert.equal(prepare.id, r.id)
      }
      if (accepted) {
        const commit = r.events.find((e) => e.method === 'Commit')
        assert.equal(commit?.state, 'interrupted', name)
        assert.equal(commit?.error, 'USER_CANCELED', name)
        assert.equal(commit.id, r.id, name)
        assert.ok(!commit.paused || !commit.canResume, name)
      }
      const completed = name === 'paired-browser' || name === 'paired-rejected'
      assert.equal(r.state, completed ? 'complete' : 'interrupted', name)
      assert.equal(ledger.tasks.length, Number(accepted), name)
      assert.deepEqual(ledger.outbox, [])
      assert.deepEqual(
        ledger.states,
        accepted
          ? ['committed']
          : name === 'paired-rejected'
            ? ['aborted']
            : [],
        name
      )
      const sha = createHash('sha256')
        .update(Buffer.alloc(1024 * 1024))
        .digest('hex')
      if (accepted) assert.equal(ledger.sha256, sha)
      if (completed)
        assert.equal(
          createHash('sha256')
            .update(await readFile(r.filename))
            .digest('hex'),
          sha
        )
      const source = requests.get(name) ?? []
      assert.equal(
        source.filter((row) => row.method === 'GET' && !row.range).length,
        accepted ? 2 : 1,
        name
      )
      assert.ok(
        source.every((row) => row.method === 'GET'),
        name
      )
      assert.equal(
        source.filter((row) => row.fromEngine).length,
        Number(accepted),
        name
      )
      report.cases.push({
        name,
        pairedSessions: ledger.authenticated,
        pairPrompts: ledger.pairPrompts,
        id: r.id,
        state: r.state,
        stage: r.stage,
        events: r.events,
        methods,
        taskCount: ledger.tasks.length,
        ledgerStates: ledger.states,
        requests: source,
        sha256: completed || accepted ? sha : null,
      })
      console.log(browser, name, 'PASS')
    }
    report.status = 'passed'
    return report
  } catch (error) {
    report.status = 'failed'
    throw error
  } finally {
    if (child.connected) child.send('close')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    await exited
    clearTimeout(timer)
    const folder = path.resolve(
      process.env.PAIRED_REPORT_DIR ?? '.cache/paired-handoff'
    )
    await mkdir(folder, { recursive: true })
    await writeFile(
      path.join(folder, `${browser}.json`),
      `${JSON.stringify(report, null, 2)}\n`
    )
  }
}
