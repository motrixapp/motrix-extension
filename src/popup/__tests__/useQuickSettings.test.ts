import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/background/MessageBus', () => ({ send: vi.fn() }))

import * as MessageBus from '@/background/MessageBus'
import { useQuickSettings } from '@/popup/useQuickSettings'
import type { NotificationsConfig } from '@/shared/notifications'
import { CONSENT_VERSION, type TakeoverConfig } from '@/shared/takeover'

const send = vi.mocked(MessageBus.send)

const TAKEOVER: TakeoverConfig = {
  enabled: false,
  consentAckVersion: 0,
  defaultAction: 'chrome',
  rules: [
    {
      id: 'large-files',
      match: { minSizeMB: 25, mimePatterns: ['application/*'] },
      action: 'ask',
    },
  ],
}

const NOTIFICATIONS: NotificationsConfig = {
  master: true,
  confirm: false,
  error: true,
  reminder: true,
}

function mockSuccessfulBus(): void {
  send.mockImplementation(async (kind: string) => {
    if (kind === 'bg.getTakeoverConfig') return structuredClone(TAKEOVER)
    if (kind === 'bg.getNotificationsConfig') {
      return structuredClone(NOTIFICATIONS)
    }
    return { ok: true }
  })
}

describe('useQuickSettings', () => {
  beforeEach(() => {
    send.mockReset()
  })

  it('loads both background-owned configs', async () => {
    mockSuccessfulBus()
    const { result } = renderHook(() => useQuickSettings())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.takeover).toEqual(TAKEOVER)
    expect(result.current.notifications).toEqual(NOTIFICATIONS)
    expect(result.current.error).toBeNull()
  })

  it('requires explicit consent before first enable and preserves all fields', async () => {
    mockSuccessfulBus()
    const { result } = renderHook(() => useQuickSettings())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.requestTakeoverEnabled(true)
    })

    expect(result.current.consentRequired).toBe(true)
    expect(result.current.takeover?.enabled).toBe(false)
    expect(
      send.mock.calls.filter(([kind]) => kind === 'bg.setTakeoverConfig')
    ).toHaveLength(0)

    await act(async () => {
      await result.current.confirmTakeoverConsent()
    })

    expect(result.current.consentRequired).toBe(false)
    expect(result.current.takeover).toEqual({
      ...TAKEOVER,
      enabled: true,
      consentAckVersion: CONSENT_VERSION,
    })
    expect(send).toHaveBeenCalledWith('bg.setTakeoverConfig', {
      ...TAKEOVER,
      enabled: true,
      consentAckVersion: CONSENT_VERSION,
    })
  })

  it('changes one notification flag without resetting the others', async () => {
    mockSuccessfulBus()
    const { result } = renderHook(() => useQuickSettings())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.setNotification('confirm', true)
    })

    const expected = { ...NOTIFICATIONS, confirm: true }
    expect(result.current.notifications).toEqual(expected)
    expect(send).toHaveBeenCalledWith('bg.setNotificationsConfig', expected)
  })

  it('rolls an optimistic update back and exposes save errors', async () => {
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.getTakeoverConfig') {
        return { ...TAKEOVER, consentAckVersion: CONSENT_VERSION }
      }
      if (kind === 'bg.getNotificationsConfig') return NOTIFICATIONS
      if (kind === 'bg.setTakeoverConfig') throw new Error('storage failed')
      return { ok: true }
    })
    const { result } = renderHook(() => useQuickSettings())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.requestTakeoverEnabled(true)
    })

    expect(result.current.takeover?.enabled).toBe(false)
    expect(result.current.error).toEqual({
      operation: 'save',
      message: 'storage failed',
    })
  })

  it('exposes load errors and can retry', async () => {
    let fail = true
    send.mockImplementation(async (kind: string) => {
      if (fail) throw new Error('background unavailable')
      if (kind === 'bg.getTakeoverConfig') return TAKEOVER
      if (kind === 'bg.getNotificationsConfig') return NOTIFICATIONS
      return { ok: true }
    })
    const { result } = renderHook(() => useQuickSettings())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toEqual({
      operation: 'load',
      message: 'background unavailable',
    })

    fail = false
    await act(async () => {
      await result.current.reload()
    })

    expect(result.current.takeover).toEqual(TAKEOVER)
    expect(result.current.notifications).toEqual(NOTIFICATIONS)
    expect(result.current.error).toBeNull()
  })
})
