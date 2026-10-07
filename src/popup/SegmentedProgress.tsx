import { useMemo } from 'react'
import { cn } from '@/lib/utils'

/**
 * The engine's real per-piece completion map, as republished by Motrix's
 * `task/pieces`: aria2's `bitfield` is hex, four pieces per character, most
 * significant bit first.
 */
export interface TaskPieces {
  pieceLength: number
  numPieces: number
  /** Hex-encoded piece map. Empty until the engine knows the piece layout. */
  bitfield: string
}

/**
 * Decodes an aria2 bitfield into one boolean per piece.
 *
 * `numPieces` is authoritative and the hex string may be shorter than it needs:
 * aria2 emits a whole number of nibbles, so a 5-piece download carries
 * `'f'` (4 bits). Missing trailing characters mean those pieces are *pending*,
 * not that the state is unknown — the same rule Motrix's own renderer applies
 * in `statesFromBitfield`. Returns `null` only when nothing can be trusted: no
 * declared pieces, or a payload that is not hex at all.
 */
export function decodeBitfield(
  pieces: TaskPieces | null | undefined
): boolean[] | null {
  if (!pieces) return null
  const { bitfield, numPieces } = pieces
  if (numPieces <= 0) return null
  if (bitfield.length === 0) return null
  if (!/^[0-9a-fA-F]+$/.test(bitfield)) return null
  const bits: boolean[] = []
  for (let i = 0; i < numPieces; i += 1) {
    const hex = bitfield[i >> 2]
    if (hex === undefined) {
      // Beyond the reported map: not completed.
      bits.push(false)
      continue
    }
    const nibble = Number.parseInt(hex, 16)
    const bit = 3 - (i & 3)
    bits.push(((nibble >> bit) & 1) === 1)
  }
  return bits
}

/** Fraction of pieces complete, or null when the map is unusable. */
export function pieceProgress(bits: readonly boolean[] | null): number | null {
  if (!bits || bits.length === 0) return null
  let done = 0
  for (const bit of bits) if (bit) done += 1
  return done / bits.length
}

/**
 * How many slices to draw for a given real piece count.
 *
 * A 1000-piece BT download cannot be drawn literally in a ~300px popup row, so
 * pieces are bucketed into contiguous runs. The cell count grows with the
 * square root of the piece count: enough slices to show the head running
 * ahead, few enough to stay legible.
 */
export function sliceCountFor(pieceCount: number, max = 28): number {
  if (pieceCount <= 0) return 0
  return Math.min(max, Math.max(1, Math.ceil(Math.sqrt(pieceCount) * 1.6)))
}

/**
 * Per-cell completion in 0..1 for the real piece map.
 *
 * Each cell aggregates a contiguous run of pieces and reports the fraction of
 * that run which is complete — so a cell never claims more progress than
 * actually happened, and a head-most run that finished early reads as fully
 * lit while the tail is still dark. That is the real behaviour of a
 * multi-connection download.
 */
export function bucketRatios(
  bits: readonly boolean[],
  slices: number
): number[] {
  const out: number[] = []
  const per = bits.length / slices
  for (let i = 0; i < slices; i += 1) {
    const start = Math.floor(i * per)
    // The last slice absorbs the remainder so no piece is dropped.
    const end = i === slices - 1 ? bits.length : Math.floor((i + 1) * per)
    if (end <= start) {
      out.push(1)
      continue
    }
    let done = 0
    for (let j = start; j < end; j += 1) if (bits[j]) done += 1
    out.push(done / (end - start))
  }
  return out
}

/** Runtime guard for a `task/pieces` response crossing the message bus. */
export function isPiecesPayload(value: unknown): value is TaskPieces {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<TaskPieces>
  return (
    typeof candidate.numPieces === 'number' &&
    typeof candidate.bitfield === 'string' &&
    typeof candidate.pieceLength === 'number'
  )
}

/** One filled slice of the segmented track. */
function Segment({
  ratio,
  state,
}: {
  ratio: number
  state: 'downloading' | 'paused'
}): React.ReactElement {
  const clamped = Math.min(1, Math.max(0, ratio))
  return (
    <span
      className="relative h-full flex-1 overflow-hidden rounded-[1px] bg-muted"
      data-slot="progress-segment"
    >
      <span
        className={cn(
          'absolute inset-y-0 start-0 transition-[width]',
          state === 'paused' ? 'bg-muted-foreground' : 'bg-speed-download'
        )}
        style={{ width: `${clamped * 100}%` }}
      />
    </span>
  )
}

export interface SegmentedProgressProps extends React.ComponentProps<'div'> {
  /** 0..1 aggregate completion; the fallback when no piece map is available. */
  value: number
  /** The engine's real piece map. Preferred whenever it is usable. */
  pieces?: TaskPieces | null
  bytesDone?: number | null
  bytesTotal?: number | null
  state?: 'downloading' | 'paused'
}

/**
 * Progress drawn as discrete slices.
 *
 * When the App republishes the engine's piece map, the slices ARE the pieces:
 * every cell shows how much of its run of real pieces is done, so a
 * multi-connection download visibly runs ahead at the head instead of only
 * creeping as one aggregate bar. Without a usable map the component degrades to
 * slicing the aggregate ratio, and says so through `data-source` — an estimate
 * is never presented as piece truth.
 */
export function SegmentedProgress({
  value,
  pieces,
  bytesDone,
  bytesTotal,
  state = 'downloading',
  className,
  ...props
}: SegmentedProgressProps): React.ReactElement {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100)
  const bits = useMemo(() => decodeBitfield(pieces), [pieces])

  // A known byte total is a better fallback than a coarse ratio.
  const byteRatio =
    typeof bytesDone === 'number' &&
    typeof bytesTotal === 'number' &&
    bytesTotal > 0 &&
    bytesDone > 0
      ? Math.min(1, bytesDone / bytesTotal)
      : null
  const aggregate = Math.max(0, Math.min(1, byteRatio ?? value))

  const cells = useMemo(() => {
    if (bits) {
      return {
        source: 'pieces' as const,
        pieceCount: bits.length,
        complete: bits.filter(Boolean).length,
        ratios: bucketRatios(bits, sliceCountFor(bits.length)),
      }
    }
    // Fallback: evenly spaced slices of the aggregate fraction. A visual aid,
    // not a piece map.
    const count = 14
    const full = Math.floor(aggregate * count)
    const partial = aggregate * count - full
    return {
      source: 'aggregate' as const,
      pieceCount: 0,
      complete: 0,
      ratios: Array.from({ length: count }, (_u, index) =>
        index < full ? 1 : index === full ? partial : 0
      ),
    }
  }, [bits, aggregate])

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      data-slot="segmented-progress"
      data-source={cells.source}
      data-piece-count={cells.pieceCount || undefined}
      data-complete-pieces={cells.pieceCount ? cells.complete : undefined}
      className={cn('flex h-1 w-full items-stretch gap-[2px]', className)}
      {...props}
    >
      {cells.ratios.map((ratio, index) => (
        <Segment
          // A slice's identity IS its position: the track is rebuilt whenever
          // the slice count changes, so no stable key exists or is needed.
          // biome-ignore lint/suspicious/noArrayIndexKey: positional by design
          key={`segment-${index}`}
          ratio={ratio}
          state={state}
        />
      ))}
    </div>
  )
}
