import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { normalizeTarget } from '@/background/capture/normalizeTarget'
import { DownloadConfirmationDialog } from '@/popup/DownloadConfirmationDialog'
import { extensionBrowser as browser } from '@/shared/browser'
import type { DownloadConfirmation } from '@/shared/downloadConfirmation'
import { i18n } from '@/shared/i18n'
import { DOWNLOAD_ERROR } from '@/shared/integration'
import { defaultTaskOptions } from '@/shared/taskOptions'

it('shows the background draft and sends edited options with its original identity', async () => {
  await i18n.changeLanguage('en-US')
  let receive!: (message: { draft: DownloadConfirmation | null }) => void
  const port = {
    onMessage: {
      addListener: vi.fn((callback) => {
        receive = callback
      }),
    },
    onDisconnect: { addListener: vi.fn() },
    postMessage: vi.fn(),
    disconnect: vi.fn(),
  }
  Object.assign(browser, { windows: { getCurrent: async () => ({ id: 4 }) } })
  Object.assign(browser.runtime, { connect: vi.fn(() => port) })
  const { unmount } = render(<DownloadConfirmationDialog />)
  await waitFor(() =>
    expect(port.postMessage).toHaveBeenCalledWith({ windowId: 4 })
  )
  const draft: DownloadConfirmation = {
    id: 'draft-identity',
    phase: 'editing',
    windowId: 4,
    expiresAt: Date.now() + 120_000,
    target: normalizeTarget({
      url: 'https://example.com/one-use.zip',
      origin: 'context-menu',
    }),
    options: defaultTaskOptions('Browser UA'),
  }
  act(() => receive({ draft }))
  const user = userEvent.setup()
  await user.type(
    screen.getByRole('textbox', { name: 'Filename' }),
    'chosen.zip'
  )
  await user.click(screen.getByText('Request options'))
  expect(
    (screen.getByRole('textbox', { name: 'User-Agent' }) as HTMLInputElement)
      .value
  ).toBe('Browser UA')
  await user.click(screen.getByRole('button', { name: 'Add', exact: true }))
  expect(port.postMessage).toHaveBeenLastCalledWith({
    id: draft.id,
    decision: {
      action: 'submit',
      options: { ...draft.options, filename: 'chosen.zip' },
    },
  })
  expect(
    (
      screen.getByRole('button', {
        name: 'Add',
        exact: true,
      }) as HTMLButtonElement
    ).disabled
  ).toBe(true)
  expect(
    screen.getByRole('button', { name: 'Close', exact: true })
  ).toBeTruthy()
  expect(
    screen.queryByRole('button', { name: 'Cancel', exact: true })
  ).toBeNull()
  act(() =>
    receive({
      draft: { ...draft, phase: 'failed', error: DOWNLOAD_ERROR.rejected },
    })
  )
  expect(
    (
      screen.getByRole('button', {
        name: 'Add',
        exact: true,
      }) as HTMLButtonElement
    ).disabled
  ).toBe(false)
  expect(
    (screen.getByRole('textbox', { name: 'Filename' }) as HTMLInputElement)
      .value
  ).toBe('chosen.zip')
  act(() =>
    receive({
      draft: {
        ...draft,
        phase: 'unknown',
        error: DOWNLOAD_ERROR.resultUnknown,
      },
    })
  )
  expect(screen.getByRole('alert').textContent).toBe(
    i18n.t('popup.integration.resultUnknown')
  )
  expect(
    (
      screen.getByRole('button', {
        name: 'Add',
        exact: true,
      }) as HTMLButtonElement
    ).disabled
  ).toBe(true)
  expect(
    (
      screen.getByRole('button', {
        name: i18n.t('popup.confirmDownload.browser'),
      }) as HTMLButtonElement
    ).disabled
  ).toBe(true)
  act(() => receive({ draft: null }))
  expect(screen.queryByRole('dialog')).toBeNull()
  unmount()
  expect(port.disconnect).toHaveBeenCalledOnce()
})
