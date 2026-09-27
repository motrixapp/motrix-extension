import { describe, expect, it } from 'vitest'
import { buildManualTaskSubmitParams } from '@/background/manualTask'
import { parseManualTaskInput } from '@/shared/manualTask'
import {
  applyTaskOptions,
  defaultTaskOptions,
  taskOptionsSchema,
} from '@/shared/taskOptions'

describe('task form options', () => {
  it('forwards chosen filename and browser request context without probing a URL', () => {
    const parsed = parseManualTaskInput('https://example.com/file.zip')
    if (!parsed.ok) throw new Error('fixture')
    const params = buildManualTaskSubmitParams(
      parsed.value,
      'task-options-key',
      1
    )
    const options = {
      ...defaultTaskOptions('Current Browser UA'),
      filename: '../chosen.zip',
      referer: 'https://example.com/page',
      cookie: 'session=user-value',
      authorization: 'Bearer user-value',
      extraHeaders: 'X-Token: example',
    }
    const result = applyTaskOptions(params, options)
    expect(result.meta.suggestedFilename).toBe('.._chosen.zip')
    expect(result.selection).toMatchObject({
      primary: {
        headers: {
          'User-Agent': 'Current Browser UA',
          Referer: options.referer,
          Cookie: options.cookie,
          Authorization: options.authorization,
          'X-Token': 'example',
        },
        cookies: [],
      },
    })
    expect(params.meta.suggestedFilename).toBe('file.zip')
  })

  it.each([
    'bad header',
    'User-Agent: conflicting',
    'Host: forged',
    'X-Test: a\nx-test: b',
    'X-Test: value\0injection',
  ])('rejects unsafe or ambiguous extra headers: %s', (extraHeaders) => {
    expect(
      taskOptionsSchema.safeParse({ ...defaultTaskOptions('UA'), extraHeaders })
        .success
    ).toBe(false)
  })

  it('does not attach HTTP options to a magnet', () => {
    const parsed = parseManualTaskInput('magnet:?xt=urn:btih:abcdef')
    if (!parsed.ok) throw new Error('fixture')
    const params = buildManualTaskSubmitParams(
      parsed.value,
      'task-options-key',
      1
    )
    expect(
      applyTaskOptions(params, defaultTaskOptions('UA')).selection
    ).toEqual(params.selection)
  })
})
