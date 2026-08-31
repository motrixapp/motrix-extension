/** Retired credential namespaces that must never be reused. */
const RETIRED_PAIR_TOKEN_STORAGE_KEYS = [
  'motrix.pairTokens',
  'motrix.pairToken',
]

export interface StorageKeyRemover {
  remove(keys: string | string[]): Promise<void>
}

/**
 * Permanently remove the token-era pairing stores.
 *
 * Values are deliberately neither read nor parsed: no token shape, including
 * an unknown future version, is a valid input to MBP1 credential migration.
 * Repeating the exact remove on every service-worker start is the tombstone;
 * a marker could be left behind while a rolled-back build writes a token back.
 *
 * Service-worker startup invokes this on every wake before endpoint
 * autostart. It is intentionally not a data migration: retired secrets are
 * only deleted, never decoded or copied into MBP1 state.
 */
export async function purgeRetiredPairTokenStorage(
  storage: StorageKeyRemover = browser.storage.local
): Promise<void> {
  await storage.remove([...RETIRED_PAIR_TOKEN_STORAGE_KEYS])
}

/** Testable startup barrier: autostart is unreachable until both the blind
 * token tombstone and interrupted authority cleanup have completed. */
export async function recoverStorageBeforeEndpointAutostart(
  deps: {
    recoverPendingEndpointCleanup: () => Promise<void>
    autostart: () => Promise<void>
  },
  storage: StorageKeyRemover = browser.storage.local
): Promise<void> {
  await purgeRetiredPairTokenStorage(storage)
  await deps.recoverPendingEndpointCleanup()
  await deps.autostart()
}
