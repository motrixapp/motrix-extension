import { readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

const API_ORIGIN = 'https://api.addons.microsoftedge.microsoft.com'
const GUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i
const OPERATION_TIMEOUT_MS = 8 * 60_000
const REQUEST_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 5_000

function operationId(location, path) {
  if (location && GUID.test(location)) return location
  if (location) {
    const url = new URL(location, API_ORIGIN)
    const id = url.pathname.split('/').at(-1)
    if (
      url.origin === API_ORIGIN &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      GUID.test(id) &&
      url.pathname === `${path}/operations/${id}`
    )
      return id
  }
  throw new Error('Missing or invalid operation ID in the Location header')
}

// Edge's HTTP 202 response only queues an operation. Both operations must reach
// Succeeded; submission success means review was requested, not approved.
export async function submitEdge(
  options,
  {
    dryRun = false,
    log = console.log,
    fetch = globalThis.fetch,
    wait = sleep,
    now = Date.now,
  } = {}
) {
  if (dryRun) {
    log('DRY RUN: Skipped Edge upload and submission')
    return
  }
  const redact = (value) => {
    let text = String(value)
    for (const secret of [options.apiKey, options.clientId]) {
      if (secret) text = text.replaceAll(secret, '[REDACTED]')
    }
    return text
  }
  const submissionPath = `/v1/products/${encodeURIComponent(options.productId)}/submissions`
  const headers = {
    Authorization: `ApiKey ${options.apiKey}`,
    'X-ClientID': options.clientId,
  }

  async function runOperation(phase, path, body, contentType) {
    const deadline = now() + OPERATION_TIMEOUT_MS
    let context = `Edge ${phase}`
    let lastStatus = 'not yet received'
    const remaining = () => {
      const ms = deadline - now()
      if (ms <= 0)
        throw new Error(
          `Timed out after ${OPERATION_TIMEOUT_MS / 60_000} minutes; last status: ${lastStatus}. Inspect Partner Center before retrying.`
        )
      return ms
    }
    async function request(urlPath, method, requestBody, type) {
      const response = await fetch(`${API_ORIGIN}${urlPath}`, {
        method,
        headers: { ...headers, ...(type && { 'Content-Type': type }) },
        ...(requestBody !== undefined && { body: requestBody }),
        redirect: 'error',
        signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining())),
      })
      const text = await response.text()
      // The status endpoint can return 202 with an InProgress operation body.
      const expected = method === 'POST' ? [202] : [200, 202]
      if (!expected.includes(response.status))
        throw new Error(
          `HTTP ${response.status} ${response.statusText}: ${text || '(empty response)'}`
        )
      return { response, text }
    }
    try {
      log(`${context}: starting`)
      // Never retry a POST automatically: its operation may already exist.
      const { response } = await request(path, 'POST', body, contentType)
      const id = operationId(response.headers.get('Location'), path)
      context = `Edge ${phase} operation ${id}`
      log(`${context}: accepted; waiting for Succeeded`)
      while (true) {
        const { text } = await request(`${path}/operations/${id}`, 'GET')
        let operation
        try {
          operation = JSON.parse(text)
        } catch {
          throw new Error(`Invalid operation response: ${text}`)
        }
        if (operation?.id !== id)
          throw new Error(`Operation ID mismatch: ${text}`)
        remaining()
        lastStatus = operation.status
        if (lastStatus === 'Succeeded') {
          log(`${context}: Succeeded`)
          return operation
        }
        // Include Microsoft's message, errorCode, errors and correlation data.
        if (lastStatus !== 'InProgress')
          throw new Error(`Operation did not succeed: ${text}`)
        log(`${context}: InProgress`)
        await wait(Math.min(POLL_INTERVAL_MS, remaining()))
      }
    } catch (error) {
      throw new Error(redact(`${context}: ${error.message}`))
    }
  }

  await runOperation(
    'upload',
    `${submissionPath}/draft/package`,
    await readFile(options.zip),
    'application/zip'
  )
  return runOperation('submission', submissionPath, '{}', 'application/json')
}
