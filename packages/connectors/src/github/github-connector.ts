/**
 * GitHub connector — produces LangChain tools for GitHub API operations.
 *
 * Uses the GitHub REST API directly via fetch (no octokit dependency).
 * Requires a personal access token with appropriate scopes.
 *
 * @example
 * ```ts
 * const tools = createGitHubConnector({ token: process.env.GITHUB_TOKEN! })
 * const agent = new DzupAgent({ tools, ... })
 * ```
 */
import { z } from 'zod'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { filterTools } from '../connector-types.js'
import type { ConnectorToolkit } from '../connector-contract.js'
import { GitHubClient, GitHubApiError } from './github-client.js'
import type { GitHubContent } from './github-client.js'

export interface GitHubConnectorConfig {
  token: string
  /** Subset of tools to enable (default: all) */
  enabledTools?: string[]
  /** GitHub API base URL (default: https://api.github.com) */
  baseUrl?: string
}

/** Safely invoke a client method, returning a user-friendly error string on failure. */
async function safe<T>(fn: () => Promise<T>): Promise<T | string> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof GitHubApiError) {
      return `GitHub API error ${err.status}: ${err.body.slice(0, 200)}`
    }
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

export function createGitHubConnector(config: GitHubConnectorConfig): DynamicStructuredTool[] {
  const client = new GitHubClient({
    token: config.token,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
  })

  const all: DynamicStructuredTool[] = [
    // ── File Content ───────────────────────────────────

    new DynamicStructuredTool({
      name: 'github_get_file',
      description: 'Get file content from a GitHub repository',
      schema: z.object({
        owner: z.string().describe('Repository owner'),
        repo: z.string().describe('Repository name'),
        path: z.string().describe('File path in the repo'),
        ref: z.string().optional().describe('Branch, tag, or commit SHA'),
      }),
      func: async ({ owner, repo, path, ref }) => {
        const data = await safe(() => client.getContent(owner, repo, path, ref))
        if (typeof data === 'string') return data
        if (Array.isArray(data)) {
          return data.map(e => `${e.type === 'dir' ? 'd' : 'f'} ${e.path}`).join('\n')
        }
        const file = data as GitHubContent
        if (file.content && file.encoding === 'base64') {
          return Buffer.from(file.content, 'base64').toString('utf8')
        }
        return JSON.stringify(file)
      },
    }),

    // ── Issues ─────────────────────────────────────────

    new DynamicStructuredTool({
      name: 'github_list_issues',
      description: 'List issues for a GitHub repository',
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
        state: z.enum(['open', 'closed', 'all']).optional().describe('Filter by state (default: open)'),
        labels: z.string().optional().describe('Comma-separated list of label names'),
        assignee: z.string().optional().describe('Filter by assignee username'),
        per_page: z.number().optional().describe('Results per page (default: 10, max: 100)'),
      }),
      func: async ({ owner, repo, state, labels, assignee, per_page }) => {
        const data = await safe(() => client.listIssues(owner, repo, {
          state, labels, assignee, per_page: per_page ?? 10,
        }))
        if (typeof data === 'string') return data
        return JSON.stringify(data, null, 2)
      },
    }),

    new DynamicStructuredTool({
      name: 'github_get_issue',
      description: 'Get a single issue by number from a GitHub repository',
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
        issue_number: z.number().describe('Issue number'),
      }),
      func: async ({ owner, repo, issue_number }) => {
        const data = await safe(() => client.getIssue(owner, repo, issue_number))
        if (typeof data === 'string') return data
        return JSON.stringify(data, null, 2)
      },
    }),

    new DynamicStructuredTool({
      name: 'github_create_issue',
      description: 'Create a new issue in a GitHub repository',
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
        title: z.string().describe('Issue title'),
        body: z.string().optional().describe('Issue body (markdown)'),
        labels: z.array(z.string()).optional().describe('Labels to add'),
        assignees: z.array(z.string()).optional().describe('Assignee usernames'),
      }),
      func: async ({ owner, repo, title, body, labels, assignees }) => {
        const data = await safe(() => client.createIssue(owner, repo, title, body, { labels, assignees }))
        if (typeof data === 'string') return data
        return `Created issue #${data.number}: ${data.html_url}`
      },
    }),

    new DynamicStructuredTool({
      name: 'github_update_issue',
      description: 'Update an existing issue in a GitHub repository',
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
        issue_number: z.number().describe('Issue number'),
        title: z.string().optional().describe('New title'),
        body: z.string().optional().describe('New body'),
        state: z.enum(['open', 'closed']).optional().describe('New state'),
        labels: z.array(z.string()).optional().describe('Replace labels'),
        assignees: z.array(z.string()).optional().describe('Replace assignees'),
      }),
      func: async ({ owner, repo, issue_number, title, body, state, labels, assignees }) => {
        const data = await safe(() => client.updateIssue(owner, repo, issue_number, {
          title, body, state, labels, assignees,
        }))
        if (typeof data === 'string') return data
        return `Updated issue #${data.number} (${data.state}): ${data.html_url}`
      },
    }),

    new DynamicStructuredTool({
      name: 'github_add_comment',
      description: 'Add a comment to an issue or pull request',
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
        issue_number: z.number().describe('Issue or PR number'),
        body: z.string().describe('Comment body (markdown)'),
      }),
      func: async ({ owner, repo, issue_number, body }) => {
        const data = await safe(() => client.addComment(owner, repo, issue_number, body))
        if (typeof data === 'string') return data
        return `Comment added: ${data.html_url}`
      },
    }),

    // ── Pull Requests ──────────────────────────────────

    new DynamicStructuredTool({
      name: 'github_list_prs',
      description: 'List pull requests for a GitHub repository',
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
        state: z.enum(['open', 'closed', 'all']).optional().describe('Filter by state (default: open)'),
        base: z.string().optional().describe('Filter by base branch'),
        sort: z.enum(['created', 'updated', 'popularity', 'long-running']).optional(),
        direction: z.enum(['asc', 'desc']).optional(),
        per_page: z.number().optional().describe('Results per page (default: 10)'),
      }),
      func: async ({ owner, repo, state, base, sort, direction, per_page }) => {
        const data = await safe(() => client.listPRs(owner, repo, {
          state, base, sort, direction, per_page: per_page ?? 10,
        }))
        if (typeof data === 'string') return data
        return JSON.stringify(data, null, 2)
      },
    }),

    new DynamicStructuredTool({
      name: 'github_get_pr',
      description: 'Get a single pull request by number',
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
        pr_number: z.number().describe('Pull request number'),
      }),
      func: async ({ owner, repo, pr_number }) => {
        const data = await safe(() => client.getPR(owner, repo, pr_number))
        if (typeof data === 'string') return data
        return JSON.stringify(data, null, 2)
      },
    }),

    new DynamicStructuredTool({
      name: 'github_create_pr',
      description: 'Create a pull request in a GitHub repository',
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
        title: z.string(),
        body: z.string().optional().describe('PR description (markdown)'),
        head: z.string().describe('Branch containing changes'),
        base: z.string().describe('Branch to merge into (e.g., main)'),
      }),
      func: async ({ owner, repo, title, body, head, base }) => {
        const data = await safe(() => client.createPR(owner, repo, title, body ?? '', head, base))
        if (typeof data === 'string') return data
        return `Created PR #${data.number}: ${data.html_url}`
      },
    }),

    new DynamicStructuredTool({
      name: 'github_merge_pr',
      description: 'Merge a pull request',
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
        pr_number: z.number().describe('Pull request number'),
        commit_title: z.string().optional().describe('Custom merge commit title'),
        commit_message: z.string().optional().describe('Custom merge commit message'),
        merge_method: z.enum(['merge', 'squash', 'rebase']).optional().describe('Merge method (default: merge)'),
      }),
      func: async ({ owner, repo, pr_number, commit_title, commit_message, merge_method }) => {
        const data = await safe(() => client.mergePR(owner, repo, pr_number, {
          commit_title, commit_message, merge_method,
        }))
        if (typeof data === 'string') return data
        if (data.merged) {
          return `PR #${pr_number} merged successfully (${data.sha.slice(0, 7)})`
        }
        return `PR #${pr_number} merge failed: ${data.message}`
      },
    }),

    new DynamicStructuredTool({
      name: 'github_list_pr_reviews',
      description: 'List reviews on a pull request',
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
        pr_number: z.number().describe('Pull request number'),
      }),
      func: async ({ owner, repo, pr_number }) => {
        const data = await safe(() => client.listPRReviews(owner, repo, pr_number))
        if (typeof data === 'string') return data
        return JSON.stringify(data, null, 2)
      },
    }),

    new DynamicStructuredTool({
      name: 'github_create_pr_review',
      description: 'Create a review on a pull request',
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
        pr_number: z.number().describe('Pull request number'),
        body: z.string().describe('Review comment body'),
        event: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']).describe('Review action'),
      }),
      func: async ({ owner, repo, pr_number, body, event }) => {
        const data = await safe(() => client.createPRReview(owner, repo, pr_number, body, event))
        if (typeof data === 'string') return data
        return `Review submitted (${data.state}): ${data.html_url}`
      },
    }),

    // ── Repository ─────────────────────────────────────

    new DynamicStructuredTool({
      name: 'github_get_repo',
      description: 'Get repository information',
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
      }),
      func: async ({ owner, repo }) => {
        const data = await safe(() => client.getRepo(owner, repo))
        if (typeof data === 'string') return data
        return JSON.stringify(data, null, 2)
      },
    }),

    new DynamicStructuredTool({
      name: 'github_list_branches',
      description: 'List branches in a repository',
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
      }),
      func: async ({ owner, repo }) => {
        const data = await safe(() => client.listBranches(owner, repo))
        if (typeof data === 'string') return data
        return data.map(b => `${b.name} (${b.commit.sha.slice(0, 7)})${b.protected ? ' [protected]' : ''}`).join('\n')
      },
    }),

    new DynamicStructuredTool({
      name: 'github_get_commit',
      description: 'Get details of a specific commit',
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
        sha: z.string().describe('Commit SHA (full or abbreviated)'),
      }),
      func: async ({ owner, repo, sha }) => {
        const data = await safe(() => client.getCommit(owner, repo, sha))
        if (typeof data === 'string') return data
        return JSON.stringify(data, null, 2)
      },
    }),

    new DynamicStructuredTool({
      name: 'github_compare_commits',
      description: 'Compare two commits, branches, or tags',
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
        base: z.string().describe('Base commit/branch/tag'),
        head: z.string().describe('Head commit/branch/tag'),
      }),
      func: async ({ owner, repo, base, head }) => {
        const data = await safe(() => client.compareCommits(owner, repo, base, head))
        if (typeof data === 'string') return data
        const summary = [
          `Status: ${data.status}`,
          `Ahead by: ${data.ahead_by}, Behind by: ${data.behind_by}`,
          `Total commits: ${data.total_commits}`,
          `Files changed: ${data.files.length}`,
          '',
          'Files:',
          ...data.files.map(f => `  ${f.status} ${f.filename} (+${f.additions} -${f.deletions})`),
        ]
        return summary.join('\n')
      },
    }),

    // ── Search ─────────────────────────────────────────

    new DynamicStructuredTool({
      name: 'github_search_code',
      description: 'Search code across GitHub repositories',
      schema: z.object({
        query: z.string().describe('Search query (GitHub code search syntax)'),
        per_page: z.number().optional().describe('Results per page (default: 10)'),
      }),
      func: async ({ query, per_page }) => {
        const params = new URLSearchParams({ q: query, per_page: String(per_page ?? 10) })
        const data = await safe(() =>
          client.request<{ items: Array<{ path: string; repository?: { full_name: string } }> }>(
            `/search/code?${params}`,
          ),
        )
        if (typeof data === 'string') return data
        return data.items.map(i =>
          `${i.repository?.full_name ?? '?'}/${i.path}`,
        ).join('\n')
      },
    }),
  ]

  return filterTools(all, config.enabledTools)
}

/**
 * Create a ConnectorToolkit for GitHub API operations.
 * Wraps `createGitHubConnector` in the unified toolkit pattern.
 */
export function createGitHubConnectorToolkit(config: GitHubConnectorConfig): ConnectorToolkit {
  return {
    name: 'github',
    tools: createGitHubConnector(config),
    enabledTools: config.enabledTools,
  }
}
