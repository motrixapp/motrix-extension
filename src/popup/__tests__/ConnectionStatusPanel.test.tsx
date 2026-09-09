import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionStatusPanel } from '@/popup/ConnectionStatusPanel'
import type { PopupState } from '@/popup/usePopupState'
import { i18n } from '@/shared/i18n'

function baseState(overrides: Partial<PopupState> = {}): PopupState {
  return {
    loading: false,
    connection: 'disconnected',
    lastError: null,
    lastErrorReason: null,
    endpoint: null,
    server: null,
    backoff: null,
    recoveryExhaustedUnattended: false,
    degraded: false,
    pairingCode: null,
    ...overrides,
  } as PopupState
}

describe('ConnectionStatusPanel error copy', () => {
  it('renders localized copy for a typed failure reason, never the raw message', () => {
    render(
      <ConnectionStatusPanel
        state={baseState({
          lastError: 'the peer refused the pairing',
          lastErrorReason: 'peerRejected',
        })}
        onReconnect={vi.fn()}
      />
    )
    expect(
      screen.getByText(i18n.t('errors.connection.peerRejected'))
    ).toBeTruthy()
    expect(screen.queryByText('the peer refused the pairing')).toBeNull()
  })

  it('renders generic copy for an untyped error', () => {
    render(
      <ConnectionStatusPanel
        state={baseState({ lastError: 'ECONNREFUSED 127.0.0.1:16802' })}
        onReconnect={vi.fn()}
      />
    )
    expect(screen.getByText(i18n.t('errors.connection.generic'))).toBeTruthy()
    expect(screen.queryByText(/ECONNREFUSED/)).toBeNull()
  })

  it.each([
    ['backendUpgradeRequired', 'errors.connection.backendUpgradeRequired'],
    ['extensionUpgradeRequired', 'errors.connection.extensionUpgradeRequired'],
    ['unsupportedRemote', 'errors.connection.unsupportedRemote'],
    [
      'remoteDiscoveryUnavailable',
      'errors.connection.remoteDiscoveryUnavailable',
    ],
    ['remotePairingUnavailable', 'errors.connection.remotePairingUnavailable'],
  ])('renders directional compatibility copy for %s', (reason, key) => {
    render(
      <ConnectionStatusPanel
        state={baseState({
          lastError: `developer-only: ${reason}`,
          lastErrorReason: reason,
        })}
        onReconnect={vi.fn()}
      />
    )
    expect(screen.getByText(i18n.t(key))).toBeTruthy()
    expect(screen.queryByText(`developer-only: ${reason}`)).toBeNull()
  })

  it('shows no error alert when there is no error', () => {
    render(<ConnectionStatusPanel state={baseState()} onReconnect={vi.fn()} />)
    expect(screen.queryByText(i18n.t('errors.connection.generic'))).toBeNull()
    expect(
      screen.queryByRole('button', {
        name: i18n.t('options.help.copyDiagnostics'),
      })
    ).toBeNull()
  })

  it('disables the connect button and counts down while the §7.3 backoff is active', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      render(
        <ConnectionStatusPanel
          state={baseState({ backoff: { retryAtMs: 1_000_000 + 30_000 } })}
          onReconnect={vi.fn()}
        />
      )
      const button = screen.getByRole('button', {
        name: i18n.t('popup.pairing.retryIn', { seconds: 30 }),
      }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('acknowledges a connect click immediately by entering a pending state', async () => {
    const onReconnect = vi.fn()
    render(
      <ConnectionStatusPanel state={baseState()} onReconnect={onReconnect} />
    )
    const button = screen.getByRole('button', {
      name: i18n.t('popup.reconnect'),
    }) as HTMLButtonElement
    await userEvent.click(button)
    expect(onReconnect).toHaveBeenCalledOnce()
    expect(button.disabled).toBe(true)
  })

  it('reopens a pending pairing prompt instead of starting another connection', async () => {
    const onReconnect = vi.fn()
    const onShowPairing = vi.fn()
    render(
      <ConnectionStatusPanel
        state={baseState({
          connection: 'awaiting-code',
          pairingCode: {
            run: 1,
            maxRuns: 3,
            attemptsRemaining: null,
            deadlineMs: Date.now() + 60_000,
          },
        })}
        onReconnect={onReconnect}
        onShowPairing={onShowPairing}
      />
    )

    await userEvent.click(
      screen.getByRole('button', {
        name: i18n.t('popup.pairing.enterCode'),
      })
    )
    expect(onShowPairing).toHaveBeenCalledOnce()
    expect(onReconnect).not.toHaveBeenCalled()
  })
})

describe('ConnectionStatusPanel diagnostic copy', () => {
  beforeEach(() => {
    browser.runtime.getManifest = vi.fn(() => ({
      manifest_version: 3,
      name: 'Motrix',
      version: '0.1.7',
    }))
  })

  it('copies the full error with environment data without reconnecting', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    const onReconnect = vi.fn()
    render(
      <ConnectionStatusPanel
        state={baseState({
          lastError: 'ECONNREFUSED 127.0.0.1:16802',
          lastErrorReason: 'channelUnavailable',
        })}
        onReconnect={onReconnect}
      />
    )

    await user.click(
      screen.getByRole('button', {
        name: i18n.t('options.help.copyDiagnostics'),
      })
    )

    const text = writeText.mock.calls[0]?.[0] ?? ''
    expect(text).toContain('ECONNREFUSED 127.0.0.1:16802')
    expect(text).toContain('channelUnavailable')
    expect(text).toContain('0.1.7')
    expect(text).toContain(navigator.userAgent)
    expect(text).toContain('test-extension-id')
    expect(
      screen.getByRole('button', { name: i18n.t('options.help.copied') })
    ).toBeTruthy()
    expect(onReconnect).not.toHaveBeenCalled()
  })

  it('reports clipboard denial and lets the user retry', async () => {
    const user = userEvent.setup()
    const writeText = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'))
      .mockResolvedValue(undefined)
    render(
      <ConnectionStatusPanel
        state={baseState({ lastError: 'NM bootstrap timeout' })}
        onReconnect={vi.fn()}
      />
    )
    const button = screen.getByRole('button', {
      name: i18n.t('options.help.copyDiagnostics'),
    })
    await user.click(button)
    expect(
      screen.getByText(i18n.t('errors.connection.diagnosticsCopyFailed'))
    ).toBeTruthy()
    expect(screen.queryByText(i18n.t('options.help.copied'))).toBeNull()

    await user.click(button)
    expect(writeText).toHaveBeenCalledTimes(2)
    expect(screen.getByText(i18n.t('options.help.copied'))).toBeTruthy()
    expect(
      screen.queryByText(i18n.t('errors.connection.diagnosticsCopyFailed'))
    ).toBeNull()
  })

  it('resets copied feedback and copies the new error when the failure changes', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    const { rerender } = render(
      <ConnectionStatusPanel
        state={baseState({ lastError: 'old failure' })}
        onReconnect={vi.fn()}
      />
    )
    await user.click(
      screen.getByRole('button', {
        name: i18n.t('options.help.copyDiagnostics'),
      })
    )

    rerender(
      <ConnectionStatusPanel
        state={baseState({ lastError: 'new failure' })}
        onReconnect={vi.fn()}
      />
    )
    await user.click(
      screen.getByRole('button', {
        name: i18n.t('options.help.copyDiagnostics'),
      })
    )
    expect(writeText.mock.calls.at(-1)?.[0]).toContain('new failure')
    expect(writeText.mock.calls.at(-1)?.[0]).not.toContain('old failure')
  })
})
