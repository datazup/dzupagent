/**
 * VFS snapshot persistence — save/restore virtual filesystem state.
 * Uses a SnapshotStore interface (consumer implements, e.g., Prisma adapter).
 */

/** Abstract snapshot storage — implemented by consumers */
export interface SnapshotStore {
  save(id: string, phase: string, data: Record<string, string>): Promise<void>
  load(id: string, phase: string): Promise<Record<string, string> | null>
}

/** Result of a snapshot save operation */
export interface SnapshotSaveResult {
  success: boolean
  id?: string
  phase?: string
  error?: string
}

/** Result of a snapshot load operation */
export type SnapshotLoadResult =
  | { success: true; data: Record<string, string> }
  | { success: false; error?: string }

/**
 * Save a VFS snapshot for recovery purposes.
 * Non-fatal — returns a typed result instead of throwing.
 */
export async function saveSnapshot(
  store: SnapshotStore,
  id: string,
  phase: string,
  vfs: Record<string, string>,
): Promise<SnapshotSaveResult> {
  try {
    await store.save(id, phase, vfs)
    return { success: true, id, phase }
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Load a VFS snapshot from storage.
 * Returns a typed result indicating success/failure and reason.
 */
export async function loadSnapshot(
  store: SnapshotStore,
  id: string,
  phase: string,
): Promise<SnapshotLoadResult> {
  try {
    const data = await store.load(id, phase)
    if (data === null) {
      return { success: false, error: 'not_found' }
    }
    return { success: true, data }
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
