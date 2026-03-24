/**
 * Git middleware — injects git repository context into agent state.
 *
 * Reads current branch, working tree status, and recent commits,
 * then formats them as a system-level context block for the LLM.
 *
 * Non-fatal: if git operations fail (e.g., not a git repo), the
 * middleware returns the state unchanged.
 */
import { GitExecutor } from './git-executor.js'
import type { GitExecutorConfig } from './git-types.js'

export interface GitContextConfig extends GitExecutorConfig {
  /** Number of recent commits to include (default: 5) */
  recentCommits?: number
  /** Include file-level diff stats (default: false — can be large) */
  includeDiffStat?: boolean
}

export interface GitContext {
  branch: string
  status: string
  recentCommits: string
  isDirty: boolean
}

/**
 * Gather git context for the current working directory.
 * Returns null if the directory is not a git repository.
 */
export async function gatherGitContext(
  config?: Partial<GitContextConfig>,
): Promise<GitContext | null> {
  const git = new GitExecutor(config)
  const limit = config?.recentCommits ?? 5

  try {
    const [statusResult, logEntries] = await Promise.all([
      git.status(),
      git.log(limit),
    ])

    // Format status
    const statusLines = statusResult.files.map(f => `  ${f.status} ${f.path}`)
    const statusText = statusLines.length > 0
      ? statusLines.join('\n')
      : '(clean working tree)'

    // Format commits
    const commitLines = logEntries.map(
      c => `  ${c.hash.slice(0, 7)} ${c.message}`,
    )

    return {
      branch: statusResult.branch,
      status: statusText,
      recentCommits: commitLines.join('\n') || '(no commits)',
      isDirty: statusResult.files.length > 0,
    }
  } catch {
    // Not a git repo or git not available
    return null
  }
}

/**
 * Format git context as a markdown block for injection into agent prompts.
 */
export function formatGitContext(ctx: GitContext): string {
  return [
    '## Git Context',
    `**Branch:** ${ctx.branch}`,
    '',
    '**Working tree:**',
    '```',
    ctx.status,
    '```',
    '',
    '**Recent commits:**',
    '```',
    ctx.recentCommits,
    '```',
  ].join('\n')
}
