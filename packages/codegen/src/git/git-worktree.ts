/**
 * Git worktree manager — create isolated worktrees for parallel agent execution.
 *
 * Each worktree gets its own branch and working directory, enabling multiple
 * agents to work on the same repository concurrently without conflicts.
 *
 * Uses the same GitExecutor pattern — non-fatal by default.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)

export interface WorktreeInfo {
  /** Absolute path to the worktree directory */
  dir: string
  /** Branch name created for this worktree */
  branch: string
  /** Base branch the worktree was forked from */
  baseBranch: string
}

export interface WorktreeManagerConfig {
  /** Base repository directory */
  repoDir: string
  /** Directory to store worktrees (default: .forge-worktrees inside repoDir) */
  worktreeBaseDir?: string
  /** Timeout for git operations in ms (default: 30_000) */
  timeoutMs?: number
}

export class GitWorktreeManager {
  private readonly repoDir: string
  private readonly baseDir: string
  private readonly timeout: number

  constructor(config: WorktreeManagerConfig) {
    this.repoDir = config.repoDir
    this.baseDir = config.worktreeBaseDir ?? join(config.repoDir, '.forge-worktrees')
    this.timeout = config.timeoutMs ?? 30_000
  }

  /**
   * Create a new worktree with a dedicated branch.
   * The branch is created from the current HEAD of baseBranch.
   */
  async create(branchName: string, baseBranch?: string): Promise<WorktreeInfo> {
    const worktreeDir = join(this.baseDir, branchName)
    const base = baseBranch ?? 'HEAD'

    await this.exec(['worktree', 'add', '-b', branchName, worktreeDir, base])

    return {
      dir: worktreeDir,
      branch: branchName,
      baseBranch: base,
    }
  }

  /**
   * Remove a worktree and optionally delete its branch.
   */
  async remove(branchName: string, deleteBranch = true): Promise<void> {
    const worktreeDir = join(this.baseDir, branchName)
    await this.exec(['worktree', 'remove', worktreeDir, '--force'])

    if (deleteBranch) {
      try {
        await this.exec(['branch', '-D', branchName])
      } catch {
        // Branch might not exist or might be checked out elsewhere
      }
    }
  }

  /**
   * List all active worktrees.
   */
  async list(): Promise<Array<{ path: string; branch: string; head: string }>> {
    const { stdout } = await this.exec(['worktree', 'list', '--porcelain'])
    const entries: Array<{ path: string; branch: string; head: string }> = []
    let current: { path: string; branch: string; head: string } = { path: '', branch: '', head: '' }

    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path) entries.push(current)
        current = { path: line.slice(9), branch: '', head: '' }
      } else if (line.startsWith('HEAD ')) {
        current.head = line.slice(5)
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice(7).replace('refs/heads/', '')
      }
    }
    if (current.path) entries.push(current)

    return entries
  }

  /**
   * Merge a worktree's branch back into a target branch.
   * Returns the merge output for diagnostics.
   */
  async merge(
    worktreeBranch: string,
    targetBranch: string,
  ): Promise<{ success: boolean; output: string }> {
    try {
      // Save current branch
      const { stdout: currentBranch } = await this.exec(['branch', '--show-current'])

      // Switch to target, merge, switch back
      await this.exec(['checkout', targetBranch])
      const { stdout, stderr } = await this.exec(['merge', worktreeBranch, '--no-edit'])
      await this.exec(['checkout', currentBranch.trim()])

      const hasConflict = stderr.includes('CONFLICT') || stdout.includes('CONFLICT')
      return { success: !hasConflict, output: stdout + stderr }
    } catch (err) {
      return {
        success: false,
        output: err instanceof Error ? err.message : String(err),
      }
    }
  }

  private async exec(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: this.repoDir,
      timeout: this.timeout,
      maxBuffer: 10 * 1024 * 1024,
    })
    return { stdout, stderr }
  }
}
