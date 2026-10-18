const READY_EXPRESSION =
  'typeof globalThis.checkFetchReceiver === "function" && typeof globalThis.runCase === "function"'

/** A browsing context can expose its URL before the fixture script executes. */
export async function waitForFirefoxFixture(
  command,
  runnerUrl,
  {
    timeoutMs = 10_000,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}
) {
  const deadline = now() + timeoutMs
  let lastState = 'runner page not found'
  while (now() < deadline) {
    const tree = await command('browsingContext.getTree', {})
    const context = tree.contexts.find(
      (page) => page.url === runnerUrl
    )?.context
    if (context) {
      const response = await command('script.evaluate', {
        expression: READY_EXPRESSION,
        target: { context },
        awaitPromise: false,
        resultOwnership: 'none',
      })
      if (response.type !== 'success')
        throw new Error(
          `Firefox fixture readiness failed: ${JSON.stringify(response)}`
        )
      if (response.result.type === 'boolean' && response.result.value === true)
        return context
      lastState = 'runner page found; fixture functions are not ready'
    }
    await sleep(100)
  }
  throw new Error(`Firefox fixture did not initialize: ${lastState}`)
}
