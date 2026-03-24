/**
 * GitHub connector — produces LangChain tools for GitHub API operations.
 *
 * Uses the GitHub REST API directly via fetch (no octokit dependency).
 * Requires a personal access token with appropriate scopes.
 *
 * @example
 * ```ts
 * const tools = createGitHubConnector({ token: process.env.GITHUB_TOKEN! })
 * const agent = new ForgeAgent({ tools, ... })
 * ```
 */
import { z } from 'zod'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { filterTools } from '../connector-types.js'

export interface GitHubConnectorConfig {
  token: string
  /** Subset of tools to enable (default: all) */
  enabledTools?: string[]
  /** GitHub API base URL (default: https://api.github.com) */
  baseUrl?: string
}

const API = 'https://api.github.com'

export function createGitHubConnector(config: GitHubConnectorConfig): DynamicStructuredTool[] {
  const base = config.baseUrl ?? API
  const headers = {
    'Authorization': `Bearer ${config.token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }

  async function gh(path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...init?.headers } })
    if (!res.ok) {
      const text = await res.text()
      return `GitHub API error ${res.status}: ${text.slice(0, 200)}`
    }
    return res.json()
  }

  const all: DynamicStructuredTool[] = [
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
        const query = ref ? `?ref=${encodeURIComponent(ref)}` : ''
        const data = await gh(`/repos/${owner}/${repo}/contents/${path}${query}`) as Record<string, unknown>
        if (typeof data === 'string') return data // error
        if (data['content'] && data['encoding'] === 'base64') {
          return Buffer.from(data['content'] as string, 'base64').toString('utf8')
        }
        return JSON.stringify(data)
      },
    }),

    new DynamicStructuredTool({
      name: 'github_list_issues',
      description: 'List issues for a GitHub repository',
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
        state: z.enum(['open', 'closed', 'all']).optional().describe('Filter by state (default: open)'),
        labels: z.string().optional().describe('Comma-separated list of label names'),
        per_page: z.number().optional().describe('Results per page (default: 10, max: 100)'),
      }),
      func: async ({ owner, repo, state, labels, per_page }) => {
        const params = new URLSearchParams()
        if (state) params.set('state', state)
        if (labels) params.set('labels', labels)
        params.set('per_page', String(per_page ?? 10))
        const data = await gh(`/repos/${owner}/${repo}/issues?${params}`)
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
      }),
      func: async ({ owner, repo, title, body, labels }) => {
        const data = await gh(`/repos/${owner}/${repo}/issues`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, body, labels }),
        })
        if (typeof data === 'string') return data
        const issue = data as Record<string, unknown>
        return `Created issue #${issue['number']}: ${issue['html_url']}`
      },
    }),

    new DynamicStructuredTool({
      name: 'github_create_pr',
      description: 'Create a pull request in a GitHub repository',
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
        title: z.string(),
        body: z.string().optional(),
        head: z.string().describe('Branch containing changes'),
        base: z.string().describe('Branch to merge into (e.g., main)'),
      }),
      func: async ({ owner, repo, title, body, head, base }) => {
        const data = await gh(`/repos/${owner}/${repo}/pulls`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, body, head, base }),
        })
        if (typeof data === 'string') return data
        const pr = data as Record<string, unknown>
        return `Created PR #${pr['number']}: ${pr['html_url']}`
      },
    }),

    new DynamicStructuredTool({
      name: 'github_search_code',
      description: 'Search code across GitHub repositories',
      schema: z.object({
        query: z.string().describe('Search query (GitHub code search syntax)'),
        per_page: z.number().optional().describe('Results per page (default: 10)'),
      }),
      func: async ({ query, per_page }) => {
        const params = new URLSearchParams({ q: query, per_page: String(per_page ?? 10) })
        const data = await gh(`/search/code?${params}`) as Record<string, unknown>
        if (typeof data === 'string') return data
        const items = (data['items'] ?? []) as Array<Record<string, unknown>>
        return items.map(i =>
          `${i['repository'] ? (i['repository'] as Record<string, unknown>)['full_name'] : '?'}/${i['path']}`,
        ).join('\n')
      },
    }),
  ]

  return filterTools(all, config.enabledTools)
}
