/**
 * Shared types for VFS copy-on-write and parallel sampling.
 */

import type { FileDiff } from './virtual-fs.js'

// VFS file conflict merge strategy
/** Merge strategy when conflicts exist between parent and child */
export type MergeStrategy = 'ours' | 'theirs' | 'manual'

/** A conflict detected during merge */
export interface MergeConflict {
  /** File path with conflicting content */
  path: string
  /** Content in the parent VFS */
  parentContent: string
  /** Content in the child (fork) VFS */
  childContent: string
  /** Content at the time the fork was created */
  baseContent: string
}

/** Result of a merge operation */
export interface MergeResult {
  /** Whether the merge completed without unresolved conflicts */
  clean: boolean
  /** Files that were successfully merged */
  merged: string[]
  /** Conflicts (only populated when strategy is 'manual') */
  conflicts: MergeConflict[]
}

/** Diff between a forked VFS and its parent */
export interface VFSDiff {
  /** Files added in the fork (not present in parent) */
  added: FileDiff[]
  /** Files modified in the fork (different content from parent) */
  modified: FileDiff[]
  /** Files deleted in the fork (present in parent, deleted in fork) */
  deleted: FileDiff[]
}

/**
 * Result of a parallel sampling run.
 *
 * Discriminated by `ok` so callers cannot accidentally read `result` from a
 * failed sample. Narrow with `if (r.ok)` (success) or `if (!r.ok)` (failure)
 * before accessing `result` or `error` respectively.
 */
export type SampleResult<T> =
  | {
      /** Discriminator: the sample succeeded */
      ok: true
      /** The CoW fork used for this sample */
      forkIndex: number
      /** Index of this sample (0-based) */
      index: number
      /** Duration of the sampling function in milliseconds */
      durationMs: number
      /** The result produced by the sampling function */
      result: T
    }
  | {
      /** Discriminator: the sample failed */
      ok: false
      /** The CoW fork used for this sample */
      forkIndex: number
      /** Index of this sample (0-based) */
      index: number
      /** Duration of the sampling function in milliseconds */
      durationMs: number
      /** Error message captured from the thrown value */
      error: string
    }
