/**
 * MerkleDigest — efficient state comparison using hash trees.
 *
 * Computes SHA-256-based root hashes and version maps from SharedEntry arrays,
 * enabling nodes to quickly determine whether their state diverges and
 * compute minimal deltas for synchronization.
 */

import { createHash } from 'node:crypto'

import type { HLC } from '../crdt/hlc.js'
import type { SharedEntry } from '../shared-namespace.js'
import type { SharedMemoryNamespace } from '../shared-namespace.js'
import type { SyncDigest } from './types.js'

export class MerkleDigest {
  /**
   * Compute a root hash from entries.
   *
   * Sorts entries by key, hashes each entry's (key, version, updatedAt),
   * then produces a single SHA-256 root hash over all leaf hashes.
   *
   * Returns the hex-encoded SHA-256 digest. For zero entries, returns
   * the hash of an empty string.
   */
  static computeRootHash(entries: SharedEntry[]): string {
    const sorted = [...entries].sort((a, b) => a.key.localeCompare(b.key))

    const hasher = createHash('sha256')
    for (const entry of sorted) {
      const leaf = createHash('sha256')
        .update(`${entry.key}:${String(entry.version)}:${String(entry.updatedAt)}`)
        .digest('hex')
      hasher.update(leaf)
    }

    return hasher.digest('hex')
  }

  /**
   * Build a version map from entries (key -> version).
   */
  static buildVersionMap(entries: SharedEntry[]): Record<string, number> {
    const map: Record<string, number> = {}
    for (const entry of entries) {
      map[entry.key] = entry.version
    }
    return map
  }

  /**
   * Compute a SyncDigest for a SharedMemoryNamespace.
   */
  static fromNamespace(
    nodeId: string,
    namespace: SharedMemoryNamespace,
    hlc: HLC,
  ): SyncDigest {
    const entries = namespace.list()
    return {
      nodeId,
      rootHash: MerkleDigest.computeRootHash(entries),
      entryCount: entries.length,
      latestTimestamp: hlc.now(),
      versionMap: MerkleDigest.buildVersionMap(entries),
    }
  }

  /**
   * Find entries that differ between local entries and a remote version map.
   *
   * Returns local entries whose version is greater than the remote version
   * for the same key, or entries that the remote does not have at all.
   */
  static findDelta(
    localEntries: SharedEntry[],
    remoteVersionMap: Record<string, number>,
  ): SharedEntry[] {
    const delta: SharedEntry[] = []
    for (const entry of localEntries) {
      const remoteVersion = remoteVersionMap[entry.key]
      if (remoteVersion === undefined || entry.version > remoteVersion) {
        delta.push(entry)
      }
    }
    return delta
  }
}
