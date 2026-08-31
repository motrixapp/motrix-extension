import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickSettingsPanel } from '@/popup/QuickSettingsPanel'
import type { QuickSettingsController } from '@/popup/useQuickSettings'
import { i18n } from '@/shared/i18n'

function controller(
  overrides: Partial<QuickSettingsController> = {}
): QuickSettingsController {
  return {
    takeover: {
      enabled: false,
      consentAckVersion: 1,
      defaultAction: 'motrix',
      rules: [],
    },
    notifications: {
      master: true,
      confirm: false,
      error: true,
      reminder: true,
    },
    loading: false,
    saving: false,
    error: null,
    consentRequired: false,
    reload: vi.fn(async () => undefined),
    requestTakeoverEnabled: vi.fn(async () => undefined),
    confirmTakeoverConsent: vi.fn(async () => undefined),
    cancelTakeoverConsent: vi.fn(),
    setNotification: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe('QuickSettingsPanel', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
  })

  it('renders five real switches and opens the full settings page', () => {
    const settings = controller()
    const onOpenFullSettings = vi.fn()
    render(
      <QuickSettingsPanel
        controller={settings}
        onOpenFullSettings={onOpenFullSettings}
      />
    )

    expect(screen.getAllByRole('switch')).toHaveLength(5)
    fireEvent.click(
      screen.getByRole('switch', {
        name: i18n.t('options.notifications.confirmLabel'),
      })
    )
    expect(settings.setNotification).toHaveBeenCalledWith('confirm', true)

    fireEvent.click(screen.getByTestId('full-settings-row'))
    expect(onOpenFullSettings).toHaveBeenCalledOnce()
  })

  it('disables notification detail switches while the master is off', () => {
    render(
      <QuickSettingsPanel
        controller={controller({
          notifications: {
            master: false,
            confirm: true,
            error: true,
            reminder: true,
          },
        })}
        onOpenFullSettings={vi.fn()}
      />
    )

    expect(
      screen
        .getByRole('switch', {
          name: i18n.t('options.notifications.masterLabel'),
        })
        .hasAttribute('data-disabled')
    ).toBe(false)
    for (const key of ['confirmLabel', 'errorLabel', 'reminderLabel']) {
      expect(
        screen
          .getByRole('switch', {
            name: i18n.t(`options.notifications.${key}`),
          })
          .hasAttribute('data-disabled')
      ).toBe(true)
    }
  })

  it('shows consent copy and delegates explicit confirm or cancel actions', () => {
    const settings = controller({ consentRequired: true })
    render(
      <QuickSettingsPanel controller={settings} onOpenFullSettings={vi.fn()} />
    )

    expect(
      screen.getByRole('alertdialog', {
        name: i18n.t('options.takeover.consentDialogLabel'),
      })
    ).toBeTruthy()

    fireEvent.click(
      screen.getByRole('button', {
        name: i18n.t('options.takeover.consentConfirm'),
      })
    )
    expect(settings.confirmTakeoverConsent).toHaveBeenCalledOnce()

    fireEvent.click(
      screen.getByRole('button', {
        name: i18n.t('options.takeover.consentCancel'),
      })
    )
    expect(settings.cancelTakeoverConsent).toHaveBeenCalled()
  })

  it('renders a retry action for load failures', () => {
    const settings = controller({
      takeover: null,
      notifications: null,
      error: { operation: 'load', message: 'background unavailable' },
    })
    render(
      <QuickSettingsPanel controller={settings} onOpenFullSettings={vi.fn()} />
    )

    fireEvent.click(screen.getByRole('button'))
    expect(settings.reload).toHaveBeenCalledOnce()
  })
})
