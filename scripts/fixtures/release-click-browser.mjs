import assert from 'node:assert/strict'
import { join } from 'node:path'
import { build } from 'vite'

export const clickCases = [
  'click-accept',
  'click-unknown',
  'click-browser',
  'click-cancel',
  'click-bypass',
  'click-rejected',
  'click-unavailable',
]
export const clickScript = {
  matches: ['http://127.0.0.1/*'],
  js: ['release-click.js'],
  run_at: 'document_start',
}
export function buildClickScript(root, outDir) {
  return build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'error',
    resolve: { alias: { '@': join(root, 'src') } },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: join(root, 'scripts/fixtures/release-click-content.ts'),
        formats: ['iife'],
        name: 'clickFixture',
        fileName: () => 'release-click.js',
      },
    },
  })
}
export function verifyClickResult(name, result) {
  const native = [
    'click-browser',
    'click-bypass',
    'click-rejected',
    'click-unavailable',
  ].includes(name)
  assert.equal(result.confirmations, name === 'click-bypass' ? 0 : 1, name)
  assert.equal(result.nativeCount, Number(native), name)
  assert.deepEqual(
    result.requests,
    native ? [{ method: 'GET', range: null }] : [],
    name
  )
  assert.equal(
    result.mdxp.taskCount,
    Number(['click-accept', 'click-unknown'].includes(name)),
    name
  )
  assert.equal(
    result.mdxp.submissions.length,
    Number(['click-accept', 'click-unknown', 'click-rejected'].includes(name)),
    name
  )
  if (!['click-bypass', 'click-unavailable'].includes(name)) {
    assert.ok(
      result.observations.some(
        (o) =>
          o.event === 'before-decision' &&
          o.requests === 0 &&
          o.nativeCount === 0
      ),
      name
    )
    assert.ok(
      result.observations.some((o) => o.event === 'form-click' && o.clicked),
      name
    )
  }
  if (name === 'click-unknown')
    assert.ok(
      result.observations.some(
        (o) => o.event === 'click-report' && o.outcome === 'unknown'
      ),
      name
    )
  if (native) assert.equal(result.native[0]?.state, 'complete', name)
}
