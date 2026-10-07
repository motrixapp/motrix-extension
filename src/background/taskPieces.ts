/**
 * `task/pieces` is not part of MDXP 0.8.x: it is an additive read the desktop
 * App registers when the engine can report a piece map, and advertises through
 * the optional `taskPieces` capability. An older App leaves the method
 * unregistered, so the call fails at the protocol level.
 */
const TASK_PIECES_METHOD = 'task/pieces'

export interface TaskPiecesResult {
  pieceLength: number
  numPieces: number
  /** Hex-encoded piece map; empty until the engine knows the piece layout. */
  bitfield: string
}

type PiecesBridge = {
  // `task/pieces` is outside MDXP 0.8.x's request map, so the method arrives as
  // a plain string; the dispatcher still validates params and authorizes.
  request: (method: never, params: never) => Promise<unknown>
}

/**
 * Best-effort piece map for one task.
 *
 * Never throws: progress display is advisory, and an unsupported method or a
 * disconnected session must degrade to aggregate progress rather than surface
 * an error in the task list. The cast steps over MDXP 0.8.x's request map; the
 * dispatcher still validates and authorizes the call.
 */
export async function requestTaskPieces(
  manager: PiecesBridge,
  taskId: string
): Promise<TaskPiecesResult> {
  const empty: TaskPiecesResult = {
    pieceLength: 0,
    numPieces: 0,
    bitfield: '',
  }
  try {
    const raw = (await manager.request(
      TASK_PIECES_METHOD as never,
      { taskId } as never
    )) as Partial<TaskPiecesResult> | null
    if (!raw || typeof raw !== 'object') return empty
    return {
      pieceLength: typeof raw.pieceLength === 'number' ? raw.pieceLength : 0,
      numPieces: typeof raw.numPieces === 'number' ? raw.numPieces : 0,
      bitfield: typeof raw.bitfield === 'string' ? raw.bitfield : '',
    }
  } catch {
    return empty
  }
}
