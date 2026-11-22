// Run against installed Chrome for Testing with an isolated profile.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { build } from 'vite'
import { createMdxpSimulator } from './fixtures/mdxp-simulator.mjs'
import {
  buildPairedFixture,
  pairedMode,
  runPairedBrowser,
} from './fixtures/paired-browser-driver.mjs'
import {
  createTakeoverOrigin,
  preservedDownloadRequestCounts,
} from './fixtures/takeover-origin.mjs'

const root = resolve(import.meta.dirname, '..')
const temp = await mkdtemp(
  join(
    resolve(process.env.TAKEOVER_TEMP_ROOT ?? tmpdir()),
    'motrix-chromium-confirm-'
  )
)
const ext = join(temp, 'extension'),
  profile = join(temp, 'profile'),
  downloads = join(temp, 'downloads')
const { server, requests, transfers } = createTakeoverOrigin()
const simulator = createMdxpSimulator(server)
let ctx
try {
  await Promise.all([
    mkdir(ext),
    mkdir(join(profile, 'Default'), { recursive: true }),
    mkdir(downloads),
  ])
  if (pairedMode) await buildPairedFixture(root, ext, 'chromium')
  else
    await build({
      configFile: false,
      root,
      publicDir: false,
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      logLevel: 'error',
      resolve: { alias: { '@': join(root, 'src') } },
      build: {
        outDir: ext,
        emptyOutDir: false,
        lib: {
          entry: join(root, 'scripts/fixtures/firefox-takeover.ts'),
          name: 'fixture',
          formats: ['iife'],
          fileName: () => 'fixture.js',
        },
      },
    })
  await writeFile(
    join(ext, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Motrix confirmation integration',
      version: '1',
      permissions: ['downloads', 'cookies', 'storage', 'tabs', 'webRequest'],
      host_permissions: ['http://127.0.0.1/*'],
      background: { service_worker: 'bootstrap.js' },
    })
  )
  await writeFile(
    join(ext, 'bootstrap.js'),
    'chrome.runtime.onInstalled.addListener(()=>{})'
  )
  await writeFile(
    join(ext, 'runner.html'),
    '<!doctype html><meta charset="utf-8"><script src="fixture.js"></script>'
  )
  await writeFile(
    join(profile, 'Default', 'Preferences'),
    JSON.stringify({
      download: { default_directory: downloads, prompt_for_download: false },
    })
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    executablePath: process.env.CHROME_BINARY,
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--load-extension=${ext}`, `--disable-extensions-except=${ext}`],
  })
  const worker =
    ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
  const page = ctx.pages()[0]
  page.on('pageerror', (e) => console.error(e.message))
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' })
  await page.goto(new URL('runner.html', worker.url()).href)
  if (pairedMode) {
    await page.waitForFunction(
      () => typeof window.beginPairedHandoff === 'function'
    )
    await runPairedBrowser({
      browser: 'chromium',
      browserVersion: ctx.browser().version(),
      origin: baseUrl,
      requests,
      evaluate: (expression) => page.evaluate(expression),
      enterCode: async (code) => {
        await page.locator('#pair-code').fill(code)
        await page.getByRole('button', { name: 'Pair', exact: true }).click()
      },
      clickDownload: async (name) => {
        const end = Date.now() + 5000
        let tab
        while (!tab && Date.now() < end) {
          tab = ctx.pages().find((p) => p.url().includes(`/start/${name}`))
          if (!tab) await new Promise((r) => setTimeout(r, 20))
        }
        assert.ok(tab, name)
        await tab.getByRole('link', { name: 'Download' }).click()
      },
    })
  } else await page.waitForFunction(() => typeof window.runCase === 'function')
  for (const name of pairedMode
    ? []
    : [
        'known',
        'early-public-redirect',
        'early-confirm-accept',
        'early-confirm-cancel',
        'early-confirm-browser',
        'early-confirm-rejected',
        'early-confirm-unavailable',
        'early-protected',
        'early-protected-direct',
        ...Object.keys(preservedDownloadRequestCounts),
        'confirm',
      ]) {
    const opened = ctx.waitForEvent('page')
    const run = page.evaluate((input) => window.runCase(input), {
      name,
      baseUrl,
    })
    const tab = await opened
    const link = tab.getByRole('link', { name: 'Download' })
    await link.click()
    const r = await run
    assert.ok(
      !r.observations.some((o) => o.outcome === 'cleanup'),
      JSON.stringify(r.observations)
    )
    if (name === 'early-confirm-browser')
      assert.ok(
        r.observations.some(
          (o) => o.event === 'confirmation-settled' && o.action === 'browser'
        )
      )
    if (name === 'known' || name === 'early-public-redirect') {
      assert.equal(r.confirmations, 0, name)
      assert.equal(simulator.snapshot(name).taskCount, 1, name)
      assert.equal(simulator.snapshot(name).submissions.length, 1, name)
      assert.equal(
        requests.get(name)?.filter((r) => r.method === 'GET' && !r.range)
          .length,
        name === 'known' ? 1 : 2,
        `${name}: original navigation requests`
      )
      console.log(ctx.browser().version(), name, 'direct handoff')
      continue
    }
    const preservedRequests = preservedDownloadRequestCounts[name]
    const get = { method: 'GET', range: null }
    assert.deepEqual(
      requests.get(name),
      Array.from({ length: preservedRequests ?? 1 }, () => get),
      name
    )
    if (name === 'early-confirm-accept')
      assert.ok(
        r.observations.some((o) => o.event === 'quiet-hold' && o.stable),
        name
      )
    const accepted = name === 'early-confirm-accept'
    assert.equal(simulator.snapshot(name).taskCount, Number(accepted), name)
    assert.equal(
      simulator.snapshot(name).submissions.length,
      Number(accepted || name === 'early-confirm-rejected'),
      name
    )
    assert.equal(r.nativeCount, 1, name)
    const [item] = r.native
    const held = r.observations.find((o) => o.event === 'confirmation-hold')
    if (name.startsWith('early-confirm-') && !name.endsWith('unavailable')) {
      assert.ok(
        r.observations.some((o) => o.event === 'form-click' && o.clicked),
        name
      )
      assert.equal(held?.paused, true, name)
      assert.equal(held?.id, item.id, name)
    }
    if (
      preservedRequests ||
      name.startsWith('early-protected') ||
      name === 'confirm'
    )
      assert.equal(r.confirmations, 0, name)
    assert.equal(
      item.state,
      accepted || name === 'early-confirm-cancel' ? 'interrupted' : 'complete',
      name
    )
    if (item.state === 'complete')
      assert.equal(
        createHash('sha256')
          .update(await readFile(item.filename))
          .digest('hex'),
        createHash('sha256')
          .update(Buffer.alloc(1024 * 1024))
          .digest('hex'),
        name
      )
    console.log(ctx.browser().version(), name, item.state)
  }
} finally {
  await ctx?.close()
  for (const timer of transfers) clearInterval(timer)
  server.closeAllConnections()
  await simulator.close()
  server.close()
  await rm(temp, { recursive: true, force: true })
}
