import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { waitForFirefoxFixture } from '../fixtures/firefox-readiness.mjs'

const runnerUrl = 'moz-extension://fixture-id/runner.html'
function clock() {
  let time = 0
  return {
    timeoutMs: 500,
    now: () => time,
    sleep: async (ms) => {
      time += ms
    },
  }
}

test('waits for both fixture functions after the runner URL becomes visible', async () => {
  const timing = clock()
  const realm = {}
  let evaluations = 0
  const context = await waitForFirefoxFixture(
    async (method, params) => {
      if (method === 'browsingContext.getTree')
        return {
          contexts: [{ context: 'fixture-context', url: runnerUrl }],
        }
      assert.equal(method, 'script.evaluate')
      assert.deepEqual(params.target, { context: 'fixture-context' })
      evaluations += 1
      if (evaluations === 2) realm.checkFetchReceiver = () => {}
      if (evaluations === 3) realm.runCase = () => {}
      return {
        type: 'success',
        result: {
          type: 'boolean',
          value: runInNewContext(params.expression, realm),
        },
      }
    },
    runnerUrl,
    timing
  )
  assert.equal(context, 'fixture-context')
  assert.equal(evaluations, 3)
  assert.equal(timing.now(), 200)
})

test('ignores unrelated runner pages and waits for the intended extension', async () => {
  const timing = clock()
  let inspected = 0
  const context = await waitForFirefoxFixture(
    async (method, params) => {
      if (method === 'browsingContext.getTree')
        return {
          contexts: [
            {
              context: 'other-extension',
              url: 'moz-extension://other/runner.html',
            },
            ...(timing.now() > 0
              ? [{ context: 'fixture-context', url: runnerUrl }]
              : []),
          ],
        }
      inspected += 1
      assert.deepEqual(params.target, { context: 'fixture-context' })
      return { type: 'success', result: { type: 'boolean', value: true } }
    },
    runnerUrl,
    timing
  )
  assert.equal(context, 'fixture-context')
  assert.equal(inspected, 1)
  assert.equal(timing.now(), 100)
})

test('fails within the startup budget when the fixture never initializes', async () => {
  const timing = clock()
  await assert.rejects(
    waitForFirefoxFixture(
      async (method) =>
        method === 'browsingContext.getTree'
          ? { contexts: [{ context: 'fixture-context', url: runnerUrl }] }
          : { type: 'success', result: { type: 'boolean', value: false } },
      runnerUrl,
      timing
    ),
    /fixture functions are not ready/
  )
  assert.equal(timing.now(), timing.timeoutMs)
})

test('reports a missing runner page without evaluating an unrelated context', async () => {
  const timing = clock()
  await assert.rejects(
    waitForFirefoxFixture(
      async (method) => {
        assert.equal(method, 'browsingContext.getTree')
        return { contexts: [] }
      },
      runnerUrl,
      timing
    ),
    /runner page not found/
  )
})

test('does not hide evaluation or protocol failures behind a readiness retry', async () => {
  for (const response of [
    { type: 'exception', exceptionDetails: { text: 'fixture error' } },
    new Error('protocol disconnected'),
  ]) {
    const timing = clock()
    await assert.rejects(
      waitForFirefoxFixture(
        async (method) => {
          if (method === 'browsingContext.getTree')
            return {
              contexts: [{ context: 'fixture-context', url: runnerUrl }],
            }
          if (response instanceof Error) throw response
          return response
        },
        runnerUrl,
        timing
      ),
      /fixture error|protocol disconnected/
    )
    assert.equal(timing.now(), 0)
  }
})
