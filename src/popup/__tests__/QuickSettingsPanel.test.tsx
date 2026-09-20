import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickSettingsPanel } from '@/popup/QuickSettingsPanel'
import type { QuickSettingsController } from '@/popup/useQuickSettings'
import { i18n } from '@/shared/i18n'

function controller(
  overrides: Partial<QuickSettingsController> = {}
): QuickSettingsController {
  return {
    takeoverSupported: true,
    taskPanelSupported: true,
    currentSite: 'files.example.com',
    excludedSite: null,
    takeover: {
      enabled: false,
      openTaskPanelAfterSubmit: false,
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
    setOpenTaskPanelAfterSubmit: vi.fn(async () => undefined),
    setCurrentSiteExcluded: vi.fn(async () => undefined),
    setNotification: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe('QuickSettingsPanel', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
  })

  it('renders four real switches and opens the full settings page', () => {
    const settings = controller()
    const onOpenFullSettings = vi.fn()
    render(
      <QuickSettingsPanel
        controller={settings}
        onOpenFullSettings={onOpenFullSettings}
      />
    )

    expect(screen.getAllByRole('switch')).toHaveLength(4)
    fireEvent.click(
      screen.getByRole('switch', {
        name: i18n.t('options.notifications.masterLabel'),
      })
    )
    expect(settings.setNotification).toHaveBeenCalledWith('master', false)

    fireEvent.click(screen.getByTestId('full-settings-row'))
    expect(onOpenFullSettings).toHaveBeenCalledOnce()
  })

  it('shows remote takeover as unavailable while keeping notification controls usable', () => {
    const settings = controller({ takeoverSupported: false })
    settings.takeover = { ...settings.takeover!, enabled: true }
    render(
      <QuickSettingsPanel controller={settings} onOpenFullSettings={vi.fn()} />
    )
    const control = screen.getByRole('switch', {
      name: i18n.t('options.takeover.enableLabel'),
    })
    expect(control.hasAttribute('data-disabled')).toBe(true)
    expect(control.getAttribute('aria-checked')).toBe('false')
    expect(
      screen.getByText(i18n.t('options.takeover.remoteUnavailableShort'))
    ).toBeTruthy()
    fireEvent.click(control)
    expect(settings.requestTakeoverEnabled).not.toHaveBeenCalled()
    expect(
      screen
        .getByRole('switch', {
          name: i18n.t('options.notifications.masterLabel'),
        })
        .hasAttribute('data-disabled')
    ).toBe(false)
  })

  it('shows the current domain and persists the new quick settings independently of takeover', () => {
    const settings = controller({ takeoverSupported: false })
    render(
      <QuickSettingsPanel controller={settings} onOpenFullSettings={vi.fn()} />
    )
    expect(
      screen.getByText('Keep downloads from files.example.com in the browser')
    ).toBeTruthy()
    fireEvent.click(
      screen.getByRole('switch', {
        name: i18n.t('popup.quickSettings.excludeCurrentSite'),
      })
    )
    expect(settings.setCurrentSiteExcluded).toHaveBeenCalledWith(true)
    fireEvent.click(
      screen.getByRole('switch', {
        name: i18n.t('options.taskPanel.openAfterSubmit'),
      })
    )
    expect(settings.setOpenTaskPanelAfterSubmit).toHaveBeenCalledWith(true)
    for (const key of ['confirmLabel', 'errorLabel', 'reminderLabel']) {
      expect(
        screen.queryByRole('switch', {
          name: i18n.t(`options.notifications.${key}`),
        })
      ).toBeNull()
    }
  })

  it.each([
    { currentSite: null, excludedSite: null },
    { currentSite: 'files.example.com', excludedSite: 'example.com' },
  ])('disables exclusion for an unavailable or inherited site: %j', (site) => {
    const settings = controller(site)
    render(
      <QuickSettingsPanel controller={settings} onOpenFullSettings={vi.fn()} />
    )
    const control = screen.getByRole('switch', {
      name: i18n.t('popup.quickSettings.excludeCurrentSite'),
    })
    expect(control.hasAttribute('data-disabled')).toBe(true)
    fireEvent.click(control)
    expect(settings.setCurrentSiteExcluded).not.toHaveBeenCalled()
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
    expect(i18n.t('options.takeover.consentDialogLabel')).toBe(
      'Send downloads to Motrix?'
    )
    expect(i18n.t('options.takeover.consentConfirm')).toBe('Enable')
    expect(
      screen.getByText(
        "Motrix receives the site's login cookies to download files. Sensitive sites stay in the browser."
      )
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
