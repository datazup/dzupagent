/**
 * RollbackStore -- persistence abstraction for apply_patch rollback entries.
 *
 * Every successful `apply_patch` invocation captures the pre-patch contents of
 * every file it touched so a reviewer can undo the change via `undoApplyPatch`.
 * Historically these entries lived in a process-local Map, which meant any
 * crash or restart silently lost undo capability.
 *
 * This module introduces a `RollbackStore` interface with two implementations:
 *
 *   - `InMemoryRollbackStore` -- the original process-local Map behaviour,
 *     preserved for tests and short-lived processes.
 *   - `FileRollbackStore` -- persists each entry as a JSON file under
 *     `.dzupagent/rollbacks/<token>.json`, so undo works across restarts.
 *
 * The stored entry keeps the list of captured originals (path + content, or
 * `null` when the file did not exist before). The live `WorkspaceFS`
 * reference is intentionally NOT serialised -- it must be rebound by the
 * caller when replaying an undo in a new process.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { WorkspaceFS } from '@dzupagent/codegen'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single rollback entry. `originals` maps a file path to its pre-patch
 * content, or `null` when the file did not exist prior to the patch.
 */
export interface RollbackEntry {
  workspace: WorkspaceFS
  originals: Map<string, string | null>
}

/**
 * Async key/value store for rollback entries keyed by rollback token.
 */
export interface RollbackStore {
  save(token: string, entry: RollbackEntry): Promise<void>
  load(token: string): Promise<RollbackEntry | undefined>
  delete(token: string): Promise<void>
  list(): Promise<string[]>
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

/**
 * Process-local rollback store backed by a Map. This matches the legacy
 * behaviour of the module-level `ROLLBACK_REGISTRY` in
 * `tools/apply-patch.tool.ts` and is suitable for tests and short-lived
 * agents that do not need cross-restart durability.
 */
export class InMemoryRollbackStore implements RollbackStore {
  private readonly entries = new Map<string, RollbackEntry>()

  async save(token: string, entry: RollbackEntry): Promise<void> {
    this.entries.set(token, entry)
  }

  async load(token: string): Promise<RollbackEntry | undefined> {
    return this.entries.get(token)
  }

  async delete(token: string): Promise<void> {
    this.entries.delete(token)
  }

  async list(): Promise<string[]> {
    return Array.from(this.entries.keys())
  }

  /** Test helper -- drop every entry. */
  clear(): void {
    this.entries.clear()
  }
}

// ---------------------------------------------------------------------------
// File-system implementation
// ---------------------------------------------------------------------------

/** Default directory used when no override is supplied. */
export const DEFAULT_ROLLBACK_STORAGE_DIR = '.dzupagent/rollbacks'

export interface FileRollbackStoreConfig {
  /**
   * Absolute or CWD-relative directory under which each token is persisted.
   * Defaults to `.dzupagent/rollbacks`.
   */
  storageDir?: string
  /** Whether to pretty-print JSON on disk. Default false. */
  prettyPrint?: boolean
}

/**
 * On-disk representation of a rollback entry. `workspace` is intentionally
 * omitted -- it is re-bound by the caller when loading into a live process.
 */
interface SerializedRollbackEntry {
  /** File path -> original content (null when the file did not exist). */
  originals: Array<[string, string | null]>
}

/**
 * File-backed rollback store.
 *
 * Entries are written as `<storageDir>/<token>.json`. Each load call must be
 * paired with a live `WorkspaceFS` -- the constructor accepts a `workspaceFor`
 * resolver so stored entries can be rehydrated against the correct workspace
 * (for multi-workspace agents you can key the lookup by reading the file
 * yourself and picking the workspace manually).
 *
 * For the common single-workspace case, pass the workspace to the
 * constructor and every `load()` will bind it automatically.
 */
export class FileRollbackStore implements RollbackStore {
  private readonly storageDir: string
  private readonly prettyPrint: boolean
  private readonly workspaceResolver: (token: string) => WorkspaceFS | undefined

  constructor(
    workspaceOrResolver:
      | WorkspaceFS
      | ((token: string) => WorkspaceFS | undefined),
    config: FileRollbackStoreConfig = {},
  ) {
    this.storageDir = config.storageDir ?? DEFAULT_ROLLBACK_STORAGE_DIR
    this.prettyPrint = config.prettyPrint ?? false
    this.workspaceResolver =
      typeof workspaceOrResolver === 'function'
        ? workspaceOrResolver
        : () => workspaceOrResolver
  }

  private filePath(token: string): string {
    return path.join(this.storageDir, `${token}.json`)
  }

  async save(token: string, entry: RollbackEntry): Promise<void> {
    await mkdir(this.storageDir, { recursive: true })
    const payload: SerializedRollbackEntry = {
      originals: Array.from(entry.originals.entries()),
    }
    const json = this.prettyPrint
      ? JSON.stringify(payload, null, 2)
      : JSON.stringify(payload)
    await writeFile(this.filePath(token), json, 'utf-8')
  }

  async load(token: string): Promise<RollbackEntry | undefined> {
    let raw: string
    try {
      raw = await readFile(this.filePath(token), 'utf-8')
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return undefined
      }
      throw err
    }

    const parsed = JSON.parse(raw) as SerializedRollbackEntry
    const workspace = this.workspaceResolver(token)
    if (!workspace) return undefined

    return {
      workspace,
      originals: new Map(parsed.originals),
    }
  }

  async delete(token: string): Promise<void> {
    try {
      await rm(this.filePath(token))
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return
      }
      throw err
    }
  }

  async list(): Promise<string[]> {
    let entries: string[]
    try {
      entries = await readdir(this.storageDir)
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return []
      }
      throw err
    }

    const tokens: string[] = []
    for (const entry of entries) {
      if (entry.endsWith('.json')) {
        tokens.push(entry.slice(0, -'.json'.length))
      }
    }
    return tokens
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

interface NodeError extends Error {
  code?: string
}

function isNodeError(err: unknown): err is NodeError {
  return err instanceof Error
}
