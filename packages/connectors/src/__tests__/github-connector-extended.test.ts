/**
 * Extended GitHub connector tool tests — covers edge cases in the
 * connector tool wrapper layer: non-base64 file content fallback,
 * non-GitHubApiError exceptions in safe(), search code with missing
 * repository, and toolkit factory.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createGitHubConnector } from '../github/github-connector.js'
import { createGitHubConnectorToolkit } from '../github/index.js'

describe('GitHub connector — extended tool coverage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function mockGitHubApi(body: unknown, ok = true, status = 200) {
    const mock = vi.fn().mockResolvedValue({
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })
    vi.stubGlobal('fetch', mock)
    return mock
  }

  function getTool(name: string) {
    const tools = createGitHubConnector({ token: 'test-token' })
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error(`Tool ${name} not found`)
    return tool
  }

  // ── github_get_file: non-base64 fallback ──────────────

  describe('github_get_file — non-base64 content', () => {
    it('returns JSON when file has no content field', async () => {
      mockGitHubApi({
        type: 'file',
        name: 'data.bin',
        path: 'data.bin',
        sha: 'abc',
        html_url: 'https://github.com/org/app/blob/main/data.bin',
      })
      const getFile = getTool('github_get_file')
      const result = await getFile.invoke({ owner: 'org', repo: 'app', path: 'data.bin' })

      // Should fall through to JSON.stringify since no content/encoding
      expect(result).toContain('data.bin')
      const parsed = JSON.parse(result) as Record<string, unknown>
      expect(parsed['sha']).toBe('abc')
    })

    it('returns JSON when encoding is not base64', async () => {
      mockGitHubApi({
        type: 'file',
        name: 'data.txt',
        path: 'data.txt',
        content: 'raw content here',
        encoding: 'utf-8',
        sha: 'def',
        html_url: '',
      })
      const getFile = getTool('github_get_file')
      const result = await getFile.invoke({ owner: 'org', repo: 'app', path: 'data.txt' })

      const parsed = JSON.parse(result) as Record<string, unknown>
      expect(parsed['content']).toBe('raw content here')
      expect(parsed['encoding']).toBe('utf-8')
    })
  })

  // ── safe() error wrapping — non-GitHubApiError ────────

  describe('error wrapping in safe()', () => {
    it('returns generic Error message for non-API errors', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Network error')))
      const getRepo = getTool('github_get_repo')
      const result = await getRepo.invoke({ owner: 'org', repo: 'app' })

      expect(result).toContain('Error')
      expect(result).toContain('Network error')
    })

    it('returns string representation for non-Error thrown values', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue('string error'))
      const getRepo = getTool('github_get_repo')
      const result = await getRepo.invoke({ owner: 'org', repo: 'app' })

      expect(result).toContain('Error')
      expect(result).toContain('string error')
    })
  })

  // ── github_search_code — missing repository ───────────

  describe('github_search_code — edge cases', () => {
    it('handles items with missing repository field', async () => {
      mockGitHubApi({
        items: [
          { path: 'src/utils.ts' },
        ],
      })
      const search = getTool('github_search_code')
      const result = await search.invoke({ query: 'parseJSON' })

      expect(result).toContain('?/src/utils.ts')
    })

    it('passes custom per_page', async () => {
      const mock = mockGitHubApi({ items: [] })
      const search = getTool('github_search_code')
      await search.invoke({ query: 'test', per_page: 25 })

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('per_page=25')
    })

    it('returns error string on API failure', async () => {
      mockGitHubApi({ message: 'rate limit' }, false, 403)
      const search = getTool('github_search_code')
      const result = await search.invoke({ query: 'test' })

      expect(result).toContain('GitHub API error')
      expect(result).toContain('403')
    })
  })

  // ── github_list_prs tool — error handling ─────────────

  describe('github_list_prs — error', () => {
    it('returns error string on 500', async () => {
      mockGitHubApi({ message: 'server error' }, false, 500)
      const listPRs = getTool('github_list_prs')
      const result = await listPRs.invoke({ owner: 'org', repo: 'app' })

      expect(result).toContain('GitHub API error')
      expect(result).toContain('500')
    })
  })

  // ── github_get_pr — error handling ────────────────────

  describe('github_get_pr — error', () => {
    it('returns error string on 404', async () => {
      mockGitHubApi({ message: 'Not Found' }, false, 404)
      const getPR = getTool('github_get_pr')
      const result = await getPR.invoke({ owner: 'org', repo: 'app', pr_number: 999 })

      expect(result).toContain('GitHub API error')
      expect(result).toContain('404')
    })
  })

  // ── github_list_pr_reviews — error handling ───────────

  describe('github_list_pr_reviews — error', () => {
    it('returns error string on failure', async () => {
      mockGitHubApi({ message: 'Not Found' }, false, 404)
      const listReviews = getTool('github_list_pr_reviews')
      const result = await listReviews.invoke({ owner: 'org', repo: 'app', pr_number: 99 })

      expect(result).toContain('GitHub API error')
    })
  })

  // ── github_create_pr_review — error handling ──────────

  describe('github_create_pr_review — error', () => {
    it('returns error string on failure', async () => {
      mockGitHubApi({ message: 'Validation Failed' }, false, 422)
      const createReview = getTool('github_create_pr_review')
      const result = await createReview.invoke({
        owner: 'org', repo: 'app', pr_number: 10, body: 'test', event: 'COMMENT',
      })

      expect(result).toContain('GitHub API error')
      expect(result).toContain('422')
    })
  })

  // ── github_list_branches — error handling ─────────────

  describe('github_list_branches — error', () => {
    it('returns error string on failure', async () => {
      mockGitHubApi({ message: 'server error' }, false, 500)
      const listBranches = getTool('github_list_branches')
      const result = await listBranches.invoke({ owner: 'org', repo: 'app' })

      expect(result).toContain('GitHub API error')
    })
  })

  // ── github_get_commit — error handling ────────────────

  describe('github_get_commit — error', () => {
    it('returns error string on 404', async () => {
      mockGitHubApi({ message: 'Not Found' }, false, 404)
      const getCommit = getTool('github_get_commit')
      const result = await getCommit.invoke({ owner: 'org', repo: 'app', sha: 'bad' })

      expect(result).toContain('GitHub API error')
    })
  })

  // ── Toolkit factory ───────────────────────────────────

  describe('createGitHubConnectorToolkit', () => {
    it('returns toolkit with expected structure', () => {
      const tk = createGitHubConnectorToolkit({ token: 'tok' })
      expect(tk.name).toBe('github')
      expect(Array.isArray(tk.tools)).toBe(true)
      expect(tk.tools.length).toBeGreaterThan(0)
    })

    it('passes enabledTools to filter', () => {
      const tk = createGitHubConnectorToolkit({
        token: 'tok',
        enabledTools: ['github_get_file'],
      })
      expect(tk.tools).toHaveLength(1)
      expect(tk.enabledTools).toEqual(['github_get_file'])
    })
  })

  // ── Full tool list verification ───────────────────────

  describe('tool list', () => {
    it('creates all expected tools', () => {
      const tools = createGitHubConnector({ token: 'tok' })
      const names = tools.map(t => t.name)
      expect(names).toContain('github_get_file')
      expect(names).toContain('github_list_issues')
      expect(names).toContain('github_get_issue')
      expect(names).toContain('github_create_issue')
      expect(names).toContain('github_update_issue')
      expect(names).toContain('github_add_comment')
      expect(names).toContain('github_list_prs')
      expect(names).toContain('github_get_pr')
      expect(names).toContain('github_create_pr')
      expect(names).toContain('github_merge_pr')
      expect(names).toContain('github_list_pr_reviews')
      expect(names).toContain('github_create_pr_review')
      expect(names).toContain('github_get_repo')
      expect(names).toContain('github_list_branches')
      expect(names).toContain('github_get_commit')
      expect(names).toContain('github_compare_commits')
      expect(names).toContain('github_search_code')
    })
  })
})
