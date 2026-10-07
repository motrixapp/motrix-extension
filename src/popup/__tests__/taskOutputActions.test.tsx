import type { MdxpTask } from '@motrix/mdxp'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ControlPanel } from '@/popup/ControlPanel'
import type { ControlPanel as ControlPanelController } from '@/popup/useControlPanel'
import { i18n } from '@/shared/i18n'

function task(
  id: string,
  name: string,
  status: MdxpTask['status'],
  overrides: Partial<MdxpTask> = {}
): MdxpTask {
  return {
    id,
    type: 'http',
    name,
    status,
    progress: status === 'completed' ? 1 : 0.5,
    bytesDone: status === 'completed' ? 1024 : 512,
    bytesTotal: 1024,
    speedBps: status === 'downloading' ? 2048 : 0,
    etaSec: null,
    saveDir: '/downloads',
    error: null,
    createdAt: 1,
    finishedAt: status === 'completed' ? 2 : null,
    finalPath: status === 'completed' ? `C:\\downloads\\${name}` : null,
    ...overrides,
  }
}

function controller(tasks: MdxpTask[]): ControlPanelController {
  return {
    tasks,
    stats: null,
    engine: null,
    loading: false,
    error: null,
    refresh: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    reveal: vi.fn(async () => undefined),
    open: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  }
}

describe('segmented progress', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn(async () => undefined) },
    })
  })

  it('renders discrete slices and a live leading edge', () => {
    const c = controller([task('a', 'a.iso', 'downloading')])
    const { container } = render(
      <ControlPanel connection="connected" controller={c} />
    )

    const bar = container.querySelector('[data-slot="segmented-progress"]')
    expect(bar).not.toBeNull()
    const segments = bar?.querySelectorAll('[data-slot="progress-segment"]')
    // A live download must be readable as slices, not one solid bar.
    expect((segments?.length ?? 0) >= 4).toBe(true)
    expect(bar?.getAttribute('role')).toBe('progressbar')
    expect(Number(bar?.getAttribute('aria-valuenow'))).toBe(50)
  })

  it('falls back to an aggregate-ratio estimate when the host reports no pieces', () => {
    const c = controller([
      task('a', 'a.iso', 'downloading', {
        progress: 0.5,
        bytesDone: 768,
        bytesTotal: 1024,
      }),
    ])
    const { container } = render(
      <ControlPanel connection="connected" controller={c} />
    )
    const bar = container.querySelector('[data-slot="segmented-progress"]')
    // No piece map: an estimate, explicitly labelled as one.
    expect(bar?.getAttribute('data-source')).toBe('aggregate')
    const segments = bar?.querySelectorAll('[data-slot="progress-segment"]')
    // 75% of 14 slices is 10 full segments plus a partial leading edge.
    const filled = [...(segments ?? [])].filter(
      (node) =>
        (node.firstElementChild as HTMLElement | null)?.style.width !== '0%'
    )
    expect(filled.length).toBeGreaterThanOrEqual(10)
  })

  it('marks a paused task with the paused treatment', () => {
    const c = controller([task('a', 'a.iso', 'paused')])
    const { container } = render(
      <ControlPanel connection="connected" controller={c} />
    )
    const segments = container.querySelectorAll(
      '[data-slot="progress-segment"] span'
    )
    const filled = [...segments].filter((n) =>
      n.className.includes('bg-muted-foreground')
    )
    expect(filled.length).toBeGreaterThan(0)
  })
})

/** Completed tasks live in the "recent" view, which is not the default tab. */
async function showRecent(): Promise<void> {
  const user = userEvent.setup()
  await user.click(screen.getByRole('tab', { name: /completed|已完成/i }))
}

describe('task output actions', () => {
  let writeText: ReturnType<typeof vi.fn>

  /**
   * Installs the clipboard spy. Must run *after* `userEvent.setup()`, which
   * replaces `navigator.clipboard` with its own stub.
   */
  const stubClipboard = (): void => {
    writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText },
    })
  }

  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
  })

  it('offers open, copy-path, and copy-name for a completed task', async () => {
    const c = controller([task('r', 'r.zip', 'completed')])
    render(
      <ControlPanel connection="connected" controller={c} canOpenFileTask />
    )
    await showRecent()
    expect(screen.getByTestId('task-open-file-r')).toBeTruthy()
    expect(screen.getByTestId('task-copy-path-r')).toBeTruthy()
    expect(screen.getByTestId('task-copy-name-r')).toBeTruthy()
  })

  it('hides the output strip while the output is not ready', () => {
    const c = controller([task('a', 'a.iso', 'downloading')])
    render(
      <ControlPanel connection="connected" controller={c} canOpenFileTask />
    )
    expect(screen.queryByTestId('task-output-actions-a')).toBeNull()
  })

  it('opens the file through the controller when supported', async () => {
    const user = userEvent.setup()
    const c = controller([task('r', 'r.zip', 'completed')])
    render(
      <ControlPanel connection="connected" controller={c} canOpenFileTask />
    )
    await showRecent()
    await user.click(screen.getByTestId('task-open-file-r'))
    expect(c.open).toHaveBeenCalledWith('r')
  })

  it('disables the open control when the App does not advertise task/open', async () => {
    const user = userEvent.setup()
    const c = controller([task('r', 'r.zip', 'completed')])
    render(<ControlPanel connection="connected" controller={c} />)
    await showRecent()
    const button = screen.getByTestId('task-open-file-r')
    expect(button.getAttribute('aria-disabled')).toBe('true')
    await user.click(button)
    // A dead control must never issue a request the peer cannot answer.
    expect(c.open).not.toHaveBeenCalled()
  })

  it('copies the absolute path to the clipboard', async () => {
    const user = userEvent.setup()
    const c = controller([task('r', 'r.zip', 'completed')])
    render(
      <ControlPanel connection="connected" controller={c} canOpenFileTask />
    )
    await showRecent()
    stubClipboard()
    await user.click(screen.getByTestId('task-copy-path-r'))
    // The clipboard write is promise-chained, so assert on it first.
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('C:\\downloads\\r.zip')
    )
    await waitFor(() =>
      expect(screen.getByTestId('task-copy-confirmation')).toBeTruthy()
    )
  })

  it('keeps the copy confirmation free of the absolute path', async () => {
    const user = userEvent.setup()
    const c = controller([task('r', 'r.zip', 'completed')])
    render(
      <ControlPanel connection="connected" controller={c} canOpenFileTask />
    )
    await showRecent()
    stubClipboard()
    await user.click(screen.getByTestId('task-copy-path-r'))
    const confirmation = await screen.findByTestId('task-copy-confirmation')
    expect(confirmation.textContent).not.toContain('C:\\downloads')
  })
})
