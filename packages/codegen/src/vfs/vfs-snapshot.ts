/**
 * VFS snapshot persistence — save/restore virtual filesystem state.
 * Uses a SnapshotStore interface (consumer implements, e.g., Prisma adapter).
 */

/** Abstract snapshot storage — implemented by consumers */
export interface SnapshotStore {
  save(id: string, phase: string, data: Record<string, string>): Promise<void>
  load(id: string, phase: string): Promise<Record<string, string> | null>
}

/**
 * Save a VFS snapshot for recovery purposes.
 * Non-fatal — errors are caught and logged.
 */
export async function saveSnapshot(
  store: SnapshotStore,
  id: string,
  phase: string,
  vfs: Record<string, string>,
): Promise<void> {
  try {
    await store.save(id, phase, vfs)
  } catch {
    // Non-fatal — snapshot save failure should not break the pipeline
  }
}

/**
 * Load a VFS snapshot from storage.
 * Returns null if not found or on error.
 */
export async function loadSnapshot(
  store: SnapshotStore,
  id: string,
  phase: string,
): Promise<Record<string, string> | null> {
  try {
    return await store.load(id, phase)
  } catch {
    return null
  }
}
