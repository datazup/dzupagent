/**
 * GitHub connector tool invocation tests — covers each tool's func() handler
 * including the safe() wrapper, success paths, error paths, and edge cases
 * like directory listings and merge failures.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createGitHubConnector, createGitHubConnectorToolkit } from '../github/github-connector.js'

describe('GitHub connector — tool invocations', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function mockFetch(body: unknown, ok = true, status = 200) {
    const mock = vi.fn().mockResolvedValue({
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })
    vi.stubGlobal('fetch', mock)
    return mock
  }

  function tool(name: string) {
    const tools = createGitHubConnector({ token: 'test-token' })
    return tools.find(t => t.name === name)!
  }

  // ── github_get_file — directory listing ─────────────────

  describe('github_get_file', () => {
    it('returns decoded base64 content for a file', async () => {
      const content = Buffer.from('Hello World').toString('base64')
      mockFetch({ name: 'README.md', path: 'README.md', type: 'file', content, encoding: 'base64', sha: 'abc', html_url: '' })
      const result = await tool('github_get_file').invoke({ owner: 'o', repo: 'r', path: 'README.md' })
      expect(result).toBe('Hello World')
    })

    it('returns directory listing when response is an array', async () => {
      mockFetch([
        { type: 'file', path: 'src/index.ts', name: 'index.ts', sha: 'a', html_url: '' },
        { type: 'dir', path: 'src/utils', name: 'utils', sha: 'b', html_url: '' },
      ])
      const result = await tool('github_get_file').invoke({ owner: 'o', repo: 'r', path: 'src' })
      expect(result).toContain('f src/index.ts')
      expect(result).toContain('d src/utils')
    })

    it('returns JSON for file without base64 content', async () => {
      mockFetch({ name: 'file', path: 'file', type: 'file', sha: 'abc', html_url: '' })
      const result = await tool('github_get_file').invoke({ owner: 'o', repo: 'r', path: 'file' })
      expect(result).toContain('"name"')
    })

    it('returns error string on API failure', async () => {
      mockFetch({ message: 'Not Found' }, false, 404)
      const result = await tool('github_get_file').invoke({ owner: 'o', repo: 'r', path: 'missing' })
      expect(result).toContain('GitHub API error 404')
    })

    it('returns error string on network failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
      const result = await tool('github_get_file').invoke({ owner: 'o', repo: 'r', path: 'x' })
      expect(result).toContain('Error: fetch failed')
    })
  })

  // ── github_list_issues ──────────────────────────────────

  describe('github_list_issues', () => {
    it('returns JSON array of issues', async () => {
      mockFetch([{ number: 1, title: 'Bug', state: 'open' }])
      const result = await tool('github_list_issues').invoke({ owner: 'o', repo: 'r' })
      expect(JSON.parse(result as string)).toHaveLength(1)
    })

    it('returns error on failure', async () => {
      mockFetch({ message: 'Bad credentials' }, false, 401)
      const result = await tool('github_list_issues').invoke({ owner: 'o', repo: 'r' })
      expect(result).toContain('GitHub API error 401')
    })
  })

  // ── github_get_issue ────────────────────────────────────

  describe('github_get_issue', () => {
    it('returns JSON for a single issue', async () => {
      mockFetch({ number: 42, title: 'Fix', state: 'closed' })
      const result = await tool('github_get_issue').invoke({ owner: 'o', repo: 'r', issue_number: 42 })
      const parsed = JSON.parse(result as string)
      expect(parsed.number).toBe(42)
    })
  })

  // ── github_create_issue ─────────────────────────────────

  describe('github_create_issue', () => {
    it('returns success message with issue URL', async () => {
      mockFetch({ number: 10, html_url: 'https://github.com/o/r/issues/10' })
      const result = await tool('github_create_issue').invoke({ owner: 'o', repo: 'r', title: 'New' })
      expect(result).toContain('Created issue #10')
      expect(result).toContain('https://github.com/o/r/issues/10')
    })

    it('returns error on failure', async () => {
      mockFetch({ message: 'Validation Failed' }, false, 422)
      const result = await tool('github_create_issue').invoke({ owner: 'o', repo: 'r', title: '' })
      expect(result).toContain('GitHub API error 422')
    })
  })

  // ── github_update_issue ─────────────────────────────────

  describe('github_update_issue', () => {
    it('returns success message with state', async () => {
      mockFetch({ number: 5, state: 'closed', html_url: 'https://github.com/o/r/issues/5' })
      const result = await tool('github_update_issue').invoke({
        owner: 'o', repo: 'r', issue_number: 5, state: 'closed',
      })
      expect(result).toContain('Updated issue #5 (closed)')
    })
  })

  // ── github_add_comment ──────────────────────────────────

  describe('github_add_comment', () => {
    it('returns success with comment URL', async () => {
      mockFetch({ id: 1, html_url: 'https://github.com/o/r/issues/1#comment-1', body: 'hi' })
      const result = await tool('github_add_comment').invoke({
        owner: 'o', repo: 'r', issue_number: 1, body: 'LGTM',
      })
      expect(result).toContain('Comment added')
    })
  })

  // ── github_list_prs ─────────────────────────────────────

  describe('github_list_prs', () => {
    it('returns JSON of PRs', async () => {
      mockFetch([{ number: 1, title: 'feat' }])
      const result = await tool('github_list_prs').invoke({ owner: 'o', repo: 'r' })
      expect(JSON.parse(result as string)).toHaveLength(1)
    })
  })

  // ── github_get_pr ───────────────────────────────────────

  describe('github_get_pr', () => {
    it('returns JSON of a single PR', async () => {
      mockFetch({ number: 3, title: 'Fix', state: 'open' })
      const result = await tool('github_get_pr').invoke({ owner: 'o', repo: 'r', pr_number: 3 })
      expect(JSON.parse(result as string).number).toBe(3)
    })
  })

  // ── github_create_pr ────────────────────────────────────

  describe('github_create_pr', () => {
    it('returns success with PR URL', async () => {
      mockFetch({ number: 7, html_url: 'https://github.com/o/r/pull/7' })
      const result = await tool('github_create_pr').invoke({
        owner: 'o', repo: 'r', title: 'New PR', head: 'feat', base: 'main',
      })
      expect(result).toContain('Created PR #7')
    })
  })

  // ── github_merge_pr ─────────────────────────────────────

  describe('github_merge_pr', () => {
    it('returns success message when merged', async () => {
      mockFetch({ sha: 'deadbeefcafe', merged: true, message: 'ok' })
      const result = await tool('github_merge_pr').invoke({ owner: 'o', repo: 'r', pr_number: 5 })
      expect(result).toContain('PR #5 merged successfully')
      expect(result).toContain('deadbee')
    })

    it('returns failure message when not merged', async () => {
      mockFetch({ sha: '', merged: false, message: 'Merge conflict' })
      const result = await tool('github_merge_pr').invoke({ owner: 'o', repo: 'r', pr_number: 5 })
      expect(result).toContain('PR #5 merge failed')
      expect(result).toContain('Merge conflict')
    })
  })

  // ── github_list_pr_reviews ──────────────────────────────

  describe('github_list_pr_reviews', () => {
    it('returns JSON of reviews', async () => {
      mockFetch([{ id: 1, state: 'APPROVED' }])
      const result = await tool('github_list_pr_reviews').invoke({ owner: 'o', repo: 'r', pr_number: 1 })
      expect(JSON.parse(result as string)).toHaveLength(1)
    })
  })

  // ── github_create_pr_review ─────────────────────────────

  describe('github_create_pr_review', () => {
    it('returns success with review state', async () => {
      mockFetch({ id: 1, state: 'APPROVED', html_url: 'https://github.com/o/r/pull/1#pullrequestreview-1' })
      const result = await tool('github_create_pr_review').invoke({
        owner: 'o', repo: 'r', pr_number: 1, body: 'LGTM', event: 'APPROVE',
      })
      expect(result).toContain('Review submitted (APPROVED)')
    })
  })

  // ── github_get_repo ─────────────────────────────────────

  describe('github_get_repo', () => {
    it('returns JSON of repo info', async () => {
      mockFetch({ full_name: 'o/r', description: 'test', private: false })
      const result = await tool('github_get_repo').invoke({ owner: 'o', repo: 'r' })
      expect(JSON.parse(result as string).full_name).toBe('o/r')
    })
  })

  // ── github_list_branches ────────────────────────────────

  describe('github_list_branches', () => {
    it('returns formatted branch list', async () => {
      mockFetch([
        { name: 'main', commit: { sha: 'abcdef1234567' }, protected: true },
        { name: 'dev', commit: { sha: '1234567abcdef' }, protected: false },
      ])
      const result = await tool('github_list_branches').invoke({ owner: 'o', repo: 'r' })
      expect(result).toContain('main (abcdef1) [protected]')
      expect(result).toContain('dev (1234567)')
    })
  })

  // ── github_get_commit ───────────────────────────────────

  describe('github_get_commit', () => {
    it('returns JSON of commit', async () => {
      mockFetch({ sha: 'abc', commit: { message: 'fix' }, html_url: '' })
      const result = await tool('github_get_commit').invoke({ owner: 'o', repo: 'r', sha: 'abc' })
      expect(JSON.parse(result as string).sha).toBe('abc')
    })
  })

  // ── github_compare_commits ──────────────────────────────

  describe('github_compare_commits', () => {
    it('returns formatted comparison summary', async () => {
      mockFetch({
        status: 'ahead',
        ahead_by: 3,
        behind_by: 0,
        total_commits: 3,
        commits: [],
        files: [
          { status: 'modified', filename: 'src/index.ts', additions: 10, deletions: 5 },
        ],
      })
      const result = await tool('github_compare_commits').invoke({
        owner: 'o', repo: 'r', base: 'main', head: 'feat',
      })
      expect(result).toContain('Status: ahead')
      expect(result).toContain('Ahead by: 3')
      expect(result).toContain('modified src/index.ts (+10 -5)')
    })
  })

  // ── github_search_code ──────────────────────────────────

  describe('github_search_code', () => {
    it('returns formatted search results', async () => {
      mockFetch({
        items: [
          { path: 'src/main.ts', repository: { full_name: 'org/repo' } },
          { path: 'lib/utils.ts' },
        ],
      })
      const result = await tool('github_search_code').invoke({ query: 'test' })
      expect(result).toContain('org/repo/src/main.ts')
      expect(result).toContain('?/lib/utils.ts')
    })
  })

  // ── safe() wrapper with non-Error thrown ─────────────────

  describe('safe() wrapper edge cases', () => {
    it('handles non-Error thrown objects', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue('raw string error'))
      const result = await tool('github_get_repo').invoke({ owner: 'o', repo: 'r' })
      expect(result).toContain('Error: raw string error')
    })
  })

  // ── Toolkit factory ──────────────────────────────────────

  describe('createGitHubConnectorToolkit', () => {
    it('returns toolkit with name and all tools', () => {
      const tk = createGitHubConnectorToolkit({ token: 'tok' })
      expect(tk.name).toBe('github')
      expect(tk.tools.length).toBeGreaterThanOrEqual(10)
    })

    it('filters tools via enabledTools', () => {
      const tk = createGitHubConnectorToolkit({
        token: 'tok',
        enabledTools: ['github_get_repo'],
      })
      expect(tk.tools).toHaveLength(1)
      expect(tk.tools[0]!.name).toBe('github_get_repo')
    })

    it('returns empty tools for non-matching filter', () => {
      const tk = createGitHubConnectorToolkit({
        token: 'tok',
        enabledTools: ['nonexistent'],
      })
      expect(tk.tools).toHaveLength(0)
    })
  })
})
