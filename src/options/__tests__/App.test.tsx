import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/shared/i18n'
import { App } from '@/options/App'
import { LINKS } from '@/shared/links'

// jsdom doesn't include ResizeObserver; the headless Switch thumb needs it.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

declare const browser: {
  runtime: {
    id: string
    getManifest: () => { version: string }
    sendMessage: (env: { kind: string; payload: unknown }) => Promise<unknown>
  }
}

beforeEach(() => {
  browser.runtime.id = 'x'
  browser.runtime.getManifest = vi.fn(() => ({ version: '1.0.0' }))
  browser.runtime.sendMessage = vi.fn(async (env) => {
    if (env.kind === 'bg.getTakeoverConfig')
      return {
        enabled: false,
        consentAckVersion: 0,
        defaultAction: 'motrix',
        rules: [],
      }
    if (env.kind === 'bg.getEndpointConfig')
      return {
        version: 3,
        activeEndpointId: 'local',
        servers: [],
        cleanupTombstones: [],
      }
    if (env.kind === 'bg.getPairingStatus') return { paired: false }
    if (env.kind === 'bg.getState') return { state: 'disconnected' }
    if (env.kind === 'bg.listAdapters') return { adapters: [] }
    if (env.kind === 'bg.getNotificationsConfig')
      return { master: true, confirm: false, error: true, reminder: true }
    return undefined
  })
})

describe('options App', () => {
  it('groups appearance and notifications in General and takeover in Downloads', async () => {
    const user = userEvent.setup()
    render(<App />)
    for (const name of [
      /general|通用/i,
      /downloads|下载/i,
      /integration|集成/i,
      /help|帮助/i,
    ]) {
      expect(screen.getByRole('tab', { name })).toBeTruthy()
    }
    expect(screen.queryByRole('tab', { name: /about|关于/i })).toBeNull()
    expect(screen.queryByRole('tab', { name: /appearance|外观/i })).toBeNull()
    expect(screen.getByRole('combobox', { name: /theme|主题/i })).toBeTruthy()
    expect(
      screen.getByRole('combobox', { name: /language|语言/i })
    ).toBeTruthy()
    expect(
      screen.getByRole('switch', { name: /system notifications|启用系统通知/i })
    ).toBeTruthy()
    expect(screen.queryByRole('spinbutton')).toBeNull()

    await user.click(screen.getByRole('tab', { name: /downloads|下载/i }))
    expect(await screen.findByRole('spinbutton')).toBeTruthy()
    expect(
      screen.getByRole('switch', { name: /send eligible downloads|启用接管/i })
    ).toBeTruthy()
    await waitFor(() =>
      expect(screen.queryAllByRole('combobox')).toHaveLength(0)
    )
    expect(
      screen.queryByRole('switch', {
        name: /system notifications|启用系统通知/i,
      })
    ).toBeNull()
  })

  it('keeps the website and GitHub links in the page header', () => {
    render(<App />)
    expect(
      screen
        .getByRole('link', { name: /official website|官方网站/i })
        .getAttribute('href')
    ).toBe(LINKS.website)
    expect(
      screen.getByRole('link', { name: 'GitHub' }).getAttribute('href')
    ).toBe(LINKS.repo)
  })
})
