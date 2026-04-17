/**
 * Wave 19 — GitHub connector expansion tests.
 *
 * Covers the 5 new tools added in W19-B2:
 *   - github_get_pr_checks
 *   - github_add_labels
 *   - github_remove_label
 *   - github_create_review_comment
 *   - github_get_workflow_runs
 *
 * Plus gap-fill coverage for previously-thin areas:
 *   - create_pr / merge_pr / list_pr_reviews edge cases (auth failure,
 *     rate limit, malformed responses)
 *   - Tool enumeration verifying all 23 tools are present
 *   - filterTools interaction with new tool names
 *   - Toolkit name remains 'github'
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createGitHubConnector,
  createGitHubConnectorToolkit,
} from '../github/github-connector.js'
import { GitHubClient, GitHubApiError } from '../github/github-client.js'

describe('GitHub connector — Wave 19 expansion', () => {
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
    const t = tools.find(x => x.name === name)
    if (!t) throw new Error(`Tool ${name} not found`)
    return t
  }

  // ── github_get_pr_checks ───────────────────────────────

  describe('github_get_pr_checks', () => {
    it('returns formatted check runs on success', async () => {
      mockFetch({
        check_runs: [
          { name: 'lint', status: 'completed', conclusion: 'success' },
          { name: 'test', status: 'in_progress', conclusion: null },
        ],
      })
      const result = await tool('github_get_pr_checks').invoke({
        owner: 'org', repo: 'app', pr_number: 42,
      })

      expect(result).toContain('lint: completed (success)')
      expect(result).toContain('test: in_progress (pending)')
    })

    it('returns "No check runs found" when array is empty', async () => {
      mockFetch({ check_runs: [] })
      const result = await tool('github_get_pr_checks').invoke({
        owner: 'org', repo: 'app', pr_number: 42,
      })
      expect(result).toBe('No check runs found')
    })

    it('uses ${pr_number}/head as ref segment in URL', async () => {
      const m = mockFetch({ check_runs: [] })
      await tool('github_get_pr_checks').invoke({
        owner: 'org', repo: 'app', pr_number: 99,
      })
      const calledUrl = m.mock.calls[0]![0] as string
      // 99/head encodes as 99%2Fhead
      expect(calledUrl).toContain('/repos/org/app/commits/99%2Fhead/check-runs')
    })

    it('returns API error string on 404', async () => {
      mockFetch({ message: 'Not Found' }, false, 404)
      const result = await tool('github_get_pr_checks').invoke({
        owner: 'org', repo: 'app', pr_number: 9999,
      })
      expect(result).toContain('GitHub API error')
      expect(result).toContain('404')
    })

    it('handles network errors via safe()', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
      const result = await tool('github_get_pr_checks').invoke({
        owner: 'org', repo: 'app', pr_number: 1,
      })
      expect(result).toContain('Error')
      expect(result).toContain('fetch failed')
    })

    it('renders both completed and queued check_runs', async () => {
      mockFetch({
        check_runs: [
          { name: 'build', status: 'completed', conclusion: 'failure' },
          { name: 'deploy', status: 'queued', conclusion: null },
        ],
      })
      const result = await tool('github_get_pr_checks').invoke({
        owner: 'o', repo: 'r', pr_number: 1,
      })
      expect(result).toContain('build: completed (failure)')
      expect(result).toContain('deploy: queued (pending)')
    })
  })

  // ── github_add_labels ──────────────────────────────────

  describe('github_add_labels', () => {
    it('returns label names on success', async () => {
      mockFetch([{ name: 'bug' }, { name: 'priority-high' }])
      const result = await tool('github_add_labels').invoke({
        owner: 'org', repo: 'app', issue_number: 5,
        labels: ['bug', 'priority-high'],
      })
      expect(result).toContain('Labels on #5')
      expect(result).toContain('bug')
      expect(result).toContain('priority-high')
    })

    it('sends POST with labels array in body', async () => {
      const m = mockFetch([{ name: 'bug' }])
      await tool('github_add_labels').invoke({
        owner: 'o', repo: 'r', issue_number: 1, labels: ['bug'],
      })
      const init = m.mock.calls[0]![1] as RequestInit
      expect(init.method).toBe('POST')
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      expect(body['labels']).toEqual(['bug'])
    })

    it('targets the /labels endpoint', async () => {
      const m = mockFetch([])
      await tool('github_add_labels').invoke({
        owner: 'o', repo: 'r', issue_number: 7, labels: ['x'],
      })
      const url = m.mock.calls[0]![0] as string
      expect(url).toContain('/repos/o/r/issues/7/labels')
    })

    it('returns success message even if response is empty array', async () => {
      mockFetch([])
      const result = await tool('github_add_labels').invoke({
        owner: 'o', repo: 'r', issue_number: 3, labels: [],
      })
      expect(result).toContain('Labels on #3')
    })

    it('returns API error on 422 validation failure', async () => {
      mockFetch({ message: 'Validation Failed' }, false, 422)
      const result = await tool('github_add_labels').invoke({
        owner: 'o', repo: 'r', issue_number: 1, labels: ['bad/label'],
      })
      expect(result).toContain('GitHub API error')
      expect(result).toContain('422')
    })

    it('returns API error on 403 (insufficient permissions)', async () => {
      mockFetch({ message: 'Forbidden' }, false, 403)
      const result = await tool('github_add_labels').invoke({
        owner: 'o', repo: 'r', issue_number: 1, labels: ['x'],
      })
      expect(result).toContain('403')
    })
  })

  // ── github_remove_label ────────────────────────────────

  describe('github_remove_label', () => {
    it('returns success message on 200', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [],
        text: async () => '[]',
      }))
      const result = await tool('github_remove_label').invoke({
        owner: 'org', repo: 'app', issue_number: 5, label: 'bug',
      })
      expect(result).toContain('Removed label "bug"')
      expect(result).toContain('#5')
    })

    it('returns "Label not found" message on 404', async () => {
      mockFetch({ message: 'Label does not exist' }, false, 404)
      const result = await tool('github_remove_label').invoke({
        owner: 'o', repo: 'r', issue_number: 5, label: 'gone',
      })
      expect(result).toContain('Label "gone" not found on #5')
      expect(result).not.toContain('GitHub API error')
    })

    it('returns API error on 403', async () => {
      mockFetch({ message: 'Forbidden' }, false, 403)
      const result = await tool('github_remove_label').invoke({
        owner: 'o', repo: 'r', issue_number: 1, label: 'x',
      })
      expect(result).toContain('GitHub API error')
      expect(result).toContain('403')
    })

    it('encodes label names with special characters in URL', async () => {
      const m = mockFetch([])
      await tool('github_remove_label').invoke({
        owner: 'o', repo: 'r', issue_number: 1, label: 'priority/high',
      })
      const url = m.mock.calls[0]![0] as string
      expect(url).toContain('/labels/priority%2Fhigh')
    })

    it('uses DELETE method', async () => {
      const m = mockFetch([])
      await tool('github_remove_label').invoke({
        owner: 'o', repo: 'r', issue_number: 1, label: 'bug',
      })
      const init = m.mock.calls[0]![1] as RequestInit
      expect(init.method).toBe('DELETE')
    })

    it('returns generic Error message on network failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('socket hangup')))
      const result = await tool('github_remove_label').invoke({
        owner: 'o', repo: 'r', issue_number: 1, label: 'bug',
      })
      expect(result).toContain('Error')
      expect(result).toContain('socket hangup')
    })

    it('returns string error for non-Error thrown values', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue('boom'))
      const result = await tool('github_remove_label').invoke({
        owner: 'o', repo: 'r', issue_number: 1, label: 'bug',
      })
      expect(result).toContain('Error')
      expect(result).toContain('boom')
    })
  })

  // ── github_create_review_comment ───────────────────────

  describe('github_create_review_comment', () => {
    it('returns id and body snippet on success', async () => {
      mockFetch({ id: 100, body: 'Consider extracting this to a helper function.' })
      const result = await tool('github_create_review_comment').invoke({
        owner: 'o', repo: 'r', pr_number: 5,
        body: 'Consider extracting this to a helper function.',
        path: 'src/index.ts', line: 42,
      })
      expect(result).toContain('id=100')
      expect(result).toContain('Consider extracting')
    })

    it('truncates very long body in response', async () => {
      const long = 'A'.repeat(500)
      mockFetch({ id: 1, body: long })
      const result = await tool('github_create_review_comment').invoke({
        owner: 'o', repo: 'r', pr_number: 1, body: long, path: 'a.ts', line: 1,
      })
      // 100-char slice
      expect(result.length).toBeLessThan(200)
      expect(result).toContain('id=1')
    })

    it('targets /pulls/{n}/comments endpoint', async () => {
      const m = mockFetch({ id: 1, body: 'x' })
      await tool('github_create_review_comment').invoke({
        owner: 'o', repo: 'r', pr_number: 7, body: 'x', path: 'a.ts', line: 1,
      })
      const url = m.mock.calls[0]![0] as string
      expect(url).toContain('/repos/o/r/pulls/7/comments')
    })

    it('sends body, path, and line in POST body', async () => {
      const m = mockFetch({ id: 1, body: 'x' })
      await tool('github_create_review_comment').invoke({
        owner: 'o', repo: 'r', pr_number: 1,
        body: 'fix me', path: 'src/x.ts', line: 99,
      })
      const init = m.mock.calls[0]![1] as RequestInit
      expect(init.method).toBe('POST')
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      expect(body['body']).toBe('fix me')
      expect(body['path']).toBe('src/x.ts')
      expect(body['line']).toBe(99)
    })

    it('returns API error on 422 validation failure', async () => {
      mockFetch({ message: 'Pull Request Review Comments Diff Hunk Invalid' }, false, 422)
      const result = await tool('github_create_review_comment').invoke({
        owner: 'o', repo: 'r', pr_number: 1, body: 'x', path: 'missing.ts', line: 9999,
      })
      expect(result).toContain('GitHub API error')
      expect(result).toContain('422')
    })

    it('returns API error on 401 (auth failure)', async () => {
      mockFetch({ message: 'Bad credentials' }, false, 401)
      const result = await tool('github_create_review_comment').invoke({
        owner: 'o', repo: 'r', pr_number: 1, body: 'x', path: 'a.ts', line: 1,
      })
      expect(result).toContain('GitHub API error')
      expect(result).toContain('401')
    })
  })

  // ── github_get_workflow_runs ───────────────────────────

  describe('github_get_workflow_runs', () => {
    it('returns formatted workflow runs without workflow_id', async () => {
      mockFetch({
        workflow_runs: [
          { id: 1, status: 'completed', conclusion: 'success', name: 'CI' },
          { id: 2, status: 'in_progress', conclusion: null, name: 'Deploy' },
        ],
      })
      const result = await tool('github_get_workflow_runs').invoke({
        owner: 'o', repo: 'r',
      })
      expect(result).toContain('[1] CI: completed (success)')
      expect(result).toContain('[2] Deploy: in_progress (pending)')
    })

    it('hits /actions/runs when workflow_id is omitted', async () => {
      const m = mockFetch({ workflow_runs: [] })
      await tool('github_get_workflow_runs').invoke({ owner: 'o', repo: 'r' })
      const url = m.mock.calls[0]![0] as string
      expect(url).toContain('/repos/o/r/actions/runs')
    })

    it('hits /actions/workflows/{id}/runs when workflow_id is provided', async () => {
      const m = mockFetch({ workflow_runs: [] })
      await tool('github_get_workflow_runs').invoke({
        owner: 'o', repo: 'r', workflow_id: 'ci.yml',
      })
      const url = m.mock.calls[0]![0] as string
      expect(url).toContain('/repos/o/r/actions/workflows/ci.yml/runs')
    })

    it('encodes workflow_id with special characters', async () => {
      const m = mockFetch({ workflow_runs: [] })
      await tool('github_get_workflow_runs').invoke({
        owner: 'o', repo: 'r', workflow_id: 'release main.yml',
      })
      const url = m.mock.calls[0]![0] as string
      expect(url).toContain('release%20main.yml')
    })

    it('returns "No workflow runs found" for empty list', async () => {
      mockFetch({ workflow_runs: [] })
      const result = await tool('github_get_workflow_runs').invoke({
        owner: 'o', repo: 'r',
      })
      expect(result).toBe('No workflow runs found')
    })

    it('returns API error on 404', async () => {
      mockFetch({ message: 'Not Found' }, false, 404)
      const result = await tool('github_get_workflow_runs').invoke({
        owner: 'o', repo: 'r',
      })
      expect(result).toContain('GitHub API error')
      expect(result).toContain('404')
    })

    it('handles network failures via safe()', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')))
      const result = await tool('github_get_workflow_runs').invoke({
        owner: 'o', repo: 'r',
      })
      expect(result).toContain('Error')
      expect(result).toContain('ECONNRESET')
    })
  })

  // ── Gap-fill: existing tools edge cases ────────────────

  describe('github_create_pr — edge cases', () => {
    it('returns API error 401 on bad token', async () => {
      mockFetch({ message: 'Bad credentials' }, false, 401)
      const result = await tool('github_create_pr').invoke({
        owner: 'o', repo: 'r', title: 't', head: 'h', base: 'main',
      })
      expect(result).toContain('GitHub API error')
      expect(result).toContain('401')
    })

    it('returns API error 429 on rate limit', async () => {
      mockFetch({ message: 'rate limit exceeded' }, false, 429)
      const result = await tool('github_create_pr').invoke({
        owner: 'o', repo: 'r', title: 't', head: 'h', base: 'main',
      })
      expect(result).toContain('GitHub API error')
      expect(result).toContain('429')
    })

    it('defaults body to empty string when omitted', async () => {
      const m = mockFetch({ number: 1, html_url: 'https://x' })
      await tool('github_create_pr').invoke({
        owner: 'o', repo: 'r', title: 't', head: 'h', base: 'main',
      })
      const init = m.mock.calls[0]![1] as RequestInit
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      expect(body['body']).toBe('')
    })
  })

  describe('github_merge_pr — edge cases', () => {
    it('returns API error 405 when not mergeable', async () => {
      mockFetch({ message: 'Pull request is not mergeable' }, false, 405)
      const result = await tool('github_merge_pr').invoke({
        owner: 'o', repo: 'r', pr_number: 1,
      })
      expect(result).toContain('GitHub API error')
      expect(result).toContain('405')
    })

    it('returns API error 409 on conflict', async () => {
      mockFetch({ message: 'SHA mismatch' }, false, 409)
      const result = await tool('github_merge_pr').invoke({
        owner: 'o', repo: 'r', pr_number: 1,
      })
      expect(result).toContain('409')
    })
  })

  describe('github_list_pr_reviews — edge cases', () => {
    it('returns "[]" formatted JSON when empty', async () => {
      mockFetch([])
      const result = await tool('github_list_pr_reviews').invoke({
        owner: 'o', repo: 'r', pr_number: 1,
      })
      expect(JSON.parse(result as string)).toEqual([])
    })

    it('returns API error on 429 rate limit', async () => {
      mockFetch({ message: 'API rate limit exceeded' }, false, 429)
      const result = await tool('github_list_pr_reviews').invoke({
        owner: 'o', repo: 'r', pr_number: 1,
      })
      expect(result).toContain('GitHub API error')
      expect(result).toContain('429')
    })
  })

  // ── Tool enumeration ───────────────────────────────────

  describe('tool list — full enumeration', () => {
    it('contains all 22 tools (17 existing + 5 new)', () => {
      const tools = createGitHubConnector({ token: 'tok' })
      expect(tools).toHaveLength(22)
    })

    it('includes all 5 new tool names', () => {
      const tools = createGitHubConnector({ token: 'tok' })
      const names = tools.map(t => t.name)
      expect(names).toContain('github_get_pr_checks')
      expect(names).toContain('github_add_labels')
      expect(names).toContain('github_remove_label')
      expect(names).toContain('github_create_review_comment')
      expect(names).toContain('github_get_workflow_runs')
    })

    it('preserves all 17 pre-existing tool names', () => {
      const tools = createGitHubConnector({ token: 'tok' })
      const names = tools.map(t => t.name)
      const existing = [
        'github_get_file',
        'github_list_issues',
        'github_get_issue',
        'github_create_issue',
        'github_update_issue',
        'github_add_comment',
        'github_list_prs',
        'github_get_pr',
        'github_create_pr',
        'github_merge_pr',
        'github_list_pr_reviews',
        'github_create_pr_review',
        'github_get_repo',
        'github_list_branches',
        'github_get_commit',
        'github_compare_commits',
        'github_search_code',
      ]
      for (const n of existing) {
        expect(names).toContain(n)
      }
    })
  })

  // ── filterTools interaction ────────────────────────────

  describe('filterTools with new tools', () => {
    it('returns only the 5 new tools when filtered', () => {
      const tools = createGitHubConnector({
        token: 'tok',
        enabledTools: [
          'github_get_pr_checks',
          'github_add_labels',
          'github_remove_label',
          'github_create_review_comment',
          'github_get_workflow_runs',
        ],
      })
      expect(tools).toHaveLength(5)
    })

    it('filters down to a single new tool', () => {
      const tools = createGitHubConnector({
        token: 'tok',
        enabledTools: ['github_add_labels'],
      })
      expect(tools).toHaveLength(1)
      expect(tools[0]!.name).toBe('github_add_labels')
    })

    it('returns empty when filter contains only unknown new-tool typos', () => {
      const tools = createGitHubConnector({
        token: 'tok',
        enabledTools: ['github_get_pr_check', 'github_addlabel'],
      })
      expect(tools).toHaveLength(0)
    })

    it('mixes new and existing tools in the filter', () => {
      const tools = createGitHubConnector({
        token: 'tok',
        enabledTools: ['github_get_repo', 'github_add_labels'],
      })
      expect(tools).toHaveLength(2)
      expect(tools.map(t => t.name).sort()).toEqual(['github_add_labels', 'github_get_repo'])
    })
  })

  // ── Toolkit invariants ─────────────────────────────────

  describe('createGitHubConnectorToolkit invariants', () => {
    it('still names the toolkit "github" after expansion', () => {
      const tk = createGitHubConnectorToolkit({ token: 'tok' })
      expect(tk.name).toBe('github')
    })

    it('exposes 22 tools from the toolkit', () => {
      const tk = createGitHubConnectorToolkit({ token: 'tok' })
      expect(tk.tools.length).toBe(22)
    })

    it('passes enabledTools through correctly with new tools', () => {
      const tk = createGitHubConnectorToolkit({
        token: 'tok',
        enabledTools: ['github_get_pr_checks'],
      })
      expect(tk.tools).toHaveLength(1)
      expect(tk.tools[0]!.name).toBe('github_get_pr_checks')
      expect(tk.enabledTools).toEqual(['github_get_pr_checks'])
    })
  })
})

// ── GitHubClient new-method coverage ──────────────────────

describe('GitHubClient — new W19 methods', () => {
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

  describe('getPRChecks', () => {
    it('calls correct check-runs endpoint', async () => {
      const m = mockFetch({ check_runs: [] })
      const client = new GitHubClient({ token: 'tok' })
      await client.getPRChecks('o', 'r', 'abc123')
      const url = m.mock.calls[0]![0] as string
      expect(url).toContain('/repos/o/r/commits/abc123/check-runs')
    })

    it('throws GitHubApiError on failure', async () => {
      mockFetch({ message: 'Not Found' }, false, 404)
      const client = new GitHubClient({ token: 'tok' })
      await expect(client.getPRChecks('o', 'r', 'sha')).rejects.toThrow(GitHubApiError)
    })
  })

  describe('addLabels', () => {
    it('sends POST with labels in body', async () => {
      const m = mockFetch([{ name: 'bug' }])
      const client = new GitHubClient({ token: 'tok' })
      await client.addLabels('o', 'r', 1, ['bug'])
      const init = m.mock.calls[0]![1] as RequestInit
      expect(init.method).toBe('POST')
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      expect(body['labels']).toEqual(['bug'])
    })

    it('returns array of label names', async () => {
      mockFetch([{ name: 'bug' }, { name: 'docs' }])
      const client = new GitHubClient({ token: 'tok' })
      const labels = await client.addLabels('o', 'r', 1, ['bug', 'docs'])
      expect(labels).toEqual([{ name: 'bug' }, { name: 'docs' }])
    })
  })

  describe('removeLabel', () => {
    it('sends DELETE to encoded label endpoint', async () => {
      const m = mockFetch([])
      const client = new GitHubClient({ token: 'tok' })
      await client.removeLabel('o', 'r', 1, 'priority high')
      const init = m.mock.calls[0]![1] as RequestInit
      expect(init.method).toBe('DELETE')
      const url = m.mock.calls[0]![0] as string
      expect(url).toContain('/labels/priority%20high')
    })

    it('throws GitHubApiError on 404', async () => {
      mockFetch({ message: 'Label does not exist' }, false, 404)
      const client = new GitHubClient({ token: 'tok' })
      await expect(client.removeLabel('o', 'r', 1, 'gone')).rejects.toThrow(GitHubApiError)
    })
  })

  describe('createReviewComment', () => {
    it('sends POST with body, path, line', async () => {
      const m = mockFetch({ id: 1, body: 'x' })
      const client = new GitHubClient({ token: 'tok' })
      await client.createReviewComment('o', 'r', 5, 'comment', 'file.ts', 10)
      const init = m.mock.calls[0]![1] as RequestInit
      expect(init.method).toBe('POST')
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      expect(body['body']).toBe('comment')
      expect(body['path']).toBe('file.ts')
      expect(body['line']).toBe(10)
      expect(body['commit_id']).toBeUndefined()
    })

    it('includes commit_id when provided', async () => {
      const m = mockFetch({ id: 1, body: 'x' })
      const client = new GitHubClient({ token: 'tok' })
      await client.createReviewComment('o', 'r', 5, 'x', 'a.ts', 1, 'sha-abc')
      const init = m.mock.calls[0]![1] as RequestInit
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      expect(body['commit_id']).toBe('sha-abc')
    })
  })

  describe('getWorkflowRuns', () => {
    it('hits /actions/runs without workflow_id', async () => {
      const m = mockFetch({ workflow_runs: [] })
      const client = new GitHubClient({ token: 'tok' })
      await client.getWorkflowRuns('o', 'r')
      const url = m.mock.calls[0]![0] as string
      expect(url).toContain('/repos/o/r/actions/runs')
      expect(url).not.toContain('/workflows/')
    })

    it('hits per-workflow endpoint when workflow_id is a string', async () => {
      const m = mockFetch({ workflow_runs: [] })
      const client = new GitHubClient({ token: 'tok' })
      await client.getWorkflowRuns('o', 'r', 'ci.yml')
      const url = m.mock.calls[0]![0] as string
      expect(url).toContain('/actions/workflows/ci.yml/runs')
    })

    it('hits per-workflow endpoint when workflow_id is a number', async () => {
      const m = mockFetch({ workflow_runs: [] })
      const client = new GitHubClient({ token: 'tok' })
      await client.getWorkflowRuns('o', 'r', 12345)
      const url = m.mock.calls[0]![0] as string
      expect(url).toContain('/actions/workflows/12345/runs')
    })

    it('throws GitHubApiError on 404', async () => {
      mockFetch({ message: 'Not Found' }, false, 404)
      const client = new GitHubClient({ token: 'tok' })
      await expect(client.getWorkflowRuns('o', 'r')).rejects.toThrow(GitHubApiError)
    })
  })
})
