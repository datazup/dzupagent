/**
 * WorkspaceFS — unified filesystem abstraction for code generation.
 *
 * Provides a common interface for in-memory (VirtualFS), disk-backed,
 * and git-worktree-backed file operations, including unified-diff patch
 * application via the patch engine.
 */
import { readFile, writeFile, unlink, readdir, mkdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { VirtualFS } from './virtual-fs.js'
import { parseUnifiedDiff, applyPatchSet } from './patch-engine.js'
import type { PatchApplyResult, ApplyPatchSetOptions } from './patch-engine.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PatchOptions extends ApplyPatchSetOptions {
  /** When true, individual file failures do not abort the set. Default: true. */
  bestEffort?: boolean
}

export interface WorkspacePatchResult {
  results: PatchApplyResult[]
  rolledBack: boolean
}

/**
 * Unified filesystem abstraction for code-generation workflows.
 *
 * Implementations:
 * - `InMemoryWorkspaceFS` — wraps VirtualFS
 * - `DiskWorkspaceFS` — disk-backed, constrained to a root directory
 * - `GitWorktreeWorkspaceFS` — wraps GitWorktreeManager for isolated branches
 */
export interface WorkspaceFS {
  read(path: string): Promise<string | null>
  write(path: string, content: string): Promise<void>
  delete(path: string): Promise<boolean>
  list(prefix?: string): Promise<string[]>
  snapshot(): Promise<Record<string, string>>
  applyPatch(patch: string, opts?: PatchOptions): Promise<WorkspacePatchResult>
}

// ---------------------------------------------------------------------------
// InMemoryWorkspaceFS
// ---------------------------------------------------------------------------

/**
 * In-memory workspace backed by VirtualFS.
 * All operations are synchronous under the hood but wrapped in async
 * for interface conformance.
 */
export class InMemoryWorkspaceFS implements WorkspaceFS {
  constructor(private readonly vfs: VirtualFS) {}

  async read(path: string): Promise<string | null> {
    return this.vfs.read(path)
  }

  async write(path: string, content: string): Promise<void> {
    this.vfs.write(path, content)
  }

  async delete(path: string): Promise<boolean> {
    return this.vfs.delete(path)
  }

  async list(prefix?: string): Promise<string[]> {
    return this.vfs.list(prefix)
  }

  async snapshot(): Promise<Record<string, string>> {
    return this.vfs.toSnapshot()
  }

  async applyPatch(patch: string, opts?: PatchOptions): Promise<WorkspacePatchResult> {
    const parsed = parseUnifiedDiff(patch)
    const readFn = (p: string): Promise<string | null> => Promise.resolve(this.vfs.read(p))
    const writeFn = (p: string, c: string): Promise<void> => {
      this.vfs.write(p, c)
      return Promise.resolve()
    }
    const patchOpts: ApplyPatchSetOptions = {}
    if (opts?.rollbackOnFailure !== undefined) patchOpts.rollbackOnFailure = opts.rollbackOnFailure
    const result = await applyPatchSet(parsed, readFn, writeFn, patchOpts)
    return result
  }
}

// ---------------------------------------------------------------------------
// DiskWorkspaceFS
// ---------------------------------------------------------------------------

/**
 * Disk-backed workspace constrained to a root directory.
 * All paths are resolved relative to `rootDir` and validated to prevent
 * path-traversal escapes.
 */
export class DiskWorkspaceFS implements WorkspaceFS {
  private readonly rootDir: string

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir)
  }

  private resolveSafe(path: string): string {
    const resolved = resolve(this.rootDir, path)
    if (!resolved.startsWith(this.rootDir + sep) && resolved !== this.rootDir) {
      throw new Error(`Path traversal detected: "${path}" escapes root "${this.rootDir}"`)
    }
    return resolved
  }

  async read(path: string): Promise<string | null> {
    try {
      return await readFile(this.resolveSafe(path), 'utf-8')
    } catch {
      return null
    }
  }

  async write(path: string, content: string): Promise<void> {
    const fullPath = this.resolveSafe(path)
    const dir = fullPath.slice(0, fullPath.lastIndexOf(sep))
    await mkdir(dir, { recursive: true })
    await writeFile(fullPath, content, 'utf-8')
  }

  async delete(path: string): Promise<boolean> {
    try {
      await unlink(this.resolveSafe(path))
      return true
    } catch {
      return false
    }
  }

  async list(prefix?: string): Promise<string[]> {
    const startDir = prefix ? this.resolveSafe(prefix) : this.rootDir
    return this.walkDir(startDir)
  }

  async snapshot(): Promise<Record<string, string>> {
    const files = await this.list()
    const result: Record<string, string> = {}
    for (const filePath of files) {
      const content = await this.read(filePath)
      if (content !== null) {
        result[filePath] = content
      }
    }
    return result
  }

  async applyPatch(patch: string, opts?: PatchOptions): Promise<WorkspacePatchResult> {
    const parsed = parseUnifiedDiff(patch)
    const readFn = (p: string): Promise<string | null> => this.read(p)
    const writeFn = (p: string, c: string): Promise<void> => this.write(p, c)
    const patchOpts: ApplyPatchSetOptions = {}
    if (opts?.rollbackOnFailure !== undefined) patchOpts.rollbackOnFailure = opts.rollbackOnFailure
    const result = await applyPatchSet(parsed, readFn, writeFn, patchOpts)
    return result
  }

  private async walkDir(dir: string): Promise<string[]> {
    const results: string[] = []
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          const sub = await this.walkDir(fullPath)
          results.push(...sub)
        } else if (entry.isFile()) {
          results.push(relative(this.rootDir, fullPath))
        }
      }
    } catch {
      // Directory does not exist or is not readable
    }
    return results.sort()
  }
}

// ---------------------------------------------------------------------------
// GitWorktreeWorkspaceFS
// ---------------------------------------------------------------------------

/**
 * Workspace backed by a git worktree directory.
 *
 * Delegates to a `DiskWorkspaceFS` rooted at the worktree path.
 * The worktree must be created externally via `GitWorktreeManager.create()`.
 */
export class GitWorktreeWorkspaceFS implements WorkspaceFS {
  private readonly disk: DiskWorkspaceFS

  /**
   * @param worktreeDir - Absolute path to the git worktree directory.
   */
  constructor(worktreeDir: string) {
    this.disk = new DiskWorkspaceFS(worktreeDir)
  }

  read(path: string): Promise<string | null> {
    return this.disk.read(path)
  }

  write(path: string, content: string): Promise<void> {
    return this.disk.write(path, content)
  }

  delete(path: string): Promise<boolean> {
    return this.disk.delete(path)
  }

  list(prefix?: string): Promise<string[]> {
    return this.disk.list(prefix)
  }

  snapshot(): Promise<Record<string, string>> {
    return this.disk.snapshot()
  }

  applyPatch(patch: string, opts?: PatchOptions): Promise<WorkspacePatchResult> {
    return this.disk.applyPatch(patch, opts)
  }
}
