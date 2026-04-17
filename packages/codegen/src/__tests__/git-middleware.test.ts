import { describe, it, expect, vi, beforeEach } from 'vitest'
import { formatGitContext } from '../git/git-middleware.js'
import type { GitContext } from '../git/git-middleware.js'

// We cannot easily mock gatherGitContext without controlling GitExecutor,
// so we focus on the pure function formatGitContext.

describe('formatGitContext', () => {
  it('formats a clean git context', () => {
    const ctx: GitContext = {
      branch: 'main',
      status: '(clean working tree)',
      recentCommits: '  abc1234 initial commit',
      isDirty: false,
    }
    const result = formatGitContext(ctx)
    expect(result).toContain('## Git Context')
    expect(result).toContain('**Branch:** main')
    expect(result).toContain('(clean working tree)')
    expect(result).toContain('abc1234 initial commit')
  })

  it('formats a dirty git context', () => {
    const ctx: GitContext = {
      branch: 'feature/x',
      status: '  M src/index.ts\n  A src/new.ts',
      recentCommits: '  abc1234 add feature\n  def5678 fix bug',
      isDirty: true,
    }
    const result = formatGitContext(ctx)
    expect(result).toContain('**Branch:** feature/x')
    expect(result).toContain('M src/index.ts')
    expect(result).toContain('A src/new.ts')
    expect(result).toContain('add feature')
  })

  it('includes code blocks', () => {
    const ctx: GitContext = {
      branch: 'dev',
      status: 'clean',
      recentCommits: '(no commits)',
      isDirty: false,
    }
    const result = formatGitContext(ctx)
    // Should have markdown code blocks
    expect(result).toContain('```')
  })
})
