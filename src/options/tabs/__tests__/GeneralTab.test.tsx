import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/shared/i18n'
import { ENDPOINT_CONFIG_STORAGE_KEY } from '@/background/EndpointConfigStore'
import { GeneralTab } from '@/options/tabs/GeneralTab'
import type { NotificationsConfig } from '@/shared/notifications'
import type { TakeoverConfig } from '@/shared/takeover'

// jsdom doesn't include ResizeObserver; the headless Switch thumb needs it.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

declare const browser: {
  storage: {
    onChanged: {
      addListener: (
        listener: (changes: Record<string, unknown>, area: string) => void
      ) => void
      removeListener: (listener: unknown) => void
    }
  }
  runtime: {
    sendMessage: (env: { kind: string; payload: unknown }) => Promise<unknown>
  }
}

let savedTakeover: TakeoverConfig | null
let savedNotify: NotificationsConfig | null

function mockBg(notif: NotificationsConfig): void {
  savedTakeover = null
  savedNotify = null
  browser.runtime.sendMessage = vi.fn(async (env) => {
    if (env.kind === 'bg.getEndpointConfig')
      return { activeEndpointId: 'local' }
    if (env.kind === 'bg.getTakeoverConfig') {
      return {
        enabled: false,
        consentAckVersion: 0,
        defaultAction: 'motrix',
        rules: [],
      } satisfies TakeoverConfig
    }
    if (env.kind === 'bg.setTakeoverConfig') {
      savedTakeover = env.payload as TakeoverConfig
      return undefined
    }
    if (env.kind === 'bg.getNotificationsConfig') return notif
    if (env.kind === 'bg.setNotificationsConfig') {
      savedNotify = env.payload as NotificationsConfig
      return { ok: true }
    }
    throw new Error(`unexpected ${env.kind}`)
  })
}

beforeEach(() => {
  mockBg({ master: true, confirm: false, error: true, reminder: true })
})

describe('GeneralTab', () => {
  it('gates first enable on consent, then Apply persists both configs', async () => {
    render(<GeneralTab />)
    await screen.findByRole('switch', {
      name: /send eligible downloads|将符合条件的下载发送到 Motrix/i,
    })
    fireEvent.click(
      screen.getByRole('switch', {
        name: /send eligible downloads|将符合条件的下载发送到 Motrix/i,
      })
    )
    fireEvent.click(
      await screen.findByRole('button', { name: /enable|开启|understand/i })
    )
    fireEvent.click(screen.getByRole('button', { name: /apply|应用/i }))
    await waitFor(() => {
      expect(savedTakeover?.enabled).toBe(true)
      expect(savedTakeover?.consentAckVersion).toBe(1)
      // single Apply also persisted the notifications config
      expect(savedNotify).toEqual({
        master: true,
        confirm: false,
        error: true,
        reminder: true,
      })
    })
  })

  it('disables remote takeover, retains the local preference on Apply, and reacts to selection changes', async () => {
    let activeEndpointId = 'nas'
    const originalSend = browser.runtime.sendMessage
    browser.runtime.sendMessage = vi.fn(async (env) => {
      if (env.kind === 'bg.getEndpointConfig') return { activeEndpointId }
      if (env.kind === 'bg.getTakeoverConfig')
        return {
          enabled: true,
          consentAckVersion: 1,
          defaultAction: 'motrix',
          rules: [],
        }
      return originalSend(env)
    })
    const { unmount } = render(<GeneralTab />)
    const control = await screen.findByRole('switch', {
      name: /send eligible downloads/i,
    })
    await screen.findByText(
      /Automatic takeover currently requires the local Motrix App/
    )
    expect(control.hasAttribute('data-disabled')).toBe(true)
    expect(control.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(
      screen.getByRole('switch', { name: /system notifications/i })
    )
    fireEvent.click(screen.getByRole('button', { name: /apply/i }))
    await waitFor(() => expect(savedTakeover?.enabled).toBe(true))
    const changed = vi
      .mocked(browser.storage.onChanged.addListener)
      .mock.calls.at(-1)![0]
    activeEndpointId = 'local'
    act(() => changed({ [ENDPOINT_CONFIG_STORAGE_KEY]: {} }, 'local'))
    await waitFor(() =>
      expect(control.hasAttribute('data-disabled')).toBe(false)
    )
    expect(control.getAttribute('aria-checked')).toBe('true')
    activeEndpointId = 'nas'
    act(() => changed({ [ENDPOINT_CONFIG_STORAGE_KEY]: {} }, 'local'))
    await waitFor(() =>
      expect(control.hasAttribute('data-disabled')).toBe(true)
    )
    expect(control.getAttribute('aria-checked')).toBe('false')
    unmount()
    expect(browser.storage.onChanged.removeListener).toHaveBeenCalledWith(
      changed
    )
  })

  it('hides the three detail switches when master is off', async () => {
    mockBg({ master: false, confirm: false, error: true, reminder: true })
    render(<GeneralTab />)
    // master switch is always present
    await screen.findByRole('switch', {
      name: /system notifications|启用系统通知/i,
    })
    // after load (master=false) the detail switches are not rendered
    await waitFor(() => {
      expect(
        screen.queryByRole('switch', {
          name: /success|confirmation|成功|确认/i,
        })
      ).toBeNull()
      expect(
        screen.queryByRole('switch', { name: /failure|error|失败|错误/i })
      ).toBeNull()
      expect(
        screen.queryByRole('switch', { name: /reminder|提醒/i })
      ).toBeNull()
    })
  })

  it('flipping a detail switch then Apply persists the notifications config', async () => {
    render(<GeneralTab />)
    const confirm = await screen.findByRole('switch', {
      name: /success|confirmation|成功|确认/i,
    })
    fireEvent.click(confirm)
    fireEvent.click(screen.getByRole('button', { name: /apply|应用/i }))
    await waitFor(() => {
      expect(savedNotify).toEqual({
        master: true,
        confirm: true,
        error: true,
        reminder: true,
      })
    })
  })

  it('shows an error instead of saved when the background rejects a setting', async () => {
    browser.runtime.sendMessage = vi.fn(async (env) => {
      if (env.kind === 'bg.getEndpointConfig')
        return { activeEndpointId: 'local' }
      if (env.kind === 'bg.getTakeoverConfig') {
        return {
          enabled: false,
          consentAckVersion: 0,
          defaultAction: 'motrix',
          rules: [],
        } satisfies TakeoverConfig
      }
      if (env.kind === 'bg.getNotificationsConfig') {
        return { master: true, confirm: false, error: true, reminder: true }
      }
      if (env.kind === 'bg.setTakeoverConfig') {
        return { error: 'storage unavailable' }
      }
      return { ok: true }
    })
    render(<GeneralTab />)
    const master = await screen.findByRole('switch', {
      name: /system notifications|启用系统通知/i,
    })
    fireEvent.click(master)
    fireEvent.click(screen.getByRole('button', { name: /apply|应用/i }))

    expect(await screen.findByText('storage unavailable')).toBeTruthy()
    expect(screen.queryByText(/^saved$|^已保存$/i)).toBeNull()
  })

  it('contains a background startup failure instead of leaking an unhandled load rejection', async () => {
    browser.runtime.sendMessage = vi.fn(async () => ({
      error: 'background startup unavailable',
    }))

    render(<GeneralTab />)

    expect(
      (
        await screen.findByText(/settings could not be loaded|设置加载失败/i)
      ).getAttribute('role')
    ).toBe('alert')
    expect(
      screen.queryByRole('switch', {
        name: /send eligible downloads|将符合条件的下载发送到 Motrix/i,
      })
    ).toBeNull()
  })
})
