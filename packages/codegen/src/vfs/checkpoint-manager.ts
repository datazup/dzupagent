/**
 * Filesystem checkpoint manager using shadow git repositories.
 *
 * Creates transparent snapshots of working directories before file-mutating
 * operations, enabling rollback without exposing git internals to the user's
 * project. Inspired by Hermes Agent's checkpoint_manager.py.
 *
 * Shadow repos live at `{baseDir}/{hash(absPath)}/` with GIT_DIR/GIT_WORK_TREE
 * isolation so no git state leaks into the working directory.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckpointManagerConfig {
  /** Base directory for shadow repos (default ~/.dzipagent/checkpoints) */
  baseDir?: string
  /** Maximum number of snapshots to keep per directory (default 50) */
  maxSnapshots?: number
  /** Git command timeout in milliseconds (default 30_000) */
  timeoutMs?: number
  /** Maximum files in a directory before skipping (default 50_000) */
  maxFiles?: number
}

export interface CheckpointEntry {
  hash: string
  timestamp: string
  reason: string
  summary: string
}

export interface CheckpointDiff {
  added: string[]
  modified: string[]
  deleted: string[]
  stats: { filesChanged: number; insertions: number; deletions: number }
}

// ---------------------------------------------------------------------------
// Defaults & constants
// ---------------------------------------------------------------------------

const DEFAULTS = {
  baseDir: join(process.env['HOME'] ?? '/tmp', '.dzipagent', 'checkpoints'),
  maxSnapshots: 50,
  timeoutMs: 30_000,
  maxFiles: 50_000,
}

/** Directories and patterns to exclude from snapshots */
const EXCLUDES = [
  'node_modules',
  '.git',
  '.env',
  '.env.*',
  '__pycache__',
  '.next',
  '.nuxt',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.cache',
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shadowDirName(workDir: string): string {
  return createHash('sha256').update(resolve(workDir)).digest('hex').slice(0, 16)
}

function buildExcludeArgs(): string[] {
  const args: string[] = []
  for (const pattern of EXCLUDES) {
    args.push('--exclude', pattern)
  }
  return args
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class CheckpointManager {
  private readonly baseDir: string
  private readonly maxSnapshots: number
  private readonly timeoutMs: number
  private readonly maxFiles: number

  /** Tracks which directories have been snapshotted this turn (dedup) */
  private turnSnapshots = new Set<string>()

  constructor(config?: CheckpointManagerConfig) {
    this.baseDir = config?.baseDir ?? DEFAULTS.baseDir
    this.maxSnapshots = config?.maxSnapshots ?? DEFAULTS.maxSnapshots
    this.timeoutMs = config?.timeoutMs ?? DEFAULTS.timeoutMs
    this.maxFiles = config?.maxFiles ?? DEFAULTS.maxFiles
  }

  /**
   * Reset per-turn deduplication. Call this at the start of each agent turn
   * so that a new snapshot can be taken for each directory.
   */
  newTurn(): void {
    this.turnSnapshots.clear()
  }

  /**
   * Ensure a checkpoint exists for this directory in the current turn.
   * No-op if already snapshotted this turn. Safe to call before every
   * file-mutating operation — at most one snapshot per dir per turn.
   *
   * Non-fatal: never throws. Returns the commit hash on success, null on failure.
   */
  async ensureCheckpoint(workDir: string, reason: string): Promise<string | null> {
    const absDir = resolve(workDir)

    // Per-turn dedup
    if (this.turnSnapshots.has(absDir)) return null

    // Safety: skip dangerous directories
    if (absDir === '/' || absDir === (process.env['HOME'] ?? '')) return null

    // Check directory exists and isn't too large
    try {
      const entries = await readdir(absDir)
      if (entries.length > this.maxFiles) return null
    } catch {
      return null
    }

    this.turnSnapshots.add(absDir)

    try {
      const shadowDir = await this.getShadowDir(absDir)
      await this.initShadowRepo(shadowDir, absDir)

      const hash = await this.createSnapshot(shadowDir, absDir, reason)
      if (hash) {
        await this.pruneOldSnapshots(shadowDir, absDir)
      }
      return hash
    } catch {
      return null
    }
  }

  /**
   * List checkpoints for a directory, most recent first.
   */
  async list(workDir: string): Promise<CheckpointEntry[]> {
    const absDir = resolve(workDir)
    const shadowDir = await this.getShadowDir(absDir)

    try {
      const { stdout } = await this.git(
        shadowDir, absDir,
        ['log', '--format=%H|%aI|%s', '--max-count', String(this.maxSnapshots)],
      )

      return stdout.trim().split('\n').filter(Boolean).map(line => {
        const parts = line.split('|')
        const hash = parts[0] ?? ''
        const timestamp = parts[1] ?? ''
        const reason = parts.slice(2).join('|')
        return { hash, timestamp, reason, summary: '' }
      })
    } catch {
      return []
    }
  }

  /**
   * Show diff between a checkpoint and the current working directory state.
   */
  async diff(workDir: string, checkpointHash: string): Promise<CheckpointDiff | null> {
    const absDir = resolve(workDir)
    const shadowDir = await this.getShadowDir(absDir)

    try {
      // Stage current state to compare
      await this.git(shadowDir, absDir, ['add', '-A', ...buildExcludeArgs()])

      const { stdout } = await this.git(
        shadowDir, absDir,
        ['diff', '--name-status', checkpointHash, 'HEAD'],
      )

      const added: string[] = []
      const modified: string[] = []
      const deleted: string[] = []

      for (const line of stdout.trim().split('\n').filter(Boolean)) {
        const status = line[0]
        const file = line.slice(1).trim()
        if (!file) continue
        if (status === 'A') added.push(file)
        else if (status === 'M') modified.push(file)
        else if (status === 'D') deleted.push(file)
      }

      // Get diffstat
      const { stdout: statOut } = await this.git(
        shadowDir, absDir,
        ['diff', '--shortstat', checkpointHash, 'HEAD'],
      )

      const insertMatch = /(\d+) insertion/.exec(statOut)
      const deleteMatch = /(\d+) deletion/.exec(statOut)

      return {
        added,
        modified,
        deleted,
        stats: {
          filesChanged: added.length + modified.length + deleted.length,
          insertions: insertMatch ? Number(insertMatch[1]) : 0,
          deletions: deleteMatch ? Number(deleteMatch[1]) : 0,
        },
      }
    } catch {
      return null
    }
  }

  /**
   * Restore a directory to a checkpoint state.
   * Creates a pre-rollback snapshot first for safety.
   */
  async restore(workDir: string, checkpointHash: string): Promise<boolean> {
    const absDir = resolve(workDir)
    const shadowDir = await this.getShadowDir(absDir)

    try {
      // Safety: snapshot current state before rollback
      await this.createSnapshot(shadowDir, absDir, `pre-rollback to ${checkpointHash.slice(0, 8)}`)

      // Restore files from checkpoint
      await this.git(shadowDir, absDir, ['checkout', checkpointHash, '--', '.'])
      return true
    } catch {
      return false
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async getShadowDir(absDir: string): Promise<string> {
    const dirName = shadowDirName(absDir)
    const shadowDir = join(this.baseDir, dirName)
    await mkdir(shadowDir, { recursive: true })
    return shadowDir
  }

  private async initShadowRepo(shadowDir: string, workDir: string): Promise<void> {
    try {
      await this.git(shadowDir, workDir, ['rev-parse', '--git-dir'])
    } catch {
      // Not initialized yet
      await this.git(shadowDir, workDir, ['init'])

      // Configure for checkpoint use
      await this.git(shadowDir, workDir, ['config', 'user.email', 'checkpoint@dzipagent'])
      await this.git(shadowDir, workDir, ['config', 'user.name', 'DzipAgent Checkpoint'])
    }
  }

  private async createSnapshot(
    shadowDir: string,
    workDir: string,
    reason: string,
  ): Promise<string | null> {
    // Stage all files (respecting excludes)
    await this.git(shadowDir, workDir, ['add', '-A', ...buildExcludeArgs()])

    // Check if there are changes to commit
    try {
      await this.git(shadowDir, workDir, ['diff', '--cached', '--quiet'])
      // No changes — nothing to snapshot
      return null
    } catch {
      // diff --quiet exits non-zero when there ARE changes — expected
    }

    await this.git(shadowDir, workDir, ['commit', '-m', reason, '--allow-empty-message'])

    const { stdout } = await this.git(shadowDir, workDir, ['rev-parse', 'HEAD'])
    return stdout.trim()
  }

  private async pruneOldSnapshots(shadowDir: string, workDir: string): Promise<void> {
    try {
      const { stdout } = await this.git(shadowDir, workDir, ['rev-list', '--count', 'HEAD'])
      const count = Number(stdout.trim())

      if (count > this.maxSnapshots) {
        // Keep only the last N commits via a shallow operation
        // We use reflog expire + gc to remove old objects
        const keepFrom = `HEAD~${this.maxSnapshots}`
        await this.git(shadowDir, workDir, [
          'rebase', '--onto', keepFrom, keepFrom, 'HEAD',
        ]).catch(() => {
          // Prune failure is non-fatal
        })
      }
    } catch {
      // Prune failure is non-fatal
    }
  }

  private async git(
    shadowDir: string,
    workDir: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    const result = await execFileAsync('git', args, {
      cwd: workDir,
      timeout: this.timeoutMs,
      env: {
        ...process.env,
        GIT_DIR: shadowDir,
        GIT_WORK_TREE: workDir,
      },
    })
    return { stdout: result.stdout, stderr: result.stderr }
  }
}
