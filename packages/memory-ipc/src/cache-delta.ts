/**
 * Prompt cache delta detection.
 *
 * Compares a frozen MemoryFrame snapshot with the current state to determine
 * whether the prompt cache should be invalidated (refrozen). Uses FNV-1a
 * content hashing for efficient modification detection.
 */

import { type Table } from 'apache-arrow'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of comparing frozen vs current memory frames. */
export interface FrameDelta {
  /** Number of records in current but not in frozen. */
  added: number
  /** Number of records in frozen but not in current. */
  removed: number
  /** Number of records present in both but with changed content. */
  modified: number
  /** Total rows in frozen frame. */
  frozenTotal: number
  /** Total rows in current frame. */
  currentTotal: number
  /** Ratio of changes to frozen total (0..1+). */
  changeRatio: number
  /** Whether changes exceed the refreeze threshold. */
  shouldRefreeze: boolean
}

// ---------------------------------------------------------------------------
// FNV-1a hash
// ---------------------------------------------------------------------------

/**
 * FNV-1a 32-bit hash of a string.
 * Fast, non-cryptographic hash suitable for content change detection.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = (hash * 0x01000193) | 0
  }
  return hash >>> 0
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readStr(
  table: Table,
  columnName: string,
  row: number,
): string | null {
  const col = table.getChild(columnName)
  if (!col) return null
  const raw: unknown = col.get(row)
  if (raw === null || raw === undefined) return null
  return String(raw)
}

/**
 * Build a map from record ID to { rowIndex, contentHash }.
 */
function buildIdHashMap(table: Table): Map<string, { rowIndex: number; hash: number }> {
  const map = new Map<string, { rowIndex: number; hash: number }>()
  const idCol = table.getChild('id')
  if (!idCol) return map

  for (let i = 0; i < table.numRows; i++) {
    const id: unknown = idCol.get(i)
    if (id === null || id === undefined) continue

    const idStr = String(id)
    const text = readStr(table, 'text', i) ?? ''
    const payload = readStr(table, 'payload_json', i) ?? ''
    const hash = fnv1a(text + payload)

    map.set(idStr, { rowIndex: i, hash })
  }

  return map
}

// ---------------------------------------------------------------------------
// computeFrameDelta
// ---------------------------------------------------------------------------

/**
 * Compare frozen MemoryFrame with current state.
 *
 * Uses ID set difference for added/removed detection, and FNV-1a content
 * hashing for modification detection. This avoids expensive deep comparison
 * of text content.
 *
 * @param frozen    The cached/frozen Arrow Table snapshot
 * @param current   The current Arrow Table state
 * @param refreezeThreshold  Change ratio above which shouldRefreeze is true (default 0.1)
 * @returns FrameDelta describing the differences
 */
export function computeFrameDelta(
  frozen: Table,
  current: Table,
  refreezeThreshold = 0.1,
): FrameDelta {
  try {
    const frozenMap = buildIdHashMap(frozen)
    const currentMap = buildIdHashMap(current)

    const frozenTotal = frozen.numRows
    const currentTotal = current.numRows

    // Handle both-empty case
    if (frozenTotal === 0 && currentTotal === 0) {
      return {
        added: 0,
        removed: 0,
        modified: 0,
        frozenTotal: 0,
        currentTotal: 0,
        changeRatio: 0,
        shouldRefreeze: false,
      }
    }

    // Count added: IDs in current but not in frozen
    let added = 0
    for (const id of currentMap.keys()) {
      if (!frozenMap.has(id)) {
        added++
      }
    }

    // Count removed: IDs in frozen but not in current
    let removed = 0
    for (const id of frozenMap.keys()) {
      if (!currentMap.has(id)) {
        removed++
      }
    }

    // Count modified: shared IDs with different content hashes
    let modified = 0
    for (const [id, frozenEntry] of frozenMap) {
      const currentEntry = currentMap.get(id)
      if (currentEntry && currentEntry.hash !== frozenEntry.hash) {
        modified++
      }
    }

    const totalChanges = added + removed + modified
    // Use max of frozen/current total as denominator to handle growth
    const denominator = Math.max(frozenTotal, currentTotal, 1)
    const changeRatio = totalChanges / denominator
    const shouldRefreeze = changeRatio > refreezeThreshold

    return {
      added,
      removed,
      modified,
      frozenTotal,
      currentTotal,
      changeRatio,
      shouldRefreeze,
    }
  } catch {
    // On error, signal refreeze to be safe
    return {
      added: 0,
      removed: 0,
      modified: 0,
      frozenTotal: frozen.numRows,
      currentTotal: current.numRows,
      changeRatio: 0,
      shouldRefreeze: true,
    }
  }
}
