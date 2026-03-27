/**
 * Copy-on-Write VirtualFS — memory-efficient forking for parallel execution.
 *
 * A CopyOnWriteVFS wraps a parent VirtualFS (or another CopyOnWriteVFS) and
 * intercepts writes to a local overlay Map. Reads fall through to the parent
 * for files not modified in the fork. Deleted files are tracked in a separate
 * Set that masks parent reads.
 *
 * This enables cheap forking for parallel sampling, speculative edits, and
 * fix-escalation workflows where you want to try something in isolation
 * before merging back.
 */

import { VirtualFS } from './virtual-fs.js'
import type { FileDiff } from './virtual-fs.js'
import type { MergeStrategy, MergeConflict, MergeResult, VFSDiff } from './vfs-types.js'

/** Maximum fork depth to prevent runaway nesting */
const MAX_FORK_DEPTH = 3

/**
 * Copy-on-Write VFS that wraps a parent VirtualFS.
 *
 * Writes go to a local overlay. Reads fall through to the parent for
 * unmodified files. Deletes are tracked to mask parent reads.
 *
 * Memory-efficient: only changed/added files are stored in the child.
 */
export class CopyOnWriteVFS {
  /** Local overlay for files written in this fork */
  private readonly overlay: Map<string, string> = new Map()

  /** Paths deleted in this fork (masks parent reads) */
  private readonly deletedPaths: Set<string> = new Set()

  /** Snapshot of parent file contents at fork time (lazy, for conflict detection) */
  private readonly baseSnapshot: Map<string, string> = new Map()

  /** Human-readable label for debugging */
  readonly label: string

  /** The parent VFS (VirtualFS or another CopyOnWriteVFS) */
  private readonly _parent: VirtualFS | CopyOnWriteVFS

  /** Nesting depth (root = 0, first fork = 1, etc.) */
  private readonly _depth: number

  constructor(
    parent: VirtualFS | CopyOnWriteVFS,
    label?: string,
  ) {
    this._parent = parent
    this.label = label ?? `fork-${Date.now()}`

    // Calculate depth
    if (parent instanceof CopyOnWriteVFS) {
      this._depth = parent.depth + 1
    } else {
      this._depth = 1
    }

    if (this._depth > MAX_FORK_DEPTH) {
      throw new Error(
        `Fork depth ${this._depth} exceeds maximum of ${MAX_FORK_DEPTH}. ` +
        `Detach or merge intermediate forks before creating new ones.`,
      )
    }

    // Snapshot parent file contents at fork time for conflict detection.
    // We only snapshot content hashes lazily — actual content is captured on
    // first conflict check. For now, capture paths that exist.
    this.captureBaseSnapshot()
  }

  /** Nesting depth (root VirtualFS = 0, first fork = 1) */
  get depth(): number {
    return this._depth
  }

  /** The parent VFS. Null-like check: always non-null for CopyOnWriteVFS. */
  get parent(): VirtualFS | CopyOnWriteVFS {
    return this._parent
  }

  /**
   * Write a file to this fork's overlay.
   * Does not affect the parent.
   */
  write(path: string, content: string): void {
    this.overlay.set(path, content)
    this.deletedPaths.delete(path)
  }

  /**
   * Read a file. Checks overlay first, then falls through to parent.
   * Returns null if file is deleted in this fork or does not exist.
   */
  read(path: string): string | null {
    // Deleted in this fork — masked
    if (this.deletedPaths.has(path)) {
      return null
    }
    // Written in this fork — return overlay
    if (this.overlay.has(path)) {
      return this.overlay.get(path) ?? null
    }
    // Fall through to parent
    if (this._parent instanceof CopyOnWriteVFS) {
      return this._parent.read(path)
    }
    return this._parent.read(path)
  }

  /**
   * Check if a file exists in this fork or its parent chain.
   */
  exists(path: string): boolean {
    if (this.deletedPaths.has(path)) return false
    if (this.overlay.has(path)) return true
    if (this._parent instanceof CopyOnWriteVFS) {
      return this._parent.exists(path)
    }
    return this._parent.exists(path)
  }

  /**
   * Delete a file in this fork. Adds to the delete set to mask parent reads.
   * Returns true if the file existed (in overlay or parent).
   */
  delete(path: string): boolean {
    const existed = this.exists(path)
    this.overlay.delete(path)
    if (existed) {
      this.deletedPaths.add(path)
    }
    return existed
  }

  /**
   * List all file paths visible in this fork.
   * Merges parent paths with overlay paths, minus deleted paths.
   */
  list(directory?: string): string[] {
    // Get parent paths
    let parentPaths: string[]
    if (this._parent instanceof CopyOnWriteVFS) {
      parentPaths = this._parent.list()
    } else {
      parentPaths = this._parent.list()
    }

    // Merge with overlay, subtract deletes
    const allPaths = new Set(parentPaths)
    for (const path of this.overlay.keys()) {
      allPaths.add(path)
    }
    for (const path of this.deletedPaths) {
      allPaths.delete(path)
    }

    let paths = [...allPaths].sort()
    if (directory) {
      const prefix = directory.endsWith('/') ? directory : `${directory}/`
      paths = paths.filter(p => p.startsWith(prefix))
    }
    return paths
  }

  /** Number of files visible in this fork */
  get size(): number {
    return this.list().length
  }

  /**
   * Get files modified in this fork (written to overlay).
   */
  getModifiedFiles(): string[] {
    return [...this.overlay.keys()]
  }

  /**
   * Get files deleted in this fork.
   */
  getDeletedFiles(): string[] {
    return [...this.deletedPaths]
  }

  /**
   * Compute a structured diff between this fork and its parent.
   */
  diff(): VFSDiff {
    const added: FileDiff[] = []
    const modified: FileDiff[] = []
    const deleted: FileDiff[] = []

    // Check overlay files against parent
    for (const [path, content] of this.overlay) {
      const parentContent = this.readFromParent(path)
      if (parentContent === null) {
        added.push({ path, type: 'added', newContent: content })
      } else if (parentContent !== content) {
        modified.push({ path, type: 'modified', oldContent: parentContent, newContent: content })
      }
      // If content is identical to parent, it was written but unchanged — skip
    }

    // Check deleted files
    for (const path of this.deletedPaths) {
      const parentContent = this.readFromParent(path)
      if (parentContent !== null) {
        deleted.push({ path, type: 'deleted', oldContent: parentContent })
      }
    }

    return { added, modified, deleted }
  }

  /**
   * Compute the fork delta as FileDiff[] (flat list).
   */
  forkDelta(): FileDiff[] {
    const { added, modified, deleted } = this.diff()
    return [...added, ...modified, ...deleted]
  }

  /**
   * Detect conflicts between this fork and another fork sharing the same parent.
   * A conflict exists when both forks modified the same file differently.
   */
  conflicts(other: CopyOnWriteVFS): MergeConflict[] {
    const result: MergeConflict[] = []

    // Files modified in both forks
    const ourModified = new Set(this.overlay.keys())

    for (const path of other.overlay.keys()) {
      if (!ourModified.has(path)) continue

      const ourContent = this.overlay.get(path) ?? ''
      const theirContent = other.overlay.get(path) ?? ''

      // Only a conflict if content differs
      if (ourContent !== theirContent) {
        const baseContent = this.baseSnapshot.get(path) ?? ''
        result.push({
          path,
          parentContent: ourContent,
          childContent: theirContent,
          baseContent,
        })
      }
    }

    // Check delete vs modify conflicts
    for (const path of this.deletedPaths) {
      if (other.overlay.has(path)) {
        const baseContent = this.baseSnapshot.get(path) ?? ''
        result.push({
          path,
          parentContent: '', // deleted in this fork
          childContent: other.overlay.get(path) ?? '',
          baseContent,
        })
      }
    }

    for (const path of other.getDeletedFiles()) {
      if (this.overlay.has(path)) {
        const baseContent = this.baseSnapshot.get(path) ?? ''
        result.push({
          path,
          parentContent: this.overlay.get(path) ?? '',
          childContent: '', // deleted in other fork
          baseContent,
        })
      }
    }

    return result
  }

  /**
   * Merge this fork's changes back into the parent.
   *
   * @param strategy - How to handle conflicts:
   *   - 'ours': parent content wins on conflict
   *   - 'theirs': fork (child) content wins on conflict
   *   - 'manual': return conflicts without resolving them
   */
  merge(strategy: MergeStrategy = 'theirs'): MergeResult {
    const merged: string[] = []
    const conflictList: MergeConflict[] = []

    // Apply overlay writes to parent
    for (const [path, content] of this.overlay) {
      const parentContent = this.readFromParent(path)

      // Check if parent changed since fork
      const baseContent = this.baseSnapshot.get(path) ?? null
      const parentChanged = parentContent !== null && baseContent !== null && parentContent !== baseContent

      if (parentChanged && parentContent !== content) {
        // Conflict: parent changed and fork changed differently
        const conflict: MergeConflict = {
          path,
          parentContent: parentContent ?? '',
          childContent: content,
          baseContent: baseContent ?? '',
        }

        if (strategy === 'manual') {
          conflictList.push(conflict)
          continue
        } else if (strategy === 'ours') {
          // Parent wins — skip this file
          merged.push(path)
          continue
        }
        // 'theirs' falls through — fork content wins
      }

      // Apply fork content to parent
      this.writeToParent(path, content)
      merged.push(path)
    }

    // Apply deletions to parent
    for (const path of this.deletedPaths) {
      const parentContent = this.readFromParent(path)
      if (parentContent !== null) {
        this.deleteFromParent(path)
        merged.push(path)
      }
    }

    return {
      clean: conflictList.length === 0,
      merged,
      conflicts: conflictList,
    }
  }

  /**
   * Create a child fork of this CoW VFS.
   * Enforces MAX_FORK_DEPTH.
   */
  fork(label?: string): CopyOnWriteVFS {
    return new CopyOnWriteVFS(this, label)
  }

  /**
   * Export as a plain Record<string, string> snapshot.
   * Materializes all files from the parent chain.
   */
  toSnapshot(): Record<string, string> {
    const snapshot: Record<string, string> = {}
    for (const path of this.list()) {
      const content = this.read(path)
      if (content !== null) {
        snapshot[path] = content
      }
    }
    return snapshot
  }

  /**
   * Detach this fork from its parent, materializing all inherited files.
   * After detach, the parent reference is effectively frozen — the overlay
   * becomes the complete file set. Returns a new standalone VirtualFS.
   */
  detach(): VirtualFS {
    return VirtualFS.fromSnapshot(this.toSnapshot())
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Read directly from parent, bypassing this fork's overlay and deletes */
  private readFromParent(path: string): string | null {
    if (this._parent instanceof CopyOnWriteVFS) {
      return this._parent.read(path)
    }
    return this._parent.read(path)
  }

  /** Write to parent VFS */
  private writeToParent(path: string, content: string): void {
    if (this._parent instanceof CopyOnWriteVFS) {
      this._parent.write(path, content)
    } else {
      this._parent.write(path, content)
    }
  }

  /** Delete from parent VFS */
  private deleteFromParent(path: string): void {
    if (this._parent instanceof CopyOnWriteVFS) {
      this._parent.delete(path)
    } else {
      this._parent.delete(path)
    }
  }

  /** Capture base snapshot of parent contents at fork time */
  private captureBaseSnapshot(): void {
    let parentPaths: string[]
    if (this._parent instanceof CopyOnWriteVFS) {
      parentPaths = this._parent.list()
    } else {
      parentPaths = this._parent.list()
    }

    for (const path of parentPaths) {
      const content = this.readFromParent(path)
      if (content !== null) {
        this.baseSnapshot.set(path, content)
      }
    }
  }
}
