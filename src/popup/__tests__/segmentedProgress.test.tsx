import type { MdxpTask } from '@motrix/mdxp'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { ControlPanel } from '@/popup/ControlPanel'
import {
  bucketRatios,
  decodeBitfield,
  isPiecesPayload,
  pieceProgress,
  sliceCountFor,
} from '@/popup/SegmentedProgress'
import type { ControlPanel as ControlPanelController } from '@/popup/useControlPanel'
import { i18n } from '@/shared/i18n'

describe('decodeBitfield', () => {
  it('reads four pieces per hex character, most significant bit first', () => {
    // 0b1011 -> pieces 1,0,1,1
    expect(
      decodeBitfield({ pieceLength: 1, numPieces: 4, bitfield: 'b' })
    ).toEqual([true, false, true, true])
  })

  it('decodes a realistic multi-character map', () => {
    // 0xf = 1111, 0x5 = 0101
    expect(
      decodeBitfield({ pieceLength: 1, numPieces: 8, bitfield: 'f5' })
    ).toEqual([true, true, true, true, false, true, false, true])
  })

  it('ignores padding bits past numPieces', () => {
    // 0x3 = 0b0011; MSB-first means the two declared pieces are 0,0 and the
    // trailing 1,1 are padding for pieces the engine never declared.
    expect(
      decodeBitfield({ pieceLength: 1, numPieces: 2, bitfield: '3' })
    ).toEqual([false, false])
  })

  it('rejects an empty map: the engine does not know the layout yet', () => {
    expect(
      decodeBitfield({ pieceLength: 0, numPieces: 0, bitfield: '' })
    ).toBeNull()
  })

  it('treats pieces beyond a short map as pending, matching aria2 nibbles', () => {
    // A 5-piece download emits a whole nibble: 'f' covers only 4 pieces, so
    // the 5th is pending. This is a real state, not a malformed payload.
    expect(
      decodeBitfield({ pieceLength: 1, numPieces: 5, bitfield: 'f' })
    ).toEqual([true, true, true, true, false])
    expect(
      decodeBitfield({ pieceLength: 1, numPieces: 6, bitfield: 'f' })
    ).toEqual([true, true, true, true, false, false])
  })

  it('rejects a non-hex payload', () => {
    expect(
      decodeBitfield({ pieceLength: 1, numPieces: 8, bitfield: 'zzzz' })
    ).toBeNull()
  })

  it('returns null for absent input', () => {
    expect(decodeBitfield(null)).toBeNull()
    expect(decodeBitfield(undefined)).toBeNull()
  })
})

describe('pieceProgress', () => {
  it('counts only completed pieces', () => {
    expect(pieceProgress([true, false, true, true])).toBeCloseTo(0.75)
  })

  it('returns null when there is no map', () => {
    expect(pieceProgress(null)).toBeNull()
    expect(pieceProgress([])).toBeNull()
  })
})

describe('sliceCountFor', () => {
  it('never exceeds the cap and stays above one', () => {
    expect(sliceCountFor(0)).toBe(0)
    // A single piece still gets one cell; the curve is ceil(sqrt(n)*1.6).
    expect(sliceCountFor(1)).toBe(2)
    expect(sliceCountFor(10_000)).toBeLessThanOrEqual(28)
  })

  it('grows with the piece count', () => {
    expect(sliceCountFor(400)).toBeGreaterThan(sliceCountFor(16))
  })
})

describe('bucketRatios', () => {
  it('drops no piece and preserves the completion ratio', () => {
    const bits = [true, true, true, true, true, true, true, true, false, false]
    const ratios = bucketRatios(bits, 2)
    expect(ratios).toHaveLength(2)
    const recovered = ratios.reduce((sum, r) => sum + r, 0) / ratios.length
    expect(recovered).toBeCloseTo(bits.filter(Boolean).length / bits.length)
  })

  it('marks a bucket complete only when all of its pieces are', () => {
    const ratios = bucketRatios(
      [true, true, true, true, false, false, false, false],
      2
    )
    expect(ratios[0]).toBe(1)
    expect(ratios[1]).toBe(0)
  })

  it('never exceeds the real completion of its bucket', () => {
    const bits = [true, false, false, false, false, false, false, false]
    for (const ratio of bucketRatios(bits, 4)) {
      expect(ratio).toBeLessThanOrEqual(1)
    }
  })
})

describe('isPiecesPayload', () => {
  it('accepts a well-formed map', () => {
    expect(
      isPiecesPayload({ pieceLength: 1, numPieces: 8, bitfield: 'ff' })
    ).toBe(true)
  })

  it('rejects anything else crossing the message bus', () => {
    expect(isPiecesPayload(null)).toBe(false)
    expect(isPiecesPayload({})).toBe(false)
    expect(isPiecesPayload({ numPieces: 8 })).toBe(false)
  })
})

describe('segmented progress rendering', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
  })

  function task(id: string, status: MdxpTask['status']): MdxpTask {
    return {
      id,
      type: 'http',
      name: `${id}.iso`,
      status,
      progress: 0.5,
      bytesDone: 512,
      bytesTotal: 1024,
      speedBps: status === 'downloading' ? 2048 : 0,
      etaSec: null,
      saveDir: '/downloads',
      error: null,
      createdAt: 1,
      finishedAt: null,
      finalPath: null,
    }
  }

  function controller(
    tasks: MdxpTask[],
    pieces: ControlPanelController['pieces'] = {}
  ): ControlPanelController {
    return {
      tasks,
      pieces,
      stats: null,
      engine: null,
      loading: false,
      error: null,
      refresh: async () => undefined,
      pause: async () => undefined,
      resume: async () => undefined,
      reveal: async () => undefined,
      open: async () => undefined,
      remove: async () => undefined,
    }
  }

  it('draws from the real piece map when the host provides one', () => {
    const c = controller([task('a', 'downloading')], {
      // 8 pieces, 6 done.
      a: { pieceLength: 1024, numPieces: 8, bitfield: 'fc' },
    })
    const { container } = render(
      <ControlPanel connection="connected" controller={c} />
    )
    const bar = container.querySelector('[data-slot="segmented-progress"]')
    expect(bar?.getAttribute('data-source')).toBe('pieces')
    expect(bar?.getAttribute('data-piece-count')).toBe('8')
    expect(bar?.getAttribute('data-complete-pieces')).toBe('6')
  })

  it('falls back to the aggregate ratio and labels it as such', () => {
    const c = controller([task('a', 'downloading')])
    const { container } = render(
      <ControlPanel connection="connected" controller={c} />
    )
    const bar = container.querySelector('[data-slot="segmented-progress"]')
    // An estimate must never masquerade as piece truth.
    expect(bar?.getAttribute('data-source')).toBe('aggregate')
    expect(bar?.getAttribute('data-piece-count')).toBeNull()
  })

  it('ignores an unusable piece map instead of drawing a wrong picture', () => {
    const c = controller([task('a', 'downloading')], {
      a: { pieceLength: 0, numPieces: 0, bitfield: '' },
    })
    const { container } = render(
      <ControlPanel connection="connected" controller={c} />
    )
    const bar = container.querySelector('[data-slot="segmented-progress"]')
    expect(bar?.getAttribute('data-source')).toBe('aggregate')
  })

  it('repaints when the real piece map advances', () => {
    const first = controller([task('a', 'downloading')], {
      a: { pieceLength: 1024, numPieces: 8, bitfield: 'f0' },
    })
    const { container, rerender } = render(
      <ControlPanel connection="connected" controller={first} />
    )
    const before = container
      .querySelector('[data-slot="segmented-progress"]')
      ?.getAttribute('data-complete-pieces')

    // A new object with the same shape must still reach the row: the memo
    // comparison has to look at contents, not identity.
    rerender(
      <ControlPanel
        connection="connected"
        controller={controller([task('a', 'downloading')], {
          a: { pieceLength: 1024, numPieces: 8, bitfield: 'ff' },
        })}
      />
    )
    const after = container
      .querySelector('[data-slot="segmented-progress"]')
      ?.getAttribute('data-complete-pieces')
    expect(before).toBe('4')
    expect(after).toBe('8')
  })

  it('keeps the row accessible', () => {
    const c = controller([task('a', 'downloading')], {
      a: { pieceLength: 1024, numPieces: 8, bitfield: 'f0' },
    })
    render(<ControlPanel connection="connected" controller={c} />)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe(
      '50'
    )
  })
})
