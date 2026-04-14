/**
 * Git LangChain tool definitions for agent use.
 *
 * Follows the same factory-function pattern as write-file.tool.ts
 * and edit-file.tool.ts. Each tool embeds workflow instructions in
 * its description (Claude Code pattern).
 */
import { z } from 'zod'
import { tool } from '@langchain/core/tools'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { GitExecutor } from './git-executor.js'

/**
 * Create all git tools bound to a GitExecutor instance.
 */
export function createGitTools(executor: GitExecutor): StructuredToolInterface[] {
  return [
    createGitStatusTool(executor),
    createGitDiffTool(executor),
    createGitCommitTool(executor),
    createGitLogTool(executor),
    createGitBranchTool(executor),
  ]
}

// ---------------------------------------------------------------------------
// git_status
// ---------------------------------------------------------------------------

export function createGitStatusTool(executor: GitExecutor) {
  return tool(
    async () => {
      try {
        const status = await executor.status()
        return JSON.stringify(status)
      } catch (err) {
        return JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
    {
      name: 'git_status',
      description: [
        'Show the current git working tree status including branch, staged/unstaged changes, and untracked files.',
        'Use this before committing to understand what has changed.',
        'Returns: branch name, upstream tracking info, ahead/behind counts, and per-file status.',
      ].join(' '),
      schema: z.object({}),
    },
  )
}

// ---------------------------------------------------------------------------
// git_diff
// ---------------------------------------------------------------------------

export function createGitDiffTool(executor: GitExecutor) {
  return tool(
    async ({ staged, ref1, ref2, paths }) => {
      try {
        const diffOpts: { staged?: boolean; ref1?: string; ref2?: string; paths?: string[] } = {
          staged: staged ?? false,
        }
        if (ref1 != null) diffOpts.ref1 = ref1
        if (ref2 != null) diffOpts.ref2 = ref2
        if (paths != null) diffOpts.paths = paths
        const result = await executor.diff(diffOpts)

        // Truncate large diffs to prevent context overflow
        const maxDiffLen = 8_000
        const diff = result.diff.length > maxDiffLen
          ? result.diff.slice(0, maxDiffLen) + `\n\n[... diff truncated, ${result.diff.length - maxDiffLen} chars omitted]`
          : result.diff

        return JSON.stringify({
          ...result,
          diff,
        })
      } catch (err) {
        return JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
    {
      name: 'git_diff',
      description: [
        'Show file differences. By default shows unstaged changes.',
        'Set staged=true to see what will be committed.',
        'Set ref1/ref2 to compare between commits or branches.',
        'The diff output is truncated to prevent context overflow.',
        'Use paths to limit diff to specific files.',
      ].join(' '),
      schema: z.object({
        staged: z.boolean().optional().describe('Show staged (cached) changes only'),
        ref1: z.string().optional().describe('First ref to compare (branch, tag, or commit hash)'),
        ref2: z.string().optional().describe('Second ref to compare'),
        paths: z.array(z.string()).optional().describe('Limit diff to specific file paths'),
      }),
    },
  )
}

// ---------------------------------------------------------------------------
// git_commit
// ---------------------------------------------------------------------------

export function createGitCommitTool(executor: GitExecutor) {
  return tool(
    async ({ message, paths, addAll }) => {
      try {
        // Stage files
        if (addAll) {
          await executor.addAll()
        } else if (paths && paths.length > 0) {
          await executor.add(paths)
        }

        // Verify there are staged changes
        const status = await executor.status()
        const stagedFiles = status.files.filter(f => f.staged)
        if (stagedFiles.length === 0) {
          return JSON.stringify({
            error: 'No staged changes to commit. Stage files first or use addAll=true.',
            status,
          })
        }

        const result = await executor.commit(message)
        return JSON.stringify({
          ...result,
          success: true,
        })
      } catch (err) {
        return JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
          success: false,
        })
      }
    },
    {
      name: 'git_commit',
      description: [
        'Create a git commit with the given message.',
        'IMPORTANT: Never commit unless explicitly asked by the user.',
        'Prefer staging specific files with paths rather than addAll to avoid committing sensitive files (.env, credentials).',
        'Write clear commit messages: use imperative mood, describe the "why" not just the "what".',
        'If pre-commit hooks fail, fix the underlying issue — do not bypass hooks.',
      ].join(' '),
      schema: z.object({
        message: z.string().describe('Commit message (imperative mood, concise)'),
        paths: z.array(z.string()).optional().describe('Specific files to stage before committing'),
        addAll: z.boolean().optional().describe('Stage all changes before committing (use with caution)'),
      }),
    },
  )
}

// ---------------------------------------------------------------------------
// git_log
// ---------------------------------------------------------------------------

export function createGitLogTool(executor: GitExecutor) {
  return tool(
    async ({ maxCount }) => {
      try {
        const entries = await executor.log(maxCount ?? 10)
        return JSON.stringify(entries)
      } catch (err) {
        return JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
    {
      name: 'git_log',
      description: 'Show recent commit history. Use to understand what changed recently and follow the repository\'s commit message style.',
      schema: z.object({
        maxCount: z.number().optional().describe('Maximum number of commits to show (default: 10)'),
      }),
    },
  )
}

// ---------------------------------------------------------------------------
// git_branch
// ---------------------------------------------------------------------------

export function createGitBranchTool(executor: GitExecutor) {
  return tool(
    async ({ action, name, startPoint }) => {
      try {
        switch (action) {
          case 'list': {
            const branches = await executor.listBranches()
            return JSON.stringify(branches)
          }
          case 'create': {
            if (!name) {
              return JSON.stringify({ error: 'Branch name is required for create action' })
            }
            await executor.createBranch(name, startPoint ?? undefined)
            return JSON.stringify({ success: true, action: 'created', branch: name })
          }
          case 'switch': {
            if (!name) {
              return JSON.stringify({ error: 'Branch name is required for switch action' })
            }
            await executor.switchBranch(name)
            return JSON.stringify({ success: true, action: 'switched', branch: name })
          }
          default:
            return JSON.stringify({ error: `Unknown action: ${action as string}` })
        }
      } catch (err) {
        return JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
    {
      name: 'git_branch',
      description: [
        'Manage git branches: list, create, or switch.',
        'Use action="list" to see all branches.',
        'Use action="create" with a name to create a new branch.',
        'Use action="switch" with a name to switch to an existing branch.',
      ].join(' '),
      schema: z.object({
        action: z.enum(['list', 'create', 'switch']).describe('Branch operation to perform'),
        name: z.string().optional().describe('Branch name (required for create/switch)'),
        startPoint: z.string().optional().describe('Start point for new branch (commit hash, branch, or tag)'),
      }),
    },
  )
}
