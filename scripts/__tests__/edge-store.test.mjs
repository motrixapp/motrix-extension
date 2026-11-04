import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { submitEdge } from '../edge-store.mjs'

const origin = 'https://api.addons.microsoftedge.microsoft.com'
const productId = '12345678-1234-1234-1234-123456789abc'
const uploadId = '11111111-1111-1111-1111-111111111111'
const submissionId = '22222222-2222-2222-2222-222222222222'
const path = `/v1/products/${productId}/submissions`
const accepted = (id) =>
  new Response(null, { status: 202, headers: { Location: id } })
const status = (id, state, details = {}) =>
  Response.json({ id, status: state, ...details })
const uploaded = () => [accepted(uploadId), status(uploadId, 'Succeeded')]

function fixture(t, responses) {
  const directory = mkdtempSync(join(tmpdir(), 'motrix-edge-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const zip = join(directory, 'extension.zip')
  writeFileSync(zip, 'verified ZIP bytes')
  const options = { productId, clientId: 'client-id', apiKey: 'api-key', zip }
  const calls = []
  const logs = []
  const waits = []
  let time = 0
  const dependencies = {
    now: () => time,
    wait: async (ms) => {
      waits.push(ms)
      time += ms
    },
    log: (line) => logs.push(line),
    fetch: async (url, init) => {
      calls.push({ url, ...init })
      assert.equal(init.redirect, 'error')
      assert.ok(init.signal instanceof AbortSignal)
      const response = responses.shift()
      assert.ok(response, 'Unexpected API request')
      if (response instanceof Error) throw response
      return response
    },
  }
  return { options, dependencies, calls, logs, waits }
}

test('automatically uploads and submits, waiting for both operations to succeed', async (t) => {
  const { options, dependencies, calls, logs, waits } = fixture(t, [
    accepted(uploadId),
    Response.json({ id: uploadId, status: 'InProgress' }, { status: 202 }),
    status(uploadId, 'Succeeded'),
    accepted(`${origin}${path}/operations/${submissionId}`),
    Response.json({ id: submissionId, status: 'InProgress' }, { status: 202 }),
    status(submissionId, 'InProgress'),
    status(submissionId, 'Succeeded'),
  ])
  const result = await submitEdge(options, dependencies)
  assert.equal(result.status, 'Succeeded')
  assert.deepEqual(
    calls.map(({ url, method }) => [method, url.replace(origin, '')]),
    [
      ['POST', `${path}/draft/package`],
      ['GET', `${path}/draft/package/operations/${uploadId}`],
      ['GET', `${path}/draft/package/operations/${uploadId}`],
      ['POST', path],
      ['GET', `${path}/operations/${submissionId}`],
      ['GET', `${path}/operations/${submissionId}`],
      ['GET', `${path}/operations/${submissionId}`],
    ]
  )
  for (const { headers } of calls) {
    assert.equal(headers.Authorization, 'ApiKey api-key')
    assert.equal(headers['X-ClientID'], 'client-id')
  }
  assert.equal(calls[0].headers['Content-Type'], 'application/zip')
  assert.equal(calls[0].body.toString(), 'verified ZIP bytes')
  assert.equal(calls[3].headers['Content-Type'], 'application/json')
  assert.deepEqual(waits, [5000, 5000, 5000])
  assert.equal(
    logs.at(-1),
    `Edge submission operation ${submissionId}: Succeeded`
  )
})

for (const phase of ['upload', 'submission']) {
  const id = phase === 'upload' ? uploadId : submissionId
  const prefix = () => (phase === 'upload' ? [] : uploaded())

  test(`${phase} failure includes the operation ID and all Microsoft error details`, async (t) => {
    const { options, dependencies, calls } = fixture(t, [
      ...prefix(),
      accepted(id),
      status(id, 'Failed', {
        message: 'Fix the invalid store listing',
        errorCode: 'SubmissionValidationError',
        errors: [{ message: 'Privacy URL is required' }],
      }),
    ])
    await assert.rejects(submitEdge(options, dependencies), (error) => {
      for (const detail of [
        `Edge ${phase} operation ${id}`,
        'Fix the invalid store listing',
        'SubmissionValidationError',
        'Privacy URL is required',
      ])
        assert.ok(error.message.includes(detail))
      return true
    })
    assert.equal(calls.length, phase === 'upload' ? 2 : 4)
  })

  test(`${phase} timeout fails with its operation ID instead of reporting success`, async (t) => {
    const { options, dependencies, calls } = fixture(t, [
      ...prefix(),
      accepted(id),
      status(id, 'InProgress'),
    ])
    const advance = dependencies.wait
    dependencies.wait = () => advance(8 * 60_000)
    await assert.rejects(submitEdge(options, dependencies), (error) => {
      assert.ok(error.message.includes(`Edge ${phase} operation ${id}`))
      assert.match(error.message, /Timed out.*last status: InProgress/)
      return true
    })
    assert.equal(calls.length, phase === 'upload' ? 2 : 4)
  })

  test(`${phase} rejects HTTP 202 without an operation ID`, async (t) => {
    const { options, dependencies } = fixture(t, [
      ...prefix(),
      new Response(null, { status: 202 }),
    ])
    await assert.rejects(submitEdge(options, dependencies), /Location header/)
  })
}

for (const [name, response, reason] of [
  ['unknown status', status(submissionId, 'Unexpected'), /Unexpected/],
  [
    'missing status',
    Response.json({ id: submissionId, message: 'Contact support' }),
    /Contact support/,
  ],
  [
    'invalid JSON',
    new Response('upstream unavailable'),
    /upstream unavailable/,
  ],
  ['wrong operation', status(uploadId, 'Succeeded'), /Operation ID mismatch/],
  [
    'HTTP failure',
    new Response('Service unavailable', { status: 503 }),
    /HTTP 503.*Service unavailable/,
  ],
  ['network failure', new Error('Connection reset'), /Connection reset/],
  [
    'request timeout',
    new DOMException('Request timed out', 'TimeoutError'),
    /Request timed out/,
  ],
]) {
  test(`submission polling fails on ${name}`, async (t) => {
    const { options, dependencies, calls } = fixture(t, [
      ...uploaded(),
      accepted(submissionId),
      response,
    ])
    await assert.rejects(submitEdge(options, dependencies), reason)
    assert.equal(calls.filter(({ method }) => method === 'POST').length, 2)
  })
}

test('does not follow an untrusted operation Location with API credentials', async (t) => {
  const { options, dependencies, calls } = fixture(t, [
    ...uploaded(),
    accepted(`https://example.org${path}/operations/${submissionId}`),
  ])
  await assert.rejects(submitEdge(options, dependencies), /Location header/)
  assert.equal(calls.length, 3)
})

test('does not retry a rejected submission and redacts credentials in its response', async (t) => {
  const { options, dependencies, calls } = fixture(t, [
    ...uploaded(),
    new Response('Invalid api-key for client-id', { status: 401 }),
  ])
  await assert.rejects(submitEdge(options, dependencies), (error) => {
    assert.match(
      error.message,
      /HTTP 401.*Invalid \[REDACTED\] for \[REDACTED\]/
    )
    assert.equal(error.message.includes(options.apiKey), false)
    return true
  })
  assert.equal(calls.length, 3)
})

test('dry runs never upload or submit', async (t) => {
  const { options, dependencies, calls } = fixture(t, [])
  await submitEdge(options, { ...dependencies, dryRun: true })
  assert.equal(calls.length, 0)
})
