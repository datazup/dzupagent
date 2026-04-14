/**
 * Git executor — low-level git command wrapper.
 *
 * Reuses the pattern from CheckpointManager but exposes user-facing
 * git operations. Non-fatal by default (returns results, not throws).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import type {
  GitExecutorConfig,
  GitStatusResult,
  GitDiffResult,
  GitLogEntry,
  GitCommitResult,
  GitFileEntry,
  GitFileStatus,
} from './git-types.js'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS = {
  timeoutMs: 30_000,
  maxBuffer: 10 * 1024 * 1024,
}

// ---------------------------------------------------------------------------
// Status code map
// ---------------------------------------------------------------------------

const STATUS_MAP: Record<string, GitFileStatus> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  '?': 'untracked',
  U: 'conflicted',
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export class GitExecutor {
  private readonly cwd: string
  private readonly timeoutMs: number
  private readonly maxBuffer: number

  constructor(config?: GitExecutorConfig) {
    this.cwd = resolve(config?.cwd ?? process.cwd())
    this.timeoutMs = config?.timeoutMs ?? DEFAULTS.timeoutMs
    this.maxBuffer = config?.maxBuffer ?? DEFAULTS.maxBuffer
  }

  /**
   * Check if the working directory is inside a git repository.
   */
  async isGitRepo(): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--is-inside-work-tree'])
      return true
    } catch {
      return false
    }
  }

  /**
   * Get the repository root directory.
   */
  async getRepoRoot(): Promise<string> {
    const { stdout } = await this.git(['rev-parse', '--show-toplevel'])
    return stdout.trim()
  }

  /**
   * Get current branch name.
   */
  async getCurrentBranch(): Promise<string> {
    try {
      const { stdout } = await this.git(['symbolic-ref', '--short', 'HEAD'])
      return stdout.trim()
    } catch {
      // Detached HEAD — return short hash
      const { stdout } = await this.git(['rev-parse', '--short', 'HEAD'])
      return `(detached ${stdout.trim()})`
    }
  }

  /**
   * Get working tree status.
   */
  async status(): Promise<GitStatusResult> {
    const branch = await this.getCurrentBranch()
    const files: GitFileEntry[] = []

    // Porcelain v2 for machine-readable output
    const { stdout } = await this.git(['status', '--porcelain=v1', '-b', '--untracked-files=normal'])
    const lines = stdout.trim().split('\n').filter(Boolean)

    let upstream: string | undefined
    let ahead = 0
    let behind = 0

    for (const line of lines) {
      // Branch line: ## branch...upstream [ahead N, behind M]
      if (line.startsWith('## ')) {
        const branchInfo = line.slice(3)
        const upstreamMatch = /\.\.\.(\S+)/.exec(branchInfo)
        if (upstreamMatch) upstream = upstreamMatch[1]

        const aheadMatch = /ahead (\d+)/.exec(branchInfo)
        if (aheadMatch) ahead = Number(aheadMatch[1])

        const behindMatch = /behind (\d+)/.exec(branchInfo)
        if (behindMatch) behind = Number(behindMatch[1])
        continue
      }

      // File entries: XY path or XY orig -> path
      const indexStatus = line.charAt(0)
      const workTreeStatus = line.charAt(1)
      const pathPart = line.slice(3)

      // Renamed files: "orig -> new"
      const renameMatch = /^(.+) -> (.+)$/.exec(pathPart)
      const resolvedPath = renameMatch?.[2] ?? pathPart

      if (indexStatus !== ' ' && indexStatus !== '?') {
        // Staged change
        const stagedEntry: GitFileEntry = {
          path: resolvedPath,
          status: STATUS_MAP[indexStatus] ?? 'modified',
          staged: true,
        }
        if (renameMatch?.[1] !== undefined) stagedEntry.originalPath = renameMatch[1]
        files.push(stagedEntry)
      }

      if (workTreeStatus !== ' ' && workTreeStatus !== '?') {
        // Unstaged change
        files.push({
          path: resolvedPath,
          status: STATUS_MAP[workTreeStatus] ?? 'modified',
          staged: false,
        })
      }

      // Untracked files
      if (indexStatus === '?' && workTreeStatus === '?') {
        files.push({
          path: pathPart,
          status: 'untracked',
          staged: false,
        })
      }
    }

    const statusResult: GitStatusResult = {
      branch,
      ahead,
      behind,
      files,
      clean: files.length === 0,
    }
    if (upstream !== undefined) statusResult.upstream = upstream
    return statusResult
  }

  /**
   * Get diff (staged, unstaged, or between refs).
   */
  async diff(options?: {
    staged?: boolean
    ref1?: string
    ref2?: string
    paths?: string[]
  }): Promise<GitDiffResult> {
    const args = ['diff']

    if (options?.staged) {
      args.push('--cached')
    } else if (options?.ref1) {
      args.push(options.ref1)
      if (options?.ref2) args.push(options.ref2)
    }

    // Always include stat
    const statArgs = [...args, '--stat']
    const { stdout: statOut } = await this.git(statArgs)

    // Full diff
    if (options?.paths?.length) {
      args.push('--', ...options.paths)
    }
    const { stdout: diffOut } = await this.git(args)

    // Parse stat output
    const fileStats: GitDiffResult['files'] = []
    let totalInsertions = 0
    let totalDeletions = 0

    const statLines = statOut.trim().split('\n')
    for (const line of statLines) {
      // Match: " file.ts | 10 ++++---"
      const match = /^\s*(.+?)\s*\|\s*(\d+)\s*([+-]*)/.exec(line)
      if (match) {
        const path = (match[1] ?? '').trim()
        const insertions = (match[3]?.match(/\+/g) ?? []).length
        const deletions = (match[3]?.match(/-/g) ?? []).length
        fileStats.push({ path, insertions, deletions })
        totalInsertions += insertions
        totalDeletions += deletions
      }
    }

    // Fallback: parse summary line
    const summaryMatch = /(\d+) insertions?\(\+\).*?(\d+) deletions?\(-\)/.exec(statOut)
    if (summaryMatch) {
      totalInsertions = Number(summaryMatch[1])
      totalDeletions = Number(summaryMatch[2])
    }

    return {
      diff: diffOut,
      filesChanged: fileStats.length,
      insertions: totalInsertions,
      deletions: totalDeletions,
      files: fileStats,
    }
  }

  /**
   * Get recent commit log.
   */
  async log(maxCount = 10): Promise<GitLogEntry[]> {
    const { stdout } = await this.git([
      'log',
      `--max-count=${maxCount}`,
      '--format=%H|%h|%an|%aI|%s',
    ])

    return stdout.trim().split('\n').filter(Boolean).map(line => {
      const parts = line.split('|')
      return {
        hash: parts[0] ?? '',
        shortHash: parts[1] ?? '',
        author: parts[2] ?? '',
        date: parts[3] ?? '',
        message: parts.slice(4).join('|'),
      }
    })
  }

  /**
   * Stage files.
   */
  async add(paths: string[]): Promise<void> {
    if (paths.length === 0) return
    await this.git(['add', '--', ...paths])
  }

  /**
   * Stage all changes.
   */
  async addAll(): Promise<void> {
    await this.git(['add', '-A'])
  }

  /**
   * Create a commit.
   */
  async commit(message: string): Promise<GitCommitResult> {
    await this.git(['commit', '-m', message])

    const { stdout } = await this.git(['log', '-1', '--format=%H|%s'])
    const parts = stdout.trim().split('|')

    const { stdout: statOut } = await this.git(['diff', '--stat', 'HEAD~1', 'HEAD'])
    const filesMatch = /(\d+) files? changed/.exec(statOut)

    return {
      hash: parts[0] ?? '',
      message: parts.slice(1).join('|'),
      filesChanged: filesMatch ? Number(filesMatch[1]) : 0,
    }
  }

  /**
   * Create a new branch.
   */
  async createBranch(name: string, startPoint?: string): Promise<void> {
    const args = ['checkout', '-b', name]
    if (startPoint) args.push(startPoint)
    await this.git(args)
  }

  /**
   * Switch to an existing branch.
   */
  async switchBranch(name: string): Promise<void> {
    await this.git(['checkout', name])
  }

  /**
   * List branches.
   */
  async listBranches(): Promise<Array<{ name: string; current: boolean }>> {
    const { stdout } = await this.git(['branch', '--format=%(refname:short)|%(HEAD)'])
    return stdout.trim().split('\n').filter(Boolean).map(line => {
      const parts = line.split('|')
      return {
        name: parts[0] ?? '',
        current: parts[1] === '*',
      }
    })
  }

  /**
   * Get the short hash of HEAD.
   */
  async headHash(): Promise<string> {
    const { stdout } = await this.git(['rev-parse', '--short', 'HEAD'])
    return stdout.trim()
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const result = await execFileAsync('git', args, {
      cwd: this.cwd,
      timeout: this.timeoutMs,
      maxBuffer: this.maxBuffer,
    })
    return { stdout: result.stdout, stderr: result.stderr }
  }
}
