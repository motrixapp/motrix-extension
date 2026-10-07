import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearTakeoverDeclines,
  listTakeoverDeclines,
  recordTakeoverDecline,
  TAKEOVER_DECLINE,
} from '@/background/interception/takeoverDeclines'
import { send } from '@/background/MessageBus'
import { TakeoverDeclineNotice } from '@/popup/TakeoverDeclineNotice'
import { i18n } from '@/shared/i18n'

vi.mock('@/background/MessageBus', () => ({ send: vi.fn() }))

describe('takeover decline ledger', () => {
  beforeEach(() => clearTakeoverDeclines())

  it('keeps only the host, never the full URL', () => {
    recordTakeoverDecline(TAKEOVER_DECLINE.unknownSize, 'cdn.example.com')
    const [record] = listTakeoverDeclines()
    expect(record?.host).toBe('cdn.example.com')
    expect(JSON.stringify(record)).not.toContain('/file')
    expect(JSON.stringify(record)).not.toContain('token')
  })

  it('is bounded so a long-lived worker cannot grow it without limit', () => {
    for (let i = 0; i < 120; i += 1) {
      recordTakeoverDecline(TAKEOVER_DECLINE.policyDeclined, `h${i}.test`)
    }
    expect(listTakeoverDeclines().length).toBeLessThanOrEqual(50)
  })

  it('returns newest first', () => {
    recordTakeoverDecline(TAKEOVER_DECLINE.policyDeclined, 'first.test')
    recordTakeoverDecline(TAKEOVER_DECLINE.unknownSize, 'second.test')
    expect(listTakeoverDeclines()[0]?.host).toBe('second.test')
  })
})

describe('TakeoverDeclineNotice', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
  })
  afterEach(() => vi.mocked(send).mockReset())

  const asDeclines = (rows: Array<[string, string]>) =>
    rows.map(([code, host], index) => ({
      at: Date.now() - index,
      code,
      host,
      nativeCancelled: false,
    }))

  it('stays hidden and does not poll when takeover is off', async () => {
    vi.mocked(send).mockResolvedValue(
      asDeclines([[TAKEOVER_DECLINE.unknownSize, 'cdn.example.com']])
    )
    render(<TakeoverDeclineNotice enabled={false} />)
    // Nothing to explain while the feature is off: no read, no notice.
    expect(send).not.toHaveBeenCalled()
    expect(screen.queryByTestId('takeover-decline-notice')).toBeNull()
  })

  it('stays hidden when nothing was declined', async () => {
    vi.mocked(send).mockResolvedValue([])
    render(<TakeoverDeclineNotice enabled />)
    await waitFor(() => expect(send).toHaveBeenCalled())
    expect(screen.queryByTestId('takeover-decline-notice')).toBeNull()
  })

  it('names the host and the reason', async () => {
    vi.mocked(send).mockResolvedValue(
      asDeclines([[TAKEOVER_DECLINE.unknownSize, 'cdn.example.com']])
    )
    render(<TakeoverDeclineNotice enabled />)
    const notice = await screen.findByTestId('takeover-decline-notice')
    expect(notice.textContent).toContain('cdn.example.com')
    expect(notice.textContent).toContain('its size was unknown')
  })

  it('drops stale records', async () => {
    const old = Date.now() - 60 * 60_000
    vi.mocked(send).mockResolvedValue([
      {
        at: old,
        code: TAKEOVER_DECLINE.policyDeclined,
        host: 'old.test',
        nativeCancelled: false,
      },
    ])
    render(<TakeoverDeclineNotice enabled />)
    await waitFor(() => expect(send).toHaveBeenCalled())
    expect(screen.queryByTestId('takeover-decline-notice')).toBeNull()
  })

  it('can be dismissed for the current batch', async () => {
    const user = userEvent.setup()
    vi.mocked(send).mockResolvedValue(
      asDeclines([
        [TAKEOVER_DECLINE.unknownSize, 'a.test'],
        [TAKEOVER_DECLINE.policyDeclined, 'b.test'],
      ])
    )
    render(<TakeoverDeclineNotice enabled />)
    await user.click(
      await screen.findByRole('button', { name: /cancel|dismiss|取消/i })
    )
    await waitFor(() =>
      expect(screen.queryByTestId('takeover-decline-notice')).toBeNull()
    )
  })
})
